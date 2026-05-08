"""OpenAI-compatible chat relay: DeepSeek primary, OpenRouter free when degraded/fallback."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from app.config import Settings

USER_AGENT_DISTIL = "BookmarkDistilHostedAI/1.0"


async def relay_chat_completion(
    *,
    settings: Settings,
    force_openrouter_free: bool,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    POST /chat/completions shape. Returns (response_json_dict, relay_meta).

    relay_meta carries provider/model/latency for logging rows.
    """
    if force_openrouter_free or not settings.deepseek_api_key.strip():
        return await _relay_openrouter_chain(settings=settings, payload=payload)

    outgoing = dict(payload)
    outgoing["model"] = outgoing.get("model") or settings.deepseek_model

    status, data, latency_ms = await _post_openai_compatible(
        url=settings.deepseek_api_url,
        headers={
            "Authorization": f"Bearer {settings.deepseek_api_key.strip()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT_DISTIL,
        },
        payload=outgoing,
    )

    transient = status in (401, 402, 408, 409, 429) or status >= 500
    ok_payload = isinstance(data, dict) and ("choices" in data or "usage" in data or "error" in data)

    if status == 200 and ok_payload and "choices" in data:
        meta = {"provider": "deepseek", "model": outgoing["model"], "latency_ms": latency_ms, "http_status": status}
        return data, meta

    if transient and settings.openrouter_api_key.strip():
        data_or, meta_or = await _relay_openrouter_chain(settings=settings, payload=payload)
        meta_or.setdefault("upstream_deepseek_http", status)
        return data_or, meta_or

    if isinstance(data, dict):
        meta = {"provider": "deepseek", "model": outgoing["model"], "latency_ms": latency_ms, "http_status": status}
        return data, meta

    raise RuntimeError(f"deepseek_upstream_unexpected_http_{status}")


async def _relay_openrouter_chain(settings: Settings, payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    key = settings.openrouter_api_key.strip()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY_REQUIRED_FOR_FREE_TIER_ROUTE")

    models = (
        settings.openrouter_model_free_primary.strip(),
        settings.openrouter_model_free_fallback.strip(),
    )

    errors: list[str] = []

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "HTTP-Referer": settings.public_app_url.rstrip("/"),
        "X-OpenRouter-Title": "Bookmark Distil Hosted",
        "User-Agent": USER_AGENT_DISTIL,
    }

    for model in models:
        if not model:
            continue
        outgoing = dict(payload)
        outgoing["model"] = model
        try:
            status, data, latency_ms = await _post_openai_compatible(
                url=settings.openrouter_api_url,
                headers=headers,
                payload=outgoing,
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{model}: exception {exc!s}")
            continue

        if status == 200 and isinstance(data, dict) and "choices" in data:
            meta = {"provider": "openrouter", "model": model, "latency_ms": latency_ms, "http_status": status}
            return data, meta

        errors.append(f"{model}: HTTP {status}")

        await asyncio.sleep(0.2)

    raise RuntimeError("OPENROUTER_ALL_MODELS_FAILED: " + "; ".join(errors))


async def _post_openai_compatible(url: str, headers: dict[str, str], payload: dict[str, Any]) -> tuple[int, Any, int]:
    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=30.0)) as client:
        resp = await client.post(url, headers=headers, json=payload)
    latency_ms = int((time.perf_counter() - t0) * 1000)
    ctype = resp.headers.get("content-type", "")
    if "application/json" in ctype.lower():
        try:
            return resp.status_code, resp.json(), latency_ms
        except Exception:
            return resp.status_code, {"error": {"message": resp.text[:1200]}}, latency_ms

    return resp.status_code, {"error": {"message": resp.text[:1200]}}, latency_ms
