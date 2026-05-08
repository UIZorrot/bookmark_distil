"""In-process sliding-window counters per user."""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models import User, utcnow

MONO = time.monotonic


class UsageBurstTracker:
    """Tracks monotonic timestamps per user without Redis (MVP single instance)."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = asyncio.Lock()
        self._hits: dict[str, deque[float]] = defaultdict(lambda: deque())

    def _prune(self, dq: deque[float], horizon_s: float) -> None:
        now = MONO()
        cutoff = now - horizon_s
        while dq and dq[0] < cutoff:
            dq.popleft()

    async def bump_and_len(self, user_id_str: str, window_s: float) -> int:
        async with self._lock:
            dq = self._hits[user_id_str]
            dq.append(MONO())
            self._prune(dq, window_s)
            return len(dq)


async def ensure_daily_ai_counter(session: AsyncSession, user: User) -> None:
    today = utcnow().date()
    if user.ai_usage_day != today:
        user.ai_usage_day = today
        user.ai_daily_request_count = 0


async def bump_daily_ai_request(session: AsyncSession, user: User) -> None:
    """Count one gated inference attempt."""
    await ensure_daily_ai_counter(session, user)
    user.ai_daily_request_count += 1
    session.add(user)


def subscription_has_managed_ai(user: User) -> bool:
    now = utcnow()
    if user.stripe_subscription_status not in ("active", "trialing"):
        return False
    end = user.subscription_current_period_end
    if end is not None and end < now:
        return False
    return True


async def apply_abuse_degrade_if_needed(
    *,
    settings: Settings,
    session: AsyncSession,
    user: User,
    short_hits_after_bump: int,
) -> bool:
    """
    Set usage_degraded_until if daily or burst heuristics trigger.
    Returns whether user sits in degraded window after this flush.
    """
    from datetime import timedelta

    now = utcnow()
    if short_hits_after_bump >= settings.ai_short_window_req_threshold:
        user.usage_degraded_until = now + timedelta(seconds=settings.ai_degraded_cooldown_seconds)
    elif user.ai_daily_request_count >= settings.ai_soft_daily_request_cap:
        user.usage_degraded_until = now + timedelta(seconds=settings.ai_degraded_cooldown_seconds)

    session.add(user)
    await session.commit()
    await session.refresh(user)

    return bool(user.usage_degraded_until and user.usage_degraded_until > utcnow())


def is_in_degraded_cooldown(user: User) -> bool:
    u = user.usage_degraded_until
    return bool(u is not None and u > utcnow())
