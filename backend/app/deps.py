from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User
from app.security import safe_decode_member_subject


async def db_session_dep(request: Request) -> AsyncSession:
    factory = getattr(request.app.state, "session_factory", None)
    if factory is None:
        raise RuntimeError("session_factory not attached")
    async with factory() as session:
        yield session


DbSessionDep = Annotated[AsyncSession, Depends(db_session_dep)]


async def current_user_dep(
    request: Request,
    db: DbSessionDep,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_bearer")
    raw = authorization.removeprefix("Bearer ").strip()

    settings = request.app.state.settings
    try:
        subject = safe_decode_member_subject(settings, raw)
    except ValueError:
        raise HTTPException(status_code=401, detail="bad_token")

    res = await db.execute(select(User).where(User.id == subject))
    user = res.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail="user_not_found")

    return user


CurrentUserDep = Annotated[User, Depends(current_user_dep)]


async def bearer_subject_uuid_dep(request: Request, authorization: Annotated[str | None, Header()] = None) -> UUID:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_bearer")
    raw = authorization.removeprefix("Bearer ").strip()
    settings = request.app.state.settings
    try:
        return safe_decode_member_subject(settings, raw)
    except ValueError:
        raise HTTPException(status_code=401, detail="bad_token")
