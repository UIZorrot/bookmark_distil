"""Bookmark Distil tooling API — email code login, Stripe Pro, hosted LLM relay."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import stripe
from fastapi import FastAPI, HTTPException, Request
from starlette.middleware.cors import CORSMiddleware

try:
    from stripe import SignatureVerificationError
except ImportError:
    SignatureVerificationError = ValueError  # type: ignore[misc, assignment]
from app.config import Settings, parsed_cors_list
from app.db import Base, create_engine_and_sessionmaker
from app.email_throttle import IpEmailThrottle
from app.routes_ai import router as ai_router
from app.routes_auth import router as auth_router
from app.routes_billing import router as billing_router
from app.routes_invites import router as invites_router
from app.routes_sync import router as sync_router
from app.service_usage_tracker import UsageBurstTracker
from app.stripe_sync import finalize_checkout_session, ingest_subscription_updated_event

_LOG = logging.getLogger("bookmark_distil.api")

SETTINGS = Settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.settings = SETTINGS
    stripe.api_key = SETTINGS.stripe_secret_key.strip() or None

    engine, session_factory = create_engine_and_sessionmaker(SETTINGS)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    app.state.session_factory = session_factory
    app.state.short_tracker = UsageBurstTracker(SETTINGS)
    app.state.rpm_tracker = UsageBurstTracker(SETTINGS)
    app.state.email_code_ip_email_throttle = IpEmailThrottle(hourly_cap=SETTINGS.email_code_ip_hourly_cap)

    yield

    await engine.dispose()


app = FastAPI(title="Bookmark Distil API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=parsed_cors_list(SETTINGS.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS", "PUT", "PATCH", "DELETE"],
    allow_headers=["*"],
)

API_PREFIX = SETTINGS.api_prefix.rstrip("/")

app.include_router(auth_router, prefix=API_PREFIX)
app.include_router(ai_router, prefix=API_PREFIX)
app.include_router(billing_router, prefix=API_PREFIX)
app.include_router(invites_router, prefix=API_PREFIX)
app.include_router(sync_router, prefix=API_PREFIX)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def _stripe_object_to_dict(obj: object) -> dict:
    if hasattr(obj, "to_dict"):
        try:
            return dict(obj.to_dict())  # type: ignore[arg-type]
        except Exception:
            pass
    try:
        return dict(obj)  # type: ignore[arg-type]
    except Exception:
        return {}


@app.post("/webhooks/stripe")
async def stripe_webhook(request: Request) -> dict[str, bool]:
    settings = request.app.state.settings
    secret = settings.stripe_webhook_secret.strip()
    if not secret:
        _LOG.error("stripe_webhook_secret_missing")
        raise HTTPException(status_code=503, detail="webhook_disabled")

    payload = await request.body()
    sig = request.headers.get("stripe-signature")
    if not sig:
        raise HTTPException(status_code=400, detail="missing_signature")

    try:

        def _parse():
            return stripe.Webhook.construct_event(payload, sig, secret)

        event = await asyncio.to_thread(_parse)
    except ValueError as exc:
        _LOG.warning("stripe_payload_invalid: %s", exc)
        raise HTTPException(status_code=400, detail="invalid_payload") from exc
    except SignatureVerificationError as exc:
        _LOG.warning("stripe_signature_invalid: %s", exc)
        raise HTTPException(status_code=400, detail="invalid_signature") from exc

    etype = getattr(event, "type", None)
    nested = getattr(event, "data", None)
    data_obj = getattr(nested, "object", None) if nested is not None else None
    if etype is None or data_obj is None:
        return {"received": True}

    factory = request.app.state.session_factory

    try:
        async with factory() as session:
            if etype == "checkout.session.completed":
                checkout_dict = _stripe_object_to_dict(data_obj)
                await finalize_checkout_session(session, checkout_dict)
            elif etype in (
                "customer.subscription.created",
                "customer.subscription.updated",
                "customer.subscription.deleted",
            ):
                sub_id = getattr(data_obj, "id", None) or (data_obj.get("id") if isinstance(data_obj, dict) else None)
                if not sub_id:
                    _LOG.warning("stripe subscription event missing id")
                    return {"received": True}

                subscription = await asyncio.to_thread(lambda: stripe.Subscription.retrieve(str(sub_id)))
                await ingest_subscription_updated_event(session, subscription)
    except LookupError as exc:
        _LOG.warning("stripe_webhook_lookup_skip type=%s err=%s", etype, exc)
        return {"received": True}

    except Exception:
        _LOG.exception("stripe_webhook_handler_failed type=%s", etype)
        raise

    return {"received": True}
