"""Account preferences, learning position, and notifications for API v1."""
from datetime import datetime, timedelta
import secrets
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .auth import Principal, principal, require_member, user_view
from .db import local_iso, utc_now
from .errors import ApiError
from .idempotency import run as idempotent
from .undo import record

router = APIRouter()
User = Annotated[Principal, Depends(principal)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class OnboardingPatch(Input):
    ai: Literal["done", "skipped"] | None = None
    course: Literal["done", "skipped"] | None = None


class ProfilePatch(Input):
    nickname: str | None = None
    avatar_url: str | None = None
    school: str | None = None
    major: str | None = None
    timezone: str | None = None
    onboarding: OnboardingPatch | None = None

    @field_validator("nickname", "timezone", "onboarding")
    @classmethod
    def non_nullable_fields(cls, value):
        if value is None:
            raise ValueError("这个字段不能设为空")
        return value

    @field_validator("nickname")
    @classmethod
    def nickname_text(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("昵称不能为空")
        return value

    @field_validator("timezone")
    @classmethod
    def known_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError("时区名称不正确") from None
        return value


class SettingsPatch(Input):
    daily_minutes: int | None = Field(default=None, ge=30, le=600)
    intensity: Literal["easy", "standard", "sprint"] | None = None
    theme: Literal["system", "light", "dark"] | None = None
    reduce_motion: Literal["system", "on", "off"] | None = None
    briefing: bool | None = None
    proactive_hints: bool | None = None
    memory: bool | None = None

    @model_validator(mode="after")
    def supplied_fields_have_values(self):
        if any(getattr(self, name) is None for name in self.model_fields_set):
            raise ValueError("设置字段不能设为空")
        return self


class DailyReminder(Input):
    enabled: bool
    time: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")


class ReminderInput(Input):
    daily: DailyReminder
    exam_soon: bool
    jobs: bool


class ResumeInput(Input):
    kind: Literal["kp", "session"]
    course_id: str
    kp_id: str | None = None
    session_id: str | None = None
    position: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def target_required(self):
        if self.kind == "kp" and self.kp_id is None:
            raise ValueError("请提供知识点 id")
        if self.kind == "session" and self.session_id is None:
            raise ValueError("请提供练习 id")
        return self


class FeedbackInput(Input):
    kind: Literal["bug", "idea", "report"]
    text: str
    context: str | None

    @field_validator("text")
    @classmethod
    def text_required(cls, value):
        if not value.strip():
            raise ValueError("请填写反馈内容")
        return value


class NotificationsRead(Input):
    ids: list[str] | None = None


def changed(request, user_id, areas):
    request.app.state.events.publish(user_id, {
        "type": "changed", "areas": areas, "course_id": None,
    })


def settings_view(row):
    return {
        "daily_minutes": row["daily_minutes"],
        "intensity": row["intensity"],
        "theme": row["theme"],
        "reduce_motion": row["reduce_motion"],
        "briefing": bool(row["briefing"]),
        "proactive_hints": bool(row["proactive_hints"]),
        "memory": bool(row["memory"]),
    }


def update_settings(conn, user, changes):
    """Apply already-validated settings and return their Change response."""
    before = conn.execute("SELECT * FROM settings WHERE user_id=?", (user.id,)).fetchone()
    updates = {name: value for name, value in changes.items() if before[name] != value}
    affects = ["settings"]
    if updates.keys() & {"daily_minutes", "intensity"}:
        affects += ["today", "schedule"]
    undo = None
    if updates:
        assignments = ", ".join(f"{name}=?" for name in updates)
        conn.execute(f"UPDATE settings SET {assignments} WHERE user_id=?", (*updates.values(), user.id))
        snapshots = [("settings", {"user_id": user.id}, dict(before))]
        if updates.keys() & {"daily_minutes", "intensity"}:
            from .plans import replan
            snapshots += replan(conn, user)
        undo = record(conn, user, label="已修改设置", summary="设置已恢复", affects=affects,
                      rows=snapshots)
    result = conn.execute("SELECT * FROM settings WHERE user_id=?", (user.id,)).fetchone()
    return {"result": settings_view(result), "affects": affects, "undo": undo}


def reminders_view(row):
    return {
        "daily": {"enabled": bool(row["daily_enabled"]), "time": row["daily_time"]},
        "exam_soon": bool(row["exam_soon"]), "jobs": bool(row["jobs"]),
    }


def notification_view(row, timezone):
    return {
        "id": row["id"], "kind": row["kind"], "title": row["title"],
        "body": row["body"], "href": row["href"],
        "created_at": local_iso(row["created_at"], timezone), "read": row["read_at"] is not None,
    }


def add_notification(conn, user_id, kind, title, *, body=None, href=None):
    notification_id = secrets.token_urlsafe(18)
    conn.execute(
        "INSERT INTO notifications(id,user_id,kind,title,body,href,created_at) VALUES(?,?,?,?,?,?,?)",
        (notification_id, user_id, kind, title, body, href, utc_now().isoformat()),
    )
    return conn.execute("SELECT * FROM notifications WHERE id=?", (notification_id,)).fetchone()


def resolve_resume(conn, user, payload):
    course = conn.execute("SELECT id,name FROM courses WHERE id=? AND user_id=?", (payload.course_id, user.id)).fetchone()
    if course is None:
        raise ApiError(404, "not_found", "课程不存在")
    if payload.kind == "kp":
        target = conn.execute(
            "SELECT id,title FROM knowledge_points WHERE id=? AND user_id=? AND course_id=?",
            (payload.kp_id, user.id, payload.course_id),
        ).fetchone()
        if target is None:
            raise ApiError(404, "not_found", "知识点不存在")
        return {"title": target["title"], "detail": None, "href": f"/c/{course['id']}/kp/{target['id']}"}
    target = conn.execute(
        "SELECT id,title FROM practice_sessions WHERE id=? AND user_id=? AND (course_id=? OR course_id IS NULL)",
        (payload.session_id, user.id, payload.course_id),
    ).fetchone()
    if target is None:
        raise ApiError(404, "not_found", "练习不存在")
    return {"title": target["title"], "detail": f"第 {(payload.position or 0) + 1} 题", "href": f"/session/{target['id']}"}


def resume_view(conn, user):
    row = conn.execute("SELECT * FROM learning_resume WHERE user_id=?", (user.id,)).fetchone()
    if row is None:
        return None
    payload = ResumeInput.model_construct(kind=row["kind"], course_id=row["course_id"], kp_id=row["kp_id"],
                                          session_id=row["session_id"], position=row["position"])
    target = resolve_resume(conn, user, payload)
    device = conn.execute("SELECT name FROM devices WHERE id=?", (row["device_id"],)).fetchone()
    return {"kind": row["kind"], "course_id": row["course_id"], **target,
            "updated_at": local_iso(row["updated_at"], user.timezone), "device": device["name"]}


@router.get("/me")
def me(request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        return user_view(conn.execute("SELECT * FROM users WHERE id=?", (user.id,)).fetchone())


@router.patch("/me")
def patch_me(body: ProfilePatch, request: Request, user: User):
    require_member(user)
    changes = body.model_dump(exclude_unset=True)
    onboarding = changes.pop("onboarding", None)
    if onboarding is not None:
        changes.update({f"onboard_{name}": value for name, value in onboarding.items()})
    with request.app.state.db.transaction(write=True) as conn:
        if changes:
            assignments = ", ".join(f"{name}=?" for name in changes)
            conn.execute(f"UPDATE users SET {assignments} WHERE id=?", (*changes.values(), user.id))
        result = user_view(conn.execute("SELECT * FROM users WHERE id=?", (user.id,)).fetchone())
    changed(request, user.id, ["settings"])
    return result


@router.get("/me/stats")
def stats(request: Request, user: User):
    timezone = ZoneInfo(user.timezone)
    today = utc_now().astimezone(timezone).date()
    start = today - timedelta(days=6)
    with request.app.state.db.transaction() as conn:
        activity = conn.execute("SELECT minutes,created_at FROM learning_activity WHERE user_id=?", (user.id,)).fetchall()
    days = set()
    minutes = 0
    for row in activity:
        date = datetime.fromisoformat(row["created_at"]).astimezone(timezone).date()
        days.add(date)
        if start <= date <= today:
            minutes += row["minutes"]
    cursor = today if today in days else today - timedelta(days=1)
    streak = 0
    while cursor in days:
        streak += 1
        cursor -= timedelta(days=1)
    return {"week_minutes": round(minutes), "streak_days": streak}


@router.get("/me/devices")
def devices(request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        rows = conn.execute(
            "SELECT * FROM devices WHERE user_id=? AND revoked_at IS NULL ORDER BY id=? DESC,last_seen DESC",
            (user.id, user.device_id),
        ).fetchall()
    return [{"id": row["id"], "kind": row["kind"], "name": row["name"],
             "last_seen": local_iso(row["last_seen"], user.timezone), "current": row["id"] == user.device_id} for row in rows]


@router.delete("/me/devices/{device_id}", status_code=204)
def remove_device(device_id: str, request: Request, user: User):
    with request.app.state.db.transaction(write=True) as conn:
        row = conn.execute("SELECT id FROM devices WHERE id=? AND user_id=?", (device_id, user.id)).fetchone()
        if row is None:
            raise ApiError(404, "not_found", "设备不存在")
        conn.execute("UPDATE devices SET revoked_at=? WHERE id=?", (utc_now().isoformat(), device_id))
    changed(request, user.id, ["settings"])
    return Response(status_code=204)


@router.put("/me/resume", status_code=204)
def save_resume(body: ResumeInput, request: Request, user: User):
    with request.app.state.db.transaction(write=True) as conn:
        resolve_resume(conn, user, body)
        conn.execute(
            "INSERT INTO learning_resume(user_id,kind,course_id,kp_id,session_id,position,device_id,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind,course_id=excluded.course_id,"
            "kp_id=excluded.kp_id,session_id=excluded.session_id,position=excluded.position,device_id=excluded.device_id,"
            "updated_at=excluded.updated_at",
            (user.id, body.kind, body.course_id, body.kp_id if body.kind == "kp" else None,
             body.session_id if body.kind == "session" else None, body.position, user.device_id, utc_now().isoformat()),
        )
        result = resume_view(conn, user)
    request.app.state.events.publish(user.id, {"type": "resume", "resume": result})
    return Response(status_code=204)


@router.post("/feedback", status_code=204)
def feedback(body: FeedbackInput, request: Request, user: User):
    def create():
        conn.execute("INSERT INTO feedback(id,user_id,kind,text,context,created_at) VALUES(?,?,?,?,?,?)",
                     (secrets.token_urlsafe(18), user.id, body.kind, body.text, body.context, utc_now().isoformat()))
        return 204, None
    with request.app.state.db.transaction(write=True) as conn:
        status, _ = idempotent(conn, request, user, create)
    return Response(status_code=status)


@router.get("/me/settings")
def settings(request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        return settings_view(conn.execute("SELECT * FROM settings WHERE user_id=?", (user.id,)).fetchone())


@router.patch("/me/settings")
def patch_settings(body: SettingsPatch, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        change = update_settings(conn, user, body.model_dump(exclude_unset=True))
    changed(request, user.id, change["affects"])
    return change


@router.get("/me/reminders")
def reminders(request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        return reminders_view(conn.execute("SELECT * FROM reminders WHERE user_id=?", (user.id,)).fetchone())


@router.put("/me/reminders")
def set_reminders(body: ReminderInput, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        conn.execute("UPDATE reminders SET daily_enabled=?,daily_time=?,exam_soon=?,jobs=? WHERE user_id=?",
                     (body.daily.enabled, body.daily.time, body.exam_soon, body.jobs, user.id))
        result = reminders_view(conn.execute("SELECT * FROM reminders WHERE user_id=?", (user.id,)).fetchone())
    changed(request, user.id, ["settings", "notifications"])
    return result


@router.get("/me/memory")
def memory(request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        rows = conn.execute("SELECT * FROM memory_items WHERE user_id=? ORDER BY created_at DESC,id DESC", (user.id,)).fetchall()
    return [{"id": row["id"], "text": row["text"], "source": row["source"],
             "created_at": local_iso(row["created_at"], user.timezone)} for row in rows]


@router.delete("/me/memory/{memory_id}", status_code=204)
def forget(memory_id: str, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        if conn.execute("DELETE FROM memory_items WHERE id=? AND user_id=?", (memory_id, user.id)).rowcount == 0:
            raise ApiError(404, "not_found", "记忆不存在")
    changed(request, user.id, ["settings"])
    return Response(status_code=204)


@router.delete("/me/memory", status_code=204)
def forget_all(request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        conn.execute("DELETE FROM memory_items WHERE user_id=?", (user.id,))
    changed(request, user.id, ["settings"])
    return Response(status_code=204)


@router.get("/notifications")
def notifications(request: Request, user: User, limit: Annotated[int, Query(ge=0)] = 50):
    with request.app.state.db.transaction() as conn:
        rows = conn.execute("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?", (user.id, limit)).fetchall()
        unread = conn.execute("SELECT count(*) FROM notifications WHERE user_id=? AND read_at IS NULL", (user.id,)).fetchone()[0]
    return {"items": [notification_view(row, user.timezone) for row in rows], "unread": unread}


@router.post("/notifications/read")
def read_notifications(body: NotificationsRead, request: Request, user: User):
    with request.app.state.db.transaction(write=True) as conn:
        timestamp = utc_now().isoformat()
        if body.ids is None:
            conn.execute("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL", (timestamp, user.id))
        else:
            for notification_id in body.ids:
                row = conn.execute("SELECT id FROM notifications WHERE id=? AND user_id=?", (notification_id, user.id)).fetchone()
                if row is None:
                    raise ApiError(404, "not_found", "通知不存在")
            conn.executemany("UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL",
                             [(timestamp, notification_id, user.id) for notification_id in body.ids])
        unread = conn.execute("SELECT count(*) FROM notifications WHERE user_id=? AND read_at IS NULL", (user.id,)).fetchone()[0]
    changed(request, user.id, ["notifications"])
    return {"unread": unread}
