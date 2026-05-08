import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models import User
from app.routes_billing import create_portal_session


class CreateBillingPortalSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_portal_url_for_existing_customer(self):
        settings = SimpleNamespace(
            stripe_secret_key="sk_test_123",
            public_app_url="https://tool.bookmark.txzy.net",
        )
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=settings)))
        user = User(id=uuid4(), email="user@example.com", stripe_customer_id="cus_123")

        with patch("app.routes_billing.stripe.billing_portal.Session.create") as create_mock:
            create_mock.return_value = SimpleNamespace(url="https://billing.stripe.test/portal")

            result = await create_portal_session(request=request, db=SimpleNamespace(), user=user)

        self.assertEqual(result, {"url": "https://billing.stripe.test/portal"})
        create_mock.assert_called_once()

    async def test_rejects_missing_stripe_customer_id(self):
        settings = SimpleNamespace(
            stripe_secret_key="sk_test_123",
            public_app_url="https://tool.bookmark.txzy.net",
        )
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=settings)))
        user = User(id=uuid4(), email="user@example.com", stripe_customer_id=None)

        with self.assertRaises(HTTPException) as ctx:
            await create_portal_session(request=request, db=SimpleNamespace(), user=user)

        self.assertEqual(ctx.exception.status_code, 400)
