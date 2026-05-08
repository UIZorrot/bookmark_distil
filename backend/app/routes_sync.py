from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import select

from app.deps import CurrentUserDep, DbSessionDep
from app.models import SyncOperationLog, SyncSnapshot, utcnow
from app.schemas import SyncStateIn, SyncStateOut

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/state", response_model=SyncStateOut)
async def get_sync_state(db: DbSessionDep, user: CurrentUserDep) -> SyncStateOut:
    res = await db.execute(select(SyncSnapshot).where(SyncSnapshot.user_id == user.id))
    row = res.scalar_one_or_none()
    if row is None:
        return SyncStateOut(revision=0, payload=None)
    return SyncStateOut(revision=row.revision, payload=row.payload)


@router.put("/state", response_model=SyncStateOut)
async def put_sync_state(payload: SyncStateIn, db: DbSessionDep, user: CurrentUserDep) -> SyncStateOut:
    res = await db.execute(select(SyncSnapshot).where(SyncSnapshot.user_id == user.id))
    row = res.scalar_one_or_none()

    if row is None:
        row = SyncSnapshot(user_id=user.id, revision=1, payload=payload.payload, updated_at=utcnow())
        db.add(row)
    else:
        row.revision += 1
        row.payload = payload.payload
        row.updated_at = utcnow()

    db.add(SyncOperationLog(user_id=user.id, revision=row.revision, operation="put_snapshot"))
    await db.commit()
    await db.refresh(row)

    return SyncStateOut(revision=row.revision, payload=row.payload)
