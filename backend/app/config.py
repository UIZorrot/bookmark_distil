from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    public_app_url: str = "http://localhost:8000"
    cors_origins: str = "*"
    api_prefix: str = "/api/v1"

    database_url: str | None = None
    db_path: str | None = None

    member_jwt_secret: str = "CHANGE_BACKEND_JWT_BEFORE_PRODUCTION_MIN_32_CHARS"
    member_jwt_alg: str = "HS256"
    member_access_token_expire_minutes: int = 10080

    deepseek_api_key: str = ""
    deepseek_api_url: str = "https://api.deepseek.com/v1/chat/completions"
    deepseek_model: str = "deepseek-chat"

    openrouter_api_key: str = ""
    openrouter_api_url: str = "https://openrouter.ai/api/v1/chat/completions"
    openrouter_model_free_primary: str = "tencent/hy3-preview:free"
    openrouter_model_free_fallback: str = "nvidia/nemotron-3-super-120b-a12b:free"

    resend_api_key: str = ""
    email_from: str = ""
    email_code_pepper: str = "CHANGE_ME_email_code_pepper"
    email_code_ttl_minutes: int = 10
    email_code_ip_hourly_cap: int = 8

    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_pro_us_monthly: str = ""
    stripe_price_pro_cn_monthly: str = ""
    invite_code_grant_days: int = 365

    ai_requests_per_minute_normal: int = 24
    ai_requests_per_minute_degraded: int = 6
    ai_short_window_seconds: int = 900
    ai_short_window_req_threshold: int = 40
    ai_soft_daily_request_cap: int = 220
    ai_degraded_cooldown_seconds: int = 3600

    rate_global_per_minute: str = "180/minute"


def resolve_database_url(settings: Settings) -> str:
    from urllib.parse import unquote_plus

    if settings.database_url and settings.database_url.strip():
        return unquote_plus(settings.database_url.strip().strip('"').strip("'"))
    if settings.db_path and settings.db_path.strip():
        return unquote_plus(settings.db_path.strip().strip('"').strip("'"))
    raise RuntimeError("Set DATABASE_URL or DB_PATH in backend/.env or root .env")


def parsed_cors_list(raw: str) -> list[str]:
    raw = raw.strip()
    if raw == "*" or not raw:
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]
