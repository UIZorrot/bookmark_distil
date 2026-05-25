Python service for **`tool.bookmark.txzy.net`**: Postgres metadata, email verification-code login via **Resend**, **Stripe** Pro subscriptions (US vs CN price IDs), and a **hosted OpenAI-compatible `/chat/completions` relay**: **DeepSeek** by default with automatic **slow / free OpenRouter** path when abuse heuristics or upstream pressure demand it.

> **Secrets hygiene:** Keep **all** API keys in untracked `.env` files (see root `.gitignore`). If a key was ever pasted into chat or committed by mistake, **rotate it** at the provider before production. This service never ships tenant secrets in code.

---

## Requirements

- Python 3.12+ recommended  
- Network access from the host to Postgres, Stripe, DeepSeek/OpenRouter APIs, Resend

```bash
cd backend
uv sync
```

If you prefer to keep using a manual virtualenv, `requirements.txt` is still available as a fallback, but `uv sync` is now the primary path.

### Configuration (`backend/.env` or repo root `.env`)

Copy `backend/.env.example` → `backend/.env` and populate **all** placeholders. The backend loads env files by absolute path, so it works whether you start from the repo root or `backend/`:

1. repo root `.env`
2. `backend/.env`
3. real process environment variables

`backend/.env` can override root `.env` if the same variable appears in both. The extension only bundles `VITE_*` variables, so server secrets remain server-only as long as they are not prefixed with `VITE_`.

| Area | Notes |
|------|------|
| `DATABASE_URL` or `DB_PATH` | Async driver uses `postgres://` / `postgresql://` → `asyncpg` |
| `MEMBER_JWT_SECRET` | Long random string; signs extension tokens |
| `PUBLIC_APP_URL` | `https://tool.bookmark.txzy.net` (used for Stripe return URLs) |
| `CORS_ORIGINS` | Comma list; include your extension origin `chrome-extension://…` when wiring the client |
| `DEEPSEEK_*` | Primary paid path default `deepseek-chat`; swap to vendor “flash” IDs as they ship |
| `OPENROUTER_*` | Free fallback chain for **degraded** users / DeepSeek failures |
| `RESEND_*` / `EMAIL_FROM` | Verification-code email |
| `STRIPE_*` | `STRIPE_PRICE_PRO_US_MONTHLY` for **$4.88/mo** (USD), `STRIPE_PRICE_PRO_CN_MONTHLY` for **¥18.88/mo** (CNY) — create matching recurring prices in Stripe Dashboard. Checkout selects the region automatically from trusted country headers and defaults to the high-price USD tier. |
| `EMAIL_CODE_*` | Pepper, TTL, and hourly cap for verification-code requests per `(IP,email)` tuple |

---

## Run locally

```bash
cd backend
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8789
```

- Health: `GET http://127.0.0.1:8789/health`  
- API base: `/api/v1` (see routers under `app/routes_*.py`)  
- Extension local API base: set root `.env` `VITE_MEMBER_API_BASE=http://127.0.0.1:8789/api/v1` (also the code default)
- Stripe webhook: `POST /webhooks/stripe` (register in Stripe dashboard with same URL on the public host + signing secret)

---

## Rate limits & “slow mode” (cost guardrails)

1. **Verification code send** — `IpEmailThrottle` caps requests per hour per IP+email pair (configurable).  
2. **Hosted AI (Pro only)** — daily counter + **15-minute burst window** on the service worker bumps users into **`usage_degraded_until`** when they exceed `AI_SHORT_WINDOW_REQ_THRESHOLD` hits or daily `AI_SOFT_DAILY_REQUEST_CAP`. During cooldown (`AI_DEGRADED_COOLDOWN_SECONDS`) RPM limit drops (`AI_REQUESTS_PER_MINUTE_*`) and the relay forces **OpenRouter free** models sequentially. Healthy traffic stays on DeepSeek (`DEEPSEEK_MODEL` via `relay_chat_completion`).  
3. **DeepSeek outages / HTTP 429** — transient responses automatically cascade to OpenRouter chain once before surfacing failure.

Tune cost ceilings by editing throttle env vars (`backend/.env.example` documents defaults). Multi-instance deployments should replace in-memory trackers with Redis (not included yet).

---

## Next integration steps

- Wire Chrome extension HTTPS calls (`PUBLIC_APP_URL`/API prefix) storing `Bearer` JWT from `/api/v1/auth/email/verify`.  
- Stripe Customer Billing Portal + subscription cancel flows.  
- Idempotent Stripe webhook replay table.  
- Usage-based billing / hard monthly token caps if DeepSeek pricing requires stricter guardrails.
