from datetime import timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request

from .auth import Principal, principal
from .db import dump, load, local_iso, utc_now
from .errors import conflict, not_found

router = APIRouter()


def view(row, timezone):
    return {
        "id": row["id"], "kind": row["kind"], "status": row["status"],
        "progress": row["progress"], "stage": row["stage"], "error": load(row["error"]),
        "course_id": row["course_id"], "target_id": row["target_id"],
        "result": load(row["result"]), "estimate": load(row["estimate"]),
        "created_at": local_iso(row["created_at"], timezone),
    }


def owned_job(conn, user_id, job_id):
    row = conn.execute("SELECT * FROM jobs WHERE id = ? AND user_id = ?", (job_id, user_id)).fetchone()
    if row is None:
        raise not_found("任务")
    return row


def new_job(conn, user, kind, target_id, *, course_id=None, stage=None, payload=None, estimate=None):
    job_id = uuid4().hex
    status = "needs_input" if estimate is not None else "queued"
    conn.execute(
        "INSERT INTO jobs (id,user_id,kind,status,stage,course_id,target_id,estimate,created_at,payload) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (job_id, user.id, kind, status, stage, course_id, target_id,
         dump(estimate) if estimate is not None else None, utc_now().isoformat(), dump(payload or {})),
    )
    return view(owned_job(conn, user.id, job_id), user.timezone)


def today_tokens(conn, user):
    zoned = utc_now().astimezone(ZoneInfo(user.timezone))
    midnight = zoned.replace(hour=0, minute=0, second=0, microsecond=0)
    end = midnight + timedelta(days=1)
    return conn.execute(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM model_usage "
        "WHERE user_id = ? AND created_at >= ? AND created_at < ?",
        (user.id, midnight.astimezone(ZoneInfo("UTC")).isoformat(), end.astimezone(ZoneInfo("UTC")).isoformat()),
    ).fetchone()[0]


def reached_daily_limit(conn, user):
    limit = conn.execute("SELECT daily_tokens FROM model_limits WHERE user_id = ?", (user.id,)).fetchone()
    return limit is not None and limit[0] is not None and today_tokens(conn, user) >= limit[0]


@router.get("/jobs/{job_id}")
def job(job_id: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        return view(owned_job(conn, user.id, job_id), user.timezone)


def requeue(job_id, request, user, *, retry):
    with request.app.state.db.transaction(write=True) as conn:
        row = owned_job(conn, user.id, job_id)
        if retry:
            error = load(row["error"])
            if row["status"] != "failed" or not error["retryable"]:
                raise conflict("这项任务当前不能重试")
        else:
            if row["status"] != "needs_input":
                raise conflict("这项任务当前不能继续")
            if reached_daily_limit(conn, user):
                raise conflict("已达今日上限，提高上限后可继续")
        payload = load(row["payload"])
        if retry:
            from .pipeline import prepare_retry
            prepare_retry(conn, row, payload)
        elif row["estimate"] is not None:
            payload["approved"] = True
            if row["kind"] == "ingest":
                conn.executemany(
                    "UPDATE materials SET status='reading',stage='读取资料' WHERE id=? AND status='waiting_confirm'",
                    [(mid,) for mid in payload["materials"]],
                )
        conn.execute(
            "UPDATE jobs SET status = 'queued', stage = ?, error = NULL, estimate = NULL, "
            "failure_count = 0, run_after = NULL, payload=? WHERE id = ?", ("等待开始", dump(payload), job_id),
        )
        result = view(owned_job(conn, user.id, job_id), user.timezone)
    request.app.state.events.publish(user.id, {"type": "job", "job": result})
    return result


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: str, request: Request, user: Principal = Depends(principal)):
    return requeue(job_id, request, user, retry=True)


@router.post("/jobs/{job_id}/continue")
def continue_job(job_id: str, request: Request, user: Principal = Depends(principal)):
    return requeue(job_id, request, user, retry=False)
