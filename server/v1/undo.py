from datetime import timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, Request

from .auth import Principal, principal
from .db import dump, load, local_iso, utc_now
from .errors import conflict, not_found
from .events import changed

router = APIRouter()

# Tables with undo support have an invalidation trigger keyed by this column.
UNDO_KEYS = {
    "settings": "user_id", "courses": "id", "course_formats": "course_id", "materials": "id",
    "fragments": "id", "focus_matches": "id", "focus_conflicts": "id", "kp_refs": "id",
}


def record(conn, user, *, label, summary, affects, rows):
    if not rows:
        return None
    undo_id = uuid4().hex
    expires = (utc_now() + timedelta(days=1)).isoformat()
    conn.execute(
        "INSERT INTO undos (id,user_id,label,summary,affects,snapshots,expires_at) VALUES (?,?,?,?,?,?,?)",
        (undo_id, user.id, label, summary, dump(affects), dump(rows), expires),
    )
    conn.executemany(
        "INSERT INTO undo_rows (undo_id,table_name,row_key) VALUES (?,?,?)",
        [(undo_id, table, key[UNDO_KEYS[table]]) for table, key, _ in rows],
    )
    return {"id": undo_id, "label": label, "expires_at": local_iso(expires, user.timezone)}


def restore(conn, table, key, before):
    column = UNDO_KEYS[table]
    value = key[column]
    if before is None:
        conn.execute(f"DELETE FROM {table} WHERE {column} = ?", (value,))
        return
    # The column names come from the original row, not from the request.
    fields = tuple(before)
    columns = ", ".join(f'"{name}"' for name in fields)
    parameters = ", ".join("?" for _ in fields)
    assignments = ", ".join(f'"{name}" = excluded."{name}"' for name in fields if name != column)
    conn.execute(
        f"INSERT INTO {table} ({columns}) VALUES ({parameters}) "
        f"ON CONFLICT({column}) DO UPDATE SET {assignments}",
        tuple(before[name] for name in fields),
    )


@router.post("/undo/{undo_id}")
def undo(undo_id: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        row = conn.execute("SELECT * FROM undos WHERE id = ? AND user_id = ?", (undo_id, user.id)).fetchone()
        if row is None:
            raise not_found("撤销记录")
        if row["state"] != "active" or row["expires_at"] <= utc_now().isoformat():
            raise conflict("这次改动已无法撤销")
        conn.execute("UPDATE undos SET state = 'undone' WHERE id = ?", (undo_id,))
        for table, key, before in reversed(load(row["snapshots"])):
            restore(conn, table, key, before)
        affects = load(row["affects"])
        response = {"ok": True, "affects": affects, "summary": row["summary"]}
    request.app.state.events.publish(user.id, changed(affects))
    return response
