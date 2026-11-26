"""Phone, guest and device authentication for the v1 API."""

import hashlib
import logging
import math
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .db import dump, local_iso, utc_now
from .errors import ApiError


router = APIRouter()
ACCESS_SECONDS = 15 * 60
REFRESH_SECONDS = 30 * 24 * 60 * 60
SMS_SECONDS = 5 * 60
QR_SECONDS = 120
SMS_TIMEZONE = ZoneInfo("America/Los_Angeles")
Phone = Annotated[str, Field(pattern=r"^1[0-9]{10}$")]
Token = Annotated[str, Field(min_length=1, max_length=512)]
sms_logger = logging.getLogger("fullgrid.sms")


class Body(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class DeviceInfo(Body):
    kind: Literal["phone", "tablet", "desktop", "browser"]
    name: Annotated[str, Field(min_length=1, max_length=200)]
    timezone: str

    @field_validator("timezone")
    @classmethod
    def timezone_exists(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("时区名称不正确") from None
        return value


class SmsInput(Body):
    phone: Phone


class LoginInput(SmsInput):
    code: Annotated[str, Field(pattern=r"^[0-9]{6}$")]
    device: DeviceInfo


class DeviceInput(Body):
    device: DeviceInfo


class HuaweiInput(DeviceInput):
    auth_code: Annotated[str, Field(min_length=1, max_length=512)]


class RefreshInput(Body):
    refresh_token: Token


@dataclass(frozen=True)
class Principal:
    id: str
    device_id: str
    timezone: str
    guest: bool


def token_hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def new_id(prefix):
    return f"{prefix}_{secrets.token_hex(16)}"


def user_view(row):
    phone = row["phone"]
    timezone = row["timezone"]
    deletion_at = row["deletion_at"]
    return {
        "id": row["id"],
        "nickname": row["nickname"],
        "avatar_url": row["avatar_url"],
        "phone_masked": f"{phone[:3]}****{phone[-4:]}" if phone else None,
        "guest": bool(row["guest"]),
        "school": row["school"],
        "major": row["major"],
        "timezone": timezone,
        "onboarding": {"ai": row["onboard_ai"], "course": row["onboard_course"]},
        "deletion_at": local_iso(deletion_at, timezone) if deletion_at else None,
        "created_at": local_iso(row["created_at"], timezone),
    }


def require_member(user):
    if user.guest:
        raise ApiError(403, "login_required", "登录后就能保存自己的内容")


def revoke_device(db, device_id, now):
    stamp = now.isoformat()
    db.execute("UPDATE devices SET revoked_at = ? WHERE id = ?", (stamp, device_id))
    db.execute("UPDATE auth_tokens SET revoked_at = ? WHERE device_id = ?", (stamp, device_id))


def authenticate(request, token):
    now = utc_now()
    with request.app.state.db.transaction(write=True) as db:
        row = db.execute(
            """SELECT u.id, u.timezone, u.guest, d.id AS device_id
               FROM auth_tokens t
               JOIN devices d ON d.id = t.device_id
               JOIN users u ON u.id = d.user_id
               WHERE t.token_hash = ? AND t.kind = 'access'
                 AND t.expires_at > ? AND t.revoked_at IS NULL
                 AND d.revoked_at IS NULL""",
            (token_hash(token), now.isoformat()),
        ).fetchone()
        if row is None:
            raise ApiError(401, "unauthorized", "登录已过期，请重新登录")
        db.execute("UPDATE devices SET last_seen = ? WHERE id = ?", (now.isoformat(), row["device_id"]))
        db.execute("UPDATE users SET last_active = ? WHERE id = ?", (now.isoformat(), row["id"]))
    request.state.user_id = row["id"]
    return Principal(row["id"], row["device_id"], row["timezone"], bool(row["guest"]))


def principal(request: Request):
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise ApiError(401, "unauthorized", "请先登录")
    return authenticate(request, token)


def create_user(db, phone, device, *, kind):
    """The caller initializes the user's settings and course seed in this transaction."""
    now = utc_now().isoformat()
    guest = kind == "guest"
    demo = kind == "demo"
    nickname = "访客" if guest else "林同学" if demo else f"同学{phone[-4:]}"
    onboarding = "skipped" if guest else "done" if demo else None
    user_id = new_id("u")
    db.execute(
        """INSERT INTO users (
               id, phone, nickname, avatar_url, school, major, timezone, guest,
               onboard_ai, onboard_course, deletion_at, created_at, last_active
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)""",
        (user_id, phone, nickname, "示例大学" if demo else None,
         "计算机科学与技术" if demo else None, device.timezone, int(guest),
         onboarding, onboarding, now, now),
    )
    if phone:
        db.execute("INSERT INTO identities (user_id, kind, external_id) VALUES (?, 'phone', ?)", (user_id, phone))
    return db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def issue_tokens(db, user, device_id, *, is_new):
    now = utc_now()
    access = secrets.token_urlsafe(32)
    refresh = secrets.token_urlsafe(32)
    db.executemany(
        """INSERT INTO auth_tokens
           (token_hash, kind, device_id, issued_at, expires_at, used_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL)""",
        [(token_hash(access), "access", device_id, now.isoformat(),
          (now + timedelta(seconds=ACCESS_SECONDS)).isoformat()),
         (token_hash(refresh), "refresh", device_id, now.isoformat(),
          (now + timedelta(seconds=REFRESH_SECONDS)).isoformat())],
    )
    return {"access_token": access, "refresh_token": refresh, "expires_in": ACCESS_SECONDS,
            "user": user_view(user), "is_new": is_new}


def issue_device(db, user, device, *, is_new):
    device_id = new_id("dv")
    db.execute(
        """INSERT INTO devices (id, user_id, kind, name, last_seen, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)""",
        (device_id, user["id"], device.kind, device.name, utc_now().isoformat()),
    )
    return issue_tokens(db, user, device_id, is_new=is_new)


def phone_user(request, db, phone, device):
    user = db.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
    is_new = user is None
    if is_new:
        kind = "demo" if request.app.state.sms_mode == "dev" and phone == "13800000000" else "new"
        user = create_user(db, phone, device, kind=kind)
        request.app.state.initialize_user(db, user["id"], kind)
    else:
        db.execute(
            "UPDATE users SET timezone = ?, deletion_at = NULL, last_active = ? WHERE id = ?",
            (device.timezone, utc_now().isoformat(), user["id"]),
        )
        user = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    return user, is_new


def rate_limited(message, retry_after):
    return ApiError(429, "rate_limited", message, detail={"retry_after_sec": max(1, math.ceil(retry_after))})


@router.post("/auth/sms")
def send_sms(body: SmsInput, request: Request):
    if request.app.state.sms_mode != "dev":
        raise ApiError(409, "conflict", "真实短信网关尚未接入，配置短信网关后可发送验证码")
    now = utc_now()
    midnight = now.astimezone(SMS_TIMEZONE).replace(hour=0, minute=0, second=0, microsecond=0)
    start = midnight.astimezone(now.tzinfo).isoformat()
    code = f"{secrets.randbelow(1_000_000):06d}"
    salt = secrets.token_hex(16)
    with request.app.state.db.transaction(write=True) as db:
        latest = db.execute(
            "SELECT created_at FROM sms_challenges WHERE phone = ? ORDER BY created_at DESC LIMIT 1",
            (body.phone,),
        ).fetchone()
        if latest:
            wait = 60 - (now - datetime.fromisoformat(latest["created_at"])).total_seconds()
            if wait > 0:
                raise rate_limited(f"{math.ceil(wait)} 秒后可以重发", wait)
        count = db.execute(
            "SELECT COUNT(*) FROM sms_challenges WHERE phone = ? AND created_at >= ?",
            (body.phone, start),
        ).fetchone()[0]
        if count >= 10:
            next_day = midnight + timedelta(days=1)
            wait = (next_day.astimezone(now.tzinfo) - now).total_seconds()
            raise rate_limited("今天的验证码发送次数已用完，明天再试", wait)
        db.execute(
            """INSERT INTO sms_challenges
               (id, phone, code_hash, salt, created_at, expires_at, consumed_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL)""",
            (new_id("sms"), body.phone, token_hash(f"{salt}:{code}"), salt,
             now.isoformat(), (now + timedelta(seconds=SMS_SECONDS)).isoformat()),
        )
    # The dev SMS channel explicitly exposes the code in its response and log.
    sms_logger.info(dump({
        "event": "dev_sms", "phone_masked": f"{body.phone[:3]}****{body.phone[-4:]}", "dev_code": code,
    }))
    return {"cooldown_sec": 60, "dev_code": code}


@router.post("/auth/login")
def login(body: LoginInput, request: Request):
    now = utc_now()
    error = None
    with request.app.state.db.transaction(write=True) as db:
        lock = db.execute("SELECT * FROM login_limits WHERE phone = ?", (body.phone,)).fetchone()
        if lock and lock["locked_until"] and lock["locked_until"] > now.isoformat():
            wait = (datetime.fromisoformat(lock["locked_until"]) - now).total_seconds()
            raise rate_limited("错误次数太多，请稍后再试", wait)
        challenge = db.execute(
            "SELECT * FROM sms_challenges WHERE phone = ? ORDER BY created_at DESC LIMIT 1",
            (body.phone,),
        ).fetchone()
        matches = (challenge is not None and challenge["consumed_at"] is None
                   and challenge["expires_at"] > now.isoformat()
                   and secrets.compare_digest(challenge["code_hash"], token_hash(f"{challenge['salt']}:{body.code}")))
        if not matches:
            failures = lock["failures"] if lock and not lock["locked_until"] else 0
            failures += 1
            locked_until = (now + timedelta(minutes=10)).isoformat() if failures >= 5 else None
            db.execute(
                """INSERT INTO login_limits (phone, failures, locked_until) VALUES (?, ?, ?)
                   ON CONFLICT(phone) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until""",
                (body.phone, failures, locked_until),
            )
            message = "错误次数太多，请 10 分钟后再试" if failures >= 5 else f"验证码错误，还可以试 {5 - failures} 次"
            error = ApiError(400, "bad_request", message)
        else:
            db.execute("DELETE FROM login_limits WHERE phone = ?", (body.phone,))
            db.execute("UPDATE sms_challenges SET consumed_at = ? WHERE id = ?", (now.isoformat(), challenge["id"]))
            user, is_new = phone_user(request, db, body.phone, body.device)
            result = issue_device(db, user, body.device, is_new=is_new)
    # Commit failed-attempt counters before returning the HTTP error.
    if error:
        raise error
    return result


@router.post("/auth/guest")
def guest(body: DeviceInput, request: Request):
    with request.app.state.db.transaction(write=True) as db:
        user = create_user(db, None, body.device, kind="guest")
        request.app.state.initialize_user(db, user["id"], "guest")
        return issue_device(db, user, body.device, is_new=True)


@router.post("/auth/huawei")
def huawei(body: HuaweiInput, request: Request):
    prefix, separator, phone = body.auth_code.partition("-")
    if prefix != "dev" or not separator or len(phone) != 11 or not phone.startswith("1") or not phone.isascii() or not phone.isdigit():
        raise ApiError(400, "bad_request", "本版华为登录使用 dev-手机号 授权码")
    with request.app.state.db.transaction(write=True) as db:
        user, is_new = phone_user(request, db, phone, body.device)
        return issue_device(db, user, body.device, is_new=is_new)


@router.post("/auth/refresh")
def refresh(body: RefreshInput, request: Request):
    now = utc_now()
    error = None
    with request.app.state.db.transaction(write=True) as db:
        token = db.execute(
            """SELECT t.*, d.user_id, d.revoked_at AS device_revoked_at
               FROM auth_tokens t JOIN devices d ON d.id = t.device_id
               WHERE t.token_hash = ? AND t.kind = 'refresh'""",
            (token_hash(body.refresh_token),),
        ).fetchone()
        if token is None or token["device_revoked_at"] or token["revoked_at"]:
            raise ApiError(401, "unauthorized", "登录已过期，请重新登录")
        if token["used_at"]:
            revoke_device(db, token["device_id"], now)
            error = ApiError(401, "unauthorized", "登录凭据已被重复使用，请重新登录")
        elif token["expires_at"] <= now.isoformat():
            raise ApiError(401, "unauthorized", "登录已过期，请重新登录")
        else:
            db.execute("UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?", (now.isoformat(), token["token_hash"]))
            db.execute("UPDATE devices SET last_seen = ? WHERE id = ?", (now.isoformat(), token["device_id"]))
            user = db.execute("SELECT * FROM users WHERE id = ?", (token["user_id"],)).fetchone()
            result = issue_tokens(db, user, token["device_id"], is_new=False)
    # Revocation survives the rejected replay request.
    if error:
        raise error
    return result


@router.post("/auth/logout", status_code=204)
def logout(request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as db:
        revoke_device(db, user.device_id, utc_now())
    return Response(status_code=204)


@router.post("/auth/qr")
def new_qr(body: DeviceInput, request: Request):
    now = utc_now()
    expires = now + timedelta(seconds=QR_SECONDS)
    poll = secrets.token_urlsafe(32)
    scan = secrets.token_urlsafe(32)
    with request.app.state.db.transaction(write=True) as db:
        db.execute(
            """INSERT INTO qr_tickets
               (id, poll_hash, scan_hash, device_kind, device_name, timezone,
                status, user_id, created_at, expires_at, consumed_at)
               VALUES (?, ?, ?, ?, ?, ?, 'waiting', NULL, ?, ?, NULL)""",
            (new_id("qr"), token_hash(poll), token_hash(scan), body.device.kind,
             body.device.name, body.device.timezone, now.isoformat(), expires.isoformat()),
        )
    return {"id": poll, "payload": f"fullgrid://login?qr={scan}",
            "expires_at": local_iso(expires.isoformat(), body.device.timezone)}


@router.get("/auth/qr/{ticket_id}")
def poll_qr(ticket_id: str, request: Request):
    now = utc_now()
    with request.app.state.db.transaction(write=True) as db:
        ticket = db.execute("SELECT * FROM qr_tickets WHERE poll_hash = ?", (token_hash(ticket_id),)).fetchone()
        if ticket is None:
            raise ApiError(404, "not_found", "二维码不存在")
        if ticket["expires_at"] <= now.isoformat():
            return {"status": "expired", "tokens": None}
        tokens = None
        if ticket["status"] == "confirmed" and ticket["consumed_at"] is None:
            user = db.execute("SELECT * FROM users WHERE id = ?", (ticket["user_id"],)).fetchone()
            device = DeviceInfo(kind=ticket["device_kind"], name=ticket["device_name"], timezone=ticket["timezone"])
            db.execute("UPDATE users SET timezone = ?, deletion_at = NULL WHERE id = ?", (device.timezone, user["id"]))
            user = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
            tokens = issue_device(db, user, device, is_new=False)
            db.execute("UPDATE qr_tickets SET consumed_at = ? WHERE id = ?", (now.isoformat(), ticket["id"]))
        return {"status": ticket["status"], "tokens": tokens}


def scanned_ticket(db, credential, user):
    ticket = db.execute("SELECT * FROM qr_tickets WHERE scan_hash = ?", (token_hash(credential),)).fetchone()
    if ticket is None or ticket["user_id"] not in (None, user.id):
        raise ApiError(404, "not_found", "二维码不存在")
    if ticket["expires_at"] <= utc_now().isoformat():
        raise ApiError(409, "conflict", "二维码已过期，请刷新电脑上的二维码")
    return ticket


@router.post("/auth/qr/{ticket_id}/scan")
def scan_qr(ticket_id: str, request: Request, user: Principal = Depends(principal)):
    require_member(user)
    with request.app.state.db.transaction(write=True) as db:
        ticket = scanned_ticket(db, ticket_id, user)
        if ticket["status"] != "waiting":
            raise ApiError(409, "conflict", "二维码已经扫描过了")
        db.execute("UPDATE qr_tickets SET status = 'scanned', user_id = ? WHERE id = ?", (user.id, ticket["id"]))
        return {"device_name": ticket["device_name"]}


@router.post("/auth/qr/{ticket_id}/confirm")
def confirm_qr(ticket_id: str, request: Request, user: Principal = Depends(principal)):
    require_member(user)
    with request.app.state.db.transaction(write=True) as db:
        ticket = scanned_ticket(db, ticket_id, user)
        if ticket["status"] != "scanned":
            raise ApiError(409, "conflict", "请先扫描二维码")
        db.execute("UPDATE qr_tickets SET status = 'confirmed' WHERE id = ?", (ticket["id"],))
    return {"ok": True}
