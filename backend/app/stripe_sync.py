"""Apply Stripe payloads to persisted users."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import stripe
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User


def _period_end(sub: stripe.Subscription) -> datetime | None:
    ts = getattr(sub, "current_period_end", None)
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz=timezone.utc)


async def hydrate_user(session: AsyncSession, user_id: UUID) -> User | None:
    res = await session.execute(select(User).where(User.id == user_id))
    return res.scalar_one_or_none()


async def apply_subscription_to_user(session: AsyncSession, user: User, sub: stripe.Subscription) -> None:
    user.stripe_subscription_id = str(sub.id)

    status = getattr(sub, "status", None)
    if status:
        user.stripe_subscription_status = str(status)

    cust_id = getattr(sub, "customer", None)
    if cust_id:
        user.stripe_customer_id = str(cust_id)

    pend = _period_end(sub)
    if pend:
        user.subscription_current_period_end = pend

    session.add(user)
    await session.commit()


async def finalize_checkout_session(session: AsyncSession, checkout_payload: dict[str, Any]) -> None:
    ref = checkout_payload.get("client_reference_id")
    if not ref:
        raise LookupError("missing_client_reference_id")
    uid = UUID(str(ref))

    user = await hydrate_user(session, uid)
    if user is None:
        raise LookupError("checkout_user_unknown")

    cust = checkout_payload.get("customer")
    if cust:
        user.stripe_customer_id = str(cust)

    session.add(user)

    sub_id = checkout_payload.get("subscription")
    if sub_id:
        subscription = await asyncio.to_thread(lambda: stripe.Subscription.retrieve(str(sub_id)))
        await apply_subscription_to_user(session, user, subscription)
        return

    await session.commit()


async def apply_subscription_customer_lookup(session: AsyncSession, cust_id: str, sub: stripe.Subscription) -> None:
    res = await session.execute(select(User).where(User.stripe_customer_id == str(cust_id)))
    user = res.scalar_one_or_none()
    if user is None:
        raise LookupError("stripe_customer_unknown")
    await apply_subscription_to_user(session, user, sub)


def _bookmark_uid_from_subscription_metadata(sub: stripe.Subscription) -> str | None:
    md = getattr(sub, "metadata", None)
    if md is None:
        return None
    try:
        blob = dict(md)
    except Exception:
        return None
    v = blob.get("bookmark_distil_user_id")
    return str(v) if v else None


async def ingest_subscription_updated_event(session: AsyncSession, sub: stripe.Subscription) -> None:
    cust_id = getattr(sub, "customer", None)
    if cust_id:
        try:
            await apply_subscription_customer_lookup(session, str(cust_id), sub)
            return
        except LookupError:
            pass

    uid_str = _bookmark_uid_from_subscription_metadata(sub)
    if not uid_str:
        raise LookupError("subscription_without_resolvable_user")

    user = await hydrate_user(session, UUID(uid_str))
    if user is None:
        raise LookupError("subscription_user_unknown")

    await apply_subscription_to_user(session, user, sub)
