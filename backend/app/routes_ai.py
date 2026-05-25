"""Hosted member chat relay with DeepSeek/OpenRouter degrade + RPM/daily safeguards."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from app.deps import CurrentUserDep, DbSessionDep
from app.models import AISpendLog, User
from app.schemas import ChatRelayIn
from app.service_ai import relay_chat_completion
from app.service_usage_tracker import (
    apply_abuse_degrade_if_needed,
    bump_daily_ai_request,
    is_in_degraded_cooldown,
    subscription_has_managed_ai,
)

router = APIRouter(prefix="/member", tags=["member-ai"])

_LOG = logging.getLogger("bookmark_distil.member_ai")


def _has_relay_choices(response_json: dict[str, Any]) -> bool:
    choices = response_json.get("choices")
    return isinstance(choices, list) and len(choices) > 0


@router.get("/me")
async def member_profile(user: CurrentUserDep) -> dict[str, Any]:
    return {
        "email": user.email,
        "pricing_region": user.pricing_region,
        "stripe_subscription_status": user.stripe_subscription_status,
        "subscription_current_period_end": user.subscription_current_period_end.isoformat()
        if user.subscription_current_period_end
        else None,
        "hosted_ai_enabled": subscription_has_managed_ai(user),
    }


@router.post("/ai/test")
async def hosted_ai_test(
    request: Request,
    user: CurrentUserDep,
) -> dict[str, Any]:
    settings = request.app.state.settings

    if not subscription_has_managed_ai(user):
        raise HTTPException(status_code=402, detail="subscription_required")

    try:
        response_json, meta = await relay_chat_completion(
            settings=settings,
            force_openrouter_free=bool(not settings.deepseek_api_key.strip()),
            payload={
                "messages": [{"role": "user", "content": "Reply with a short plain text: OK"}],
                "temperature": 0,
                "max_tokens": 16,
            },
        )
    except RuntimeError as exc:
        _LOG.warning("upstream_llm_test_failure user=%s err=%s", user.id, exc)
        raise HTTPException(status_code=503, detail="upstream_llm_unavailable") from exc

    if not _has_relay_choices(response_json):
        _LOG.warning("upstream_llm_test_invalid_response user=%s meta=%s", user.id, meta)
        raise HTTPException(status_code=503, detail="upstream_llm_invalid_response")

    return {
        "ok": True,
        "provider": str(meta.get("provider", "")),
        "model": str(meta.get("model", "")),
    }


async def _enforce_rpm(request: Request, user_key: str, cap: int) -> None:
    rpm_tracker = getattr(request.app.state, "rpm_tracker", None)
    if rpm_tracker is None:
        raise RuntimeError("rpm_tracker_missing")
    rpm_hits = await rpm_tracker.bump_and_len(user_key, 65.0)
    if rpm_hits > cap:
        raise HTTPException(status_code=429, detail="rpm_guard")


@router.post("/ai/chat/completions")
async def hosted_chat_completion(
    body: ChatRelayIn,
    request: Request,
    db: DbSessionDep,
    user: CurrentUserDep,
) -> dict[str, Any]:
    settings = request.app.state.settings

    if not subscription_has_managed_ai(user):
        raise HTTPException(status_code=402, detail="subscription_required")

    short_tracker = getattr(request.app.state, "short_tracker", None)
    if short_tracker is None:
        raise RuntimeError("burst_tracker_missing")

    await bump_daily_ai_request(db, user)

    user_key = str(user.id)

    burst_hits = await short_tracker.bump_and_len(user_key, float(settings.ai_short_window_seconds))
    await apply_abuse_degrade_if_needed(
        settings=settings,
        session=db,
        user=user,
        short_hits_after_bump=burst_hits,
    )

    res = await db.execute(select(User).where(User.id == user.id))
    fresh_user = res.scalar_one()
    degraded = is_in_degraded_cooldown(fresh_user)

    rpm_cap = settings.ai_requests_per_minute_degraded if degraded else settings.ai_requests_per_minute_normal
    await _enforce_rpm(request, user_key, rpm_cap)

    payload_body: dict[str, Any] = body.model_dump(mode="python", exclude_none=True)
    if degraded or not settings.deepseek_api_key.strip():
        payload_body.pop("model", None)

    try:
        response_json, meta = await relay_chat_completion(
            settings=settings,
            force_openrouter_free=bool(degraded or not settings.deepseek_api_key.strip()),
            payload=payload_body,
        )
    except RuntimeError as exc:
        _LOG.warning("upstream_llm_failure user=%s err=%s", user.id, exc)
        raise HTTPException(status_code=503, detail="upstream_llm_unavailable")

    fb = degraded or bool(meta.get("upstream_deepseek_http"))

    usage = response_json.get("usage") if isinstance(response_json.get("usage"), dict) else {}
    pt = usage.get("prompt_tokens")
    ct = usage.get("completion_tokens")
    latency = meta.get("latency_ms")

    row = AISpendLog(
        user_id=fresh_user.id,
        provider=str(meta.get("provider", "unknown")),
        model=str(meta.get("model", "")),
        used_degraded_fallback=bool(fb),
        prompt_tokens=int(pt) if isinstance(pt, int) else None,
        completion_tokens=int(ct) if isinstance(ct, int) else None,
        latency_ms=int(latency) if isinstance(latency, int) else None,
    )
    db.add(row)
    await db.commit()

    return response_json
