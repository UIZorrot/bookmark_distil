from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import Settings, resolve_database_url


class Base(DeclarativeBase):
    pass


def db_url_async(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    raise ValueError(f"Unsupported database URL scheme (got {url.split(':')[0] + ':***'})")


def asyncpg_engine_args(url: str) -> tuple[str, dict]:
    async_url = db_url_async(url)
    parts = urlsplit(async_url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    sslmode = next((value.lower() for key, value in query if key.lower() == "sslmode"), None)

    if sslmode is None:
        return async_url, {}

    filtered_query = [(key, value) for key, value in query if key.lower() != "sslmode"]
    sanitized_url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(filtered_query), parts.fragment))
    connect_args = {"ssl": sslmode != "disable"}
    return sanitized_url, {"connect_args": connect_args}


def create_engine_and_sessionmaker(settings: Settings):
    resolved = resolve_database_url(settings)
    async_url, engine_kwargs = asyncpg_engine_args(resolved)
    engine = create_async_engine(async_url, echo=False, **engine_kwargs)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    return engine, session_factory
