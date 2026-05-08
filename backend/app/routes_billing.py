from __future__ import annotations

import asyncio

import stripe
from fastapi import APIRouter, HTTPException, Request

from app.deps import CurrentUserDep, DbSessionDep
from app.models import User

router = APIRouter(prefix="/billing", tags=["billing"])


LOW_PRICE_COUNTRIES = {"CN"}
COUNTRY_HEADERS = (
    "cf-ipcountry",
    "x-vercel-ip-country",
    "x-country-code",
    "x-appengine-country",
    "cloudfront-viewer-country",
)


def pricing_region_for_country(country_code: str | None) -> str:
    normalized = (country_code or "").strip().upper()
    return "cn" if normalized in LOW_PRICE_COUNTRIES else "us"


def country_code_from_request(request: Request) -> str | None:
    for header in COUNTRY_HEADERS:
        value = request.headers.get(header)
        if value and value.strip() and value.strip().upper() != "XX":
            return value.strip()
    return None


def sync_create_subscription_checkout(
    settings,
    user: User,
    price_id: str,
    success_suffix: str,
) -> stripe.checkout.Session:
    return stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=f"{settings.public_app_url.rstrip('/')}{success_suffix}",
        cancel_url=f"{settings.public_app_url.rstrip('/')}/billing/cancel",
        client_reference_id=str(user.id),
        customer_email=user.email,
        subscription_data={
            "metadata": {"bookmark_distil_user_id": str(user.id)},
        },
        metadata={"bookmark_distil_user_id": str(user.id)},
        allow_promotion_codes=True,
    )


@router.post("/checkout/session")
async def create_subscription_checkout(
    request: Request,
    db: DbSessionDep,
    user: CurrentUserDep,
):
    settings = request.app.state.settings

    stripe_key = settings.stripe_secret_key.strip()
    if not stripe_key:
        raise HTTPException(status_code=503, detail="stripe_not_configured")

    pricing_region = pricing_region_for_country(country_code_from_request(request))
    price_raw = settings.stripe_price_pro_cn_monthly if pricing_region == "cn" else settings.stripe_price_pro_us_monthly

    price_id = str(price_raw or "").strip()
    if not price_id.startswith("price_"):
        raise HTTPException(status_code=503, detail="stripe_price_missing_for_region")

    stripe.api_key = stripe_key

    user.pricing_region = pricing_region
    db.add(user)
    await db.commit()

    try:
        session = await asyncio.to_thread(
            sync_create_subscription_checkout,
            settings,
            user,
            price_id,
            "/billing/success?session_id={CHECKOUT_SESSION_ID}",
        )
    except stripe.StripeError as exc:
        msg = getattr(exc, "user_message", None) or str(exc)
        raise HTTPException(status_code=400, detail=f"stripe:{msg}")

    url = getattr(session, "url", None)
    if not url:
        raise HTTPException(status_code=502, detail="stripe_missing_checkout_url")

    return {"url": url}


@router.post("/portal/session")
async def create_portal_session(
    request: Request,
    db: DbSessionDep,
    user: CurrentUserDep,
):
    settings = request.app.state.settings

    stripe_key = settings.stripe_secret_key.strip()
    if not stripe_key:
        raise HTTPException(status_code=503, detail="stripe_not_configured")

    customer_id = user.stripe_customer_id.strip() if user.stripe_customer_id else ""
    if not customer_id:
        raise HTTPException(status_code=400, detail="stripe_customer_missing")

    stripe.api_key = stripe_key

    try:
        session = await asyncio.to_thread(
            lambda: stripe.billing_portal.Session.create(
                customer=customer_id,
                return_url=f"{settings.public_app_url.rstrip('/')}",
            )
        )
    except stripe.StripeError as exc:
        msg = getattr(exc, "user_message", None) or str(exc)
        raise HTTPException(status_code=400, detail=f"stripe:{msg}")

    url = getattr(session, "url", None)
    if not url:
        raise HTTPException(status_code=502, detail="stripe_missing_portal_url")

    return {"url": url}
