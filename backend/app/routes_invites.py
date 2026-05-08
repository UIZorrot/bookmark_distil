from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from app.deps import CurrentUserDep, DbSessionDep
from app.models import InviteCode, utcnow
from app.schemas import InviteRedeemIn, InviteRedeemOut
from app.security import digest_invite_code

router = APIRouter(prefix="/member/invites", tags=["member-invites"])


@router.post("/redeem", response_model=InviteRedeemOut)
async def redeem_invite_code(
    payload: InviteRedeemIn,
    request: Request,
    user: CurrentUserDep,
    db: DbSessionDep,
) -> InviteRedeemOut:
    settings = request.app.state.settings
    code_digest = digest_invite_code(payload.code, settings.member_jwt_secret)
    result = await db.execute(select(InviteCode).where(InviteCode.code_digest == code_digest))
    invite = result.scalar_one_or_none()

    if invite is None or invite.redeemed_at is not None:
        raise HTTPException(status_code=400, detail="invalid_or_redeemed_invite_code")

    now = utcnow()
    grant_start = user.subscription_current_period_end if user.subscription_current_period_end and user.subscription_current_period_end > now else now
    user.stripe_subscription_status = "active"
    user.subscription_current_period_end = grant_start + timedelta(days=settings.invite_code_grant_days)
    invite.redeemed_by_user_id = user.id
    invite.redeemed_at = now

    await db.commit()
    await db.refresh(user)

    return InviteRedeemOut(
        detail="invite_code_redeemed",
        subscription_status=user.stripe_subscription_status,
        subscription_current_period_end=user.subscription_current_period_end.isoformat(),
    )
