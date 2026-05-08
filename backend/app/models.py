import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, JSON, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "bookmark_distil_users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    stripe_customer_id: Mapped[str | None] = mapped_column(String(191), nullable=True, index=True)

    pricing_region: Mapped[str] = mapped_column(String(8), default="us")  # us | cn
    stripe_subscription_status: Mapped[str] = mapped_column(String(32), default="inactive")

    stripe_subscription_id: Mapped[str | None] = mapped_column(String(191), nullable=True)
    subscription_current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    usage_degraded_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    ai_usage_day: Mapped[date | None] = mapped_column(Date(), nullable=True)
    ai_daily_request_count: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class EmailVerificationCode(Base):
    __tablename__ = "bookmark_distil_email_verification_codes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    code_digest: Mapped[str] = mapped_column(String(128), index=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("bookmark_distil_users.id"), nullable=True)

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class AISpendLog(Base):
    __tablename__ = "bookmark_distil_ai_spend_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("bookmark_distil_users.id"), index=True)

    provider: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(160))
    used_degraded_fallback: Mapped[bool] = mapped_column(Boolean, default=False)

    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class InviteCode(Base):
    __tablename__ = "bookmark_distil_invite_codes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code_digest: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    batch_id: Mapped[str] = mapped_column(String(64), index=True)
    redeemed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("bookmark_distil_users.id"), nullable=True, index=True)
    redeemed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SyncSnapshot(Base):
    __tablename__ = "bookmark_distil_sync_snapshots"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("bookmark_distil_users.id"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class SyncOperationLog(Base):
    __tablename__ = "bookmark_distil_sync_operation_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("bookmark_distil_users.id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    operation: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
