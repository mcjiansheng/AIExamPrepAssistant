"""Account export, deletion and reminder delivery."""
import logging
import os
import secrets
import shutil
import zipfile
from datetime import datetime, timedelta
from pathlib import PurePosixPath
from tempfile import NamedTemporaryFile
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request
from starlette.responses import FileResponse, JSONResponse

from . import accounts, jobs, plans
from .auth import Principal, principal, require_member, token_hash, user_view
from .db import dump, load, local_iso, utc_now
from .errors import conflict, not_found
from .events import changed
from .idempotency import run as idempotent
from .model_runtime import JobFailure

router = APIRouter()
User = Annotated[Principal, Depends(principal)]
logger = logging.getLogger("fullgrid.accounts")
EXPORT_LIFETIME = timedelta(hours=24)
EXPORT_TABLES = (
    "settings", "reminders", "memory_items", "learning_activity", "learning_resume", "plan_days",
    "courses", "course_formats", "chapters", "topics", "knowledge_points", "kp_progress",
    "materials", "material_pages", "kp_refs", "fragments", "focus_matches", "focus_conflicts",
    "bank_questions", "practice_sessions", "practice_questions", "question_reports",
    "learning_events", "mistakes", "schedule_items", "schedule_day_budget", "readiness_snapshots",
    "chat_threads", "notifications", "feedback", "model_usage", "model_limits", "devices",
)
JSON_COLUMNS = {
    "value", "modes", "blocks", "decision", "skipped_pages", "error", "options", "solution",
    "hints", "refs", "result", "kp_ids", "attempt", "tools", "memory", "operation", "manifest", "course_ids",
}


def root(app):
    return app.state.data_dir / "v1"


def export_path(app, user_id, job_id):
    return root(app) / "exports" / user_id / f"{job_id}.zip"


def exported_row(row):
    return {key: load(row[key]) if key in JSON_COLUMNS and isinstance(row[key], str) else row[key] for key in row.keys()}


def snapshot(conn, user_id):
    user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if user is None:
        raise not_found("账号")
    data = {"format": "fullgrid-v1", "exported_at": utc_now().isoformat(), "user": dict(user)}
    for table in EXPORT_TABLES:
        data[table] = [exported_row(row) for row in conn.execute(f"SELECT * FROM {table} WHERE user_id=?", (user_id,))]
    data["plugins"] = [exported_row(row) for row in conn.execute(
        """SELECT id,manifest,source,installed,enabled,scope,course_ids,granted,readme,updated_at
           FROM plugins WHERE user_id=?""", (user_id,),
    )]
    data["chat_messages"] = [exported_row(row) for row in conn.execute(
        """SELECT m.* FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id
           WHERE t.user_id=? ORDER BY m.created_at,m.rowid""", (user_id,),
    )]
    data["chat_cards"] = [exported_row(row) for row in conn.execute(
        """SELECT c.* FROM chat_cards c JOIN chat_messages m ON m.id=c.message_id
           JOIN chat_threads t ON t.id=m.thread_id WHERE t.user_id=? ORDER BY c.rowid""", (user_id,),
    )]
    return data


@router.post("/me/export")
def export_data(request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        def create():
            job = jobs.new_job(conn, user, "export", user.id, stage="等待导出")
            conn.execute("INSERT INTO data_exports(job_id,user_id) VALUES (?,?)", (job["id"], user.id))
            return 200, job
        status, result = idempotent(conn, request, user, create)
    request.app.state.events.publish(user.id, {"type": "job", "job": result})
    return JSONResponse(result, status_code=status)


def run_export(app, user, job, payload):
    """Build one consistent archive and publish it through a per-export capability."""
    from .pipeline import Removed, source_file
    target = export_path(app, user.id, job["id"])
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with NamedTemporaryFile(dir=target.parent, prefix=".export-", delete=False) as temp:
            temporary = target.parent / temp.name
        try:
            with app.state.db.transaction() as conn:
                data = snapshot(conn, user.id)
                originals = [row for row in data["materials"] if row["storage_extension"] is not None]
                with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr("data.json", dump(data))
                    for row in originals:
                        # The filename is a stored display string, while ownership is in the path.
                        name = PurePosixPath(row["title"].replace("\\", "/")).name or row["id"]
                        archive.write(source_file(app, row), f"materials/{row['id']}/{name}")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    except OSError as error:
        raise JobFailure("导出资料文件未能读取或写入，请重试", True) from error
    secret = secrets.token_urlsafe(32)
    expires = (utc_now() + EXPORT_LIFETIME).isoformat()
    with app.state.db.transaction(write=True) as conn:
        if conn.execute("SELECT 1 FROM jobs WHERE id=? AND user_id=?", (job["id"], user.id)).fetchone() is None:
            target.unlink(missing_ok=True)
            raise Removed
        conn.execute("UPDATE data_exports SET token_hash=?,expires_at=? WHERE job_id=? AND user_id=?",
                     (token_hash(secret), expires, job["id"], user.id))
        url = f"/api/v1/exports/{job['id']}?token={secret}"
        conn.execute("UPDATE jobs SET result=? WHERE id=? AND user_id=?", (dump({"url": url}), job["id"], user.id))


@router.get("/exports/{job_id}")
def download(job_id: str, request: Request, token: str | None = None):
    if token is None:
        raise not_found("导出文件")
    with request.app.state.db.transaction() as conn:
        row = conn.execute(
            """SELECT e.user_id FROM data_exports e JOIN jobs j ON j.id=e.job_id
               JOIN users u ON u.id=e.user_id
               WHERE e.job_id=? AND e.token_hash=? AND e.expires_at>? AND j.status='done'
                 AND (u.deletion_at IS NULL OR u.deletion_at>?)""",
            (job_id, token_hash(token), utc_now().isoformat(), utc_now().isoformat()),
        ).fetchone()
        if row is None:
            raise not_found("导出文件")
        path = export_path(request.app, row["user_id"], job_id)
        if not path.is_file():
            raise not_found("导出文件")
    return FileResponse(path, media_type="application/zip", filename="满格数据导出.zip",
                        headers={"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"})


@router.delete("/me")
def delete_account(request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        existing = conn.execute("SELECT deletion_at FROM users WHERE id=?", (user.id,)).fetchone()[0]
        deletion_at = existing or (utc_now() + timedelta(days=7)).isoformat()
        conn.execute("UPDATE users SET deletion_at=? WHERE id=?", (deletion_at, user.id))
    request.app.state.events.publish(user.id, changed(["settings"]))
    return {"deletion_at": local_iso(deletion_at, user.timezone)}


@router.post("/me/restore")
def restore_account(request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (user.id,)).fetchone()
        if row["deletion_at"] is not None and row["deletion_at"] <= utc_now().isoformat():
            raise conflict("账号冷静期已经结束")
        conn.execute("UPDATE users SET deletion_at=NULL WHERE id=?", (user.id,))
        result = user_view(conn.execute("SELECT * FROM users WHERE id=?", (user.id,)).fetchone())
    request.app.state.events.publish(user.id, changed(["settings"]))
    return result


def purge_user(conn, user_id):
    """The caller holds the write transaction that decides whether deletion is due."""
    row = conn.execute("SELECT phone FROM users WHERE id=?", (user_id,)).fetchone()
    if row is None:
        return
    conn.execute("INSERT OR IGNORE INTO account_file_garbage(user_id) VALUES (?)", (user_id,))
    conn.execute("DELETE FROM model_usage WHERE user_id=?", (user_id,))
    if row["phone"]:
        conn.execute("DELETE FROM sms_challenges WHERE phone=?", (row["phone"],))
        conn.execute("DELETE FROM login_limits WHERE phone=?", (row["phone"],))
    conn.execute("DELETE FROM users WHERE id=?", (user_id,))


def cleanup_users(app, now):
    with app.state.db.transaction(write=True) as conn:
        for row in conn.execute("SELECT id FROM users WHERE deletion_at IS NOT NULL AND deletion_at<=?", (now.isoformat(),)).fetchall():
            purge_user(conn, row["id"])
        last = conn.execute("SELECT completed_at FROM maintenance_runs WHERE name='guests'").fetchone()
        day = now.astimezone(ZoneInfo("America/Los_Angeles")).date()
        if last is None or datetime.fromisoformat(last["completed_at"]).astimezone(ZoneInfo("America/Los_Angeles")).date() < day:
            cutoff = (now - timedelta(days=30)).isoformat()
            for row in conn.execute("SELECT id FROM users WHERE guest=1 AND last_active<=?", (cutoff,)).fetchall():
                purge_user(conn, row["id"])
            conn.execute("INSERT INTO maintenance_runs(name,completed_at) VALUES ('guests',?) "
                         "ON CONFLICT(name) DO UPDATE SET completed_at=excluded.completed_at", (now.isoformat(),))
        queued = conn.execute(
            "SELECT user_id FROM account_file_garbage WHERE retry_after IS NULL OR retry_after<=?", (now.isoformat(),),
        ).fetchall()
    for row in queued:
        uid = row["user_id"]
        try:
            for name in ("files", "renders", "exports", "plugins"):
                path = root(app) / name / uid
                if path.is_symlink():
                    path.unlink()
                elif path.exists():
                    shutil.rmtree(path)
        except OSError:
            logger.warning(dump({"event": "account_cleanup_retry", "user_id": uid}))
            with app.state.db.transaction(write=True) as conn:
                conn.execute("UPDATE account_file_garbage SET retry_after=? WHERE user_id=?",
                             ((now + timedelta(minutes=1)).isoformat(), uid))
        else:
            with app.state.db.transaction(write=True) as conn:
                conn.execute("DELETE FROM account_file_garbage WHERE user_id=?", (uid,))
                conn.execute("DELETE FROM material_garbage WHERE user_id=?", (uid,))


def cleanup_exports(app, now):
    with app.state.db.transaction() as conn:
        rows = conn.execute("SELECT job_id,user_id FROM data_exports WHERE expires_at<=?", (now.isoformat(),)).fetchall()
    for row in rows:
        try:
            export_path(app, row["user_id"], row["job_id"]).unlink(missing_ok=True)
        except OSError:
            logger.warning(dump({"event": "export_cleanup_retry", "job_id": row["job_id"]}))
            continue
        with app.state.db.transaction(write=True) as conn:
            conn.execute("DELETE FROM data_exports WHERE job_id=? AND expires_at<=?", (row["job_id"], now.isoformat()))
            conn.execute("UPDATE jobs SET result=NULL WHERE id=?", (row["job_id"],))


def delivery(conn, user, on, kind, target, title, body, href):
    inserted = conn.execute("INSERT OR IGNORE INTO reminder_deliveries(user_id,kind,target,date) VALUES (?,?,?,?)",
                            (user.id, kind, target, str(on))).rowcount
    if not inserted:
        return None
    notification = accounts.add_notification(conn, user.id, kind, title, body=body, href=href)
    return {"type": "notification", "notification": accounts.notification_view(notification, user.timezone)}


def send_reminders(app, now):
    events = []
    with app.state.db.transaction(write=True) as conn:
        rows = conn.execute(
            """SELECT u.id,u.timezone,r.daily_enabled,r.daily_time,r.exam_soon FROM users u
               JOIN reminders r ON r.user_id=u.id WHERE u.guest=0""",
        ).fetchall()
        for row in rows:
            user = Principal(row["id"], "", row["timezone"], False)
            local = now.astimezone(ZoneInfo(user.timezone))
            on = local.date()
            if row["daily_enabled"] and local.strftime("%H:%M") >= row["daily_time"]:
                plans.ensure_plan(conn, user)
                count = conn.execute("SELECT COUNT(*) FROM schedule_items WHERE user_id=? AND date=? AND status='todo'",
                                     (user.id, str(on))).fetchone()[0]
                event = delivery(conn, user, on, "daily", "", "今天的学习提醒",
                                 f"今天还剩 {count} 项任务", "/")
                if event:
                    events.append((user.id, event))
            if row["exam_soon"]:
                for course in conn.execute("SELECT id,name,exam_date FROM courses WHERE user_id=? AND exam_date IN (?,?)",
                                           (user.id, str(on + timedelta(days=3)), str(on + timedelta(days=1)))):
                    days = (datetime.fromisoformat(course["exam_date"]).date() - on).days
                    event = delivery(conn, user, on, "exam_soon", course["id"], f"{course['name']}还有 {days} 天考试",
                                     "打开课程看看接下来的安排", f"/c/{course['id']}")
                    if event:
                        events.append((user.id, event))
    for uid, event in events:
        app.state.events.publish(uid, event)


def maintenance(app, now=None):
    now = now or utc_now()
    cleanup_users(app, now)
    cleanup_exports(app, now)
    send_reminders(app, now)
