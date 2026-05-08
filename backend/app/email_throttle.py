"""Simple in-process hourly throttle for `/auth/email/send` (IP × email tuple)."""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque

from fastapi import HTTPException


class IpEmailThrottle:
    """MVP throttle; horizontally scale-out later with Redis TTL counters."""

    def __init__(self, *, hourly_cap: int, window_seconds: float = 3600.5) -> None:
        self._hourly_cap = hourly_cap
        self._window = window_seconds
        self._lock = asyncio.Lock()
        self._hits: dict[str, deque[float]] = defaultdict(lambda: deque())

    async def hit_or_raise(self, *, ip: str, email: str) -> None:
        email_l = email.lower().strip()
        key = f"{ip}|{email_l}"
        now = time.monotonic()
        cutoff = now - self._window

        async with self._lock:
            dq = self._hits[key]
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= self._hourly_cap:
                raise HTTPException(status_code=429, detail="too_many_email_code_requests")
            dq.append(now)
