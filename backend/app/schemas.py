from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class EmailCodeSendIn(BaseModel):
    email: EmailStr


class EmailCodeVerifyIn(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    user_id: UUID
    email: EmailStr


class InviteRedeemIn(BaseModel):
    code: str = Field(min_length=8, max_length=64)


class InviteRedeemOut(BaseModel):
    detail: str
    subscription_status: str
    subscription_current_period_end: str


class ChatRelayIn(BaseModel):
    """OpenAI-style chat completions body; forwards unknown keys."""

    model_config = ConfigDict(extra="allow")

    messages: list[dict[str, Any]]
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None


class SyncStateIn(BaseModel):
    payload: dict[str, Any]


class SyncStateOut(BaseModel):
    revision: int
    payload: dict[str, Any] | None
