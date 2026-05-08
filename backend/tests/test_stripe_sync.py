import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models import User
from app.stripe_sync import finalize_checkout_session, ingest_subscription_updated_event


class DummySession:
    def __init__(self):
        self.committed = False
        self.added = []

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        self.committed = True


class StripeSyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_checkout_completion_marks_user_active(self):
        session = DummySession()
        user = User(id=uuid4(), email="user@example.com", stripe_subscription_status="inactive")
        period_end = int((datetime.now(timezone.utc) + timedelta(days=30)).timestamp())

        with (
            patch("app.stripe_sync.hydrate_user", new=AsyncMock(return_value=user)),
            patch(
                "app.stripe_sync.stripe.Subscription.retrieve",
                return_value=SimpleNamespace(
                    id="sub_123",
                    status="active",
                    customer="cus_123",
                    current_period_end=period_end,
                ),
            ),
        ):
            await finalize_checkout_session(
                session,
                {
                    "client_reference_id": str(user.id),
                    "customer": "cus_123",
                    "subscription": "sub_123",
                },
            )

        self.assertTrue(session.committed)
        self.assertEqual(user.stripe_customer_id, "cus_123")
        self.assertEqual(user.stripe_subscription_id, "sub_123")
        self.assertEqual(user.stripe_subscription_status, "active")
        self.assertIsNotNone(user.subscription_current_period_end)

    async def test_subscription_update_uses_metadata_when_customer_lookup_fails(self):
        session = DummySession()
        user = User(id=uuid4(), email="user@example.com", stripe_subscription_status="inactive")
        period_end = int((datetime.now(timezone.utc) + timedelta(days=30)).timestamp())

        with (
            patch("app.stripe_sync.apply_subscription_customer_lookup", side_effect=LookupError("missing_customer")),
            patch("app.stripe_sync.hydrate_user", new=AsyncMock(return_value=user)),
        ):
            await ingest_subscription_updated_event(
                session,
                SimpleNamespace(
                    customer=None,
                    metadata={"bookmark_distil_user_id": str(user.id)},
                    id="sub_456",
                    status="trialing",
                    current_period_end=period_end,
                ),
            )

        self.assertTrue(session.committed)
        self.assertEqual(user.stripe_subscription_status, "trialing")
        self.assertIsNotNone(user.subscription_current_period_end)

