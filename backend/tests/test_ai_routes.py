import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException

from app.routes_ai import _has_relay_choices, hosted_ai_test


class HostedAiRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_hosted_ai_test_requires_active_subscription(self):
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=SimpleNamespace(deepseek_api_key=""))))
        user = SimpleNamespace(
            stripe_subscription_status="canceled",
            subscription_current_period_end=None,
        )

        with self.assertRaises(HTTPException) as ctx:
            await hosted_ai_test(request=request, user=user)

        self.assertEqual(ctx.exception.status_code, 402)
        self.assertEqual(ctx.exception.detail, "subscription_required")

    async def test_hosted_ai_test_uses_relay_and_returns_provider_metadata(self):
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=SimpleNamespace(deepseek_api_key="deepseek-key"))))
        user = SimpleNamespace(
            id="user-1",
            stripe_subscription_status="active",
            subscription_current_period_end=None,
        )

        with patch(
            "app.routes_ai.relay_chat_completion",
            new=AsyncMock(return_value=({"choices": [{"message": {"content": [{"type": "text", "text": "OK"}]}}]}, {"provider": "deepseek", "model": "deepseek-chat"})),
        ) as relay:
            result = await hosted_ai_test(request=request, user=user)

        relay.assert_awaited_once()
        self.assertEqual(result, {"ok": True, "provider": "deepseek", "model": "deepseek-chat"})

    def test_relay_choice_detection_requires_non_empty_choices(self):
        self.assertTrue(_has_relay_choices({"choices": [{}]}))
        self.assertFalse(_has_relay_choices({"choices": []}))
        self.assertFalse(_has_relay_choices({"choices": None}))
        self.assertFalse(_has_relay_choices({"error": {"message": "bad gateway"}}))


if __name__ == "__main__":
    unittest.main()
