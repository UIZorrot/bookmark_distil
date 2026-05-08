"""Hash email verification codes and mint member JWT for the Chrome extension."""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta
from uuid import UUID

from jose import JWTError, jwt

from app.config import Settings


def mint_email_verification_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def digest_email_verification_code(code: str, pepper: str) -> str:
    return hashlib.sha256(f"{pepper}:{code.strip()}".encode("utf-8")).hexdigest()


def digest_invite_code(code: str, pepper: str) -> str:
    normalized = code.strip().upper().replace("-", "")
    return hashlib.sha256(f"{pepper}:invite:{normalized}".encode("utf-8")).hexdigest()


def mint_member_access_token(settings: Settings, *, user_id: UUID, email: str) -> str:
    expiry = timedelta(minutes=settings.member_access_token_expire_minutes)
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "email": email,
        "iat": int(now.timestamp()),
        "exp": int((now + expiry).timestamp()),
        "typ": "bookmark_distil_member",
    }
    return jwt.encode(payload, settings.member_jwt_secret, algorithm=settings.member_jwt_alg)


def decode_member_token(settings: Settings, token: str) -> dict:
    return jwt.decode(token, settings.member_jwt_secret, algorithms=[settings.member_jwt_alg])


def safe_decode_member_subject(settings: Settings, token: str) -> UUID:
    try:
        data = decode_member_token(settings, token)
        return UUID(str(data["sub"]))
    except (JWTError, KeyError, ValueError):
        raise ValueError("INVALID_TOKEN")
