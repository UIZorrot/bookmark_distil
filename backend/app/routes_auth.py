from __future__ import annotations

import logging
from datetime import timedelta

import httpx
from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from app.deps import DbSessionDep
from app.models import EmailVerificationCode, User, utcnow
from app.schemas import EmailCodeSendIn, EmailCodeVerifyIn, TokenOut
from app.security import digest_email_verification_code, mint_email_verification_code, mint_member_access_token

router = APIRouter(prefix="/auth", tags=["auth"])
_LOG = logging.getLogger("bookmark_distil.auth")


async def send_resend_email(*, api_key: str, from_: str, to: str, subject: str, html: str) -> None:
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
        r = await client.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            json={"from": from_, "to": [to], "subject": subject, "html": html},
        )
        if not r.is_success:
            detail = r.text[:2000]
            raise HTTPException(status_code=502, detail=f"resend_http_{r.status_code}: {detail}")


def client_ip_fallback(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


@router.post("/email/send")
async def email_code_send(payload: EmailCodeSendIn, request: Request, db: DbSessionDep) -> dict[str, str]:
    settings = request.app.state.settings
    ip = client_ip_fallback(request)
    rl = getattr(request.app.state, "email_code_ip_email_throttle", None)
    if rl is not None:
        await rl.hit_or_raise(ip=ip, email=str(payload.email).lower())

    if not settings.resend_api_key.strip() or not settings.email_from.strip():
        raise HTTPException(status_code=503, detail="email_not_configured")

    code = mint_email_verification_code()
    digest = digest_email_verification_code(code, settings.email_code_pepper)
    exp = utcnow() + timedelta(minutes=settings.email_code_ttl_minutes)
    email = str(payload.email).lower()

    row = EmailVerificationCode(code_digest=digest, email=email, expires_at=exp)
    db.add(row)
    await db.commit()

    _LOG.info("sending_email_code email=%s ttl_minutes=%s", email, settings.email_code_ttl_minutes)
    await send_resend_email(
        api_key=settings.resend_api_key,
        from_=settings.email_from,
        to=email,
        subject="Bookmark Distil 登录验证码",
        html=(
            "<p>你的 Bookmark Distil 登录验证码是：</p>"
            f'<p style="font-size:28px;font-weight:700;letter-spacing:6px">{code}</p>'
            f"<p>验证码 {settings.email_code_ttl_minutes} 分钟内有效。若不是你本人操作，可以忽略这封邮件。</p>"
        ),
    )

    return {"detail": "email_code_sent", "auth_mode": "email_code"}

@router.post("/email/verify", response_model=TokenOut)
async def email_code_verify(payload: EmailCodeVerifyIn, request: Request, db: DbSessionDep) -> TokenOut:
    settings = request.app.state.settings

    digest = digest_email_verification_code(payload.code, settings.email_code_pepper)

    q = (
        await db.execute(
            select(EmailVerificationCode).where(
                EmailVerificationCode.email == str(payload.email).lower(),
                EmailVerificationCode.code_digest == digest,
                EmailVerificationCode.revoked.is_(False),
            )
        )
    )
    verification = q.scalar_one_or_none()
    if verification is None or verification.consumed_at is not None or verification.expires_at < utcnow():
        raise HTTPException(status_code=400, detail="invalid_or_expired_code")

    email = verification.email.lower()
    qr = await db.execute(select(User).where(User.email == email))
    user = qr.scalar_one_or_none()

    if user is None:
        user = User(email=email, pricing_region="us")
        db.add(user)

    verification.consumed_at = utcnow()
    verification.revoked = True

    await db.commit()
    await db.refresh(user)

    access_token = mint_member_access_token(settings, user_id=user.id, email=user.email)

    return TokenOut(access_token=access_token, user_id=user.id, email=user.email)
