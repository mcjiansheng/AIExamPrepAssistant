import struct
import zlib
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Annotated, Literal
from urllib.parse import parse_qsl, urlsplit
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field, field_validator
from starlette.responses import JSONResponse

from . import courses, plans
from .auth import Body, Principal, new_id, principal, require_member
from .db import dump, load, local_iso, utc_now
from .errors import ApiError, not_found
from .events import changed
from .idempotency import run
from .jobs import today_tokens
from .model_runtime import Model, OutputError, ProviderFailure, ROLES, RetryLater, JobFailure, binding, legacy_model

router = APIRouter()
Role = Literal["chat", "organize", "generate", "vision"]
Key = Annotated[str, Field(min_length=1)]


def valid_url(value):
    base = value[:-1] if value.endswith("#") else value
    url = urlsplit(base)
    sensitive = {"key", "api_key", "api-key", "token", "access_token", "authorization"}
    if url.scheme not in {"https", "http"} or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError("接口地址须为 HTTP 或 HTTPS，密钥填在密钥栏")
    if any(name.casefold() in sensitive for name, _ in parse_qsl(url.query)):
        raise ValueError("密钥请填在密钥栏")
    return value


class PresetInput(Body):
    preset_id: str
    key: Key


class CustomInput(Body):
    name: Annotated[str, Field(min_length=1)]
    protocol: Literal["openai"]
    base_url: str
    key: Key
    model: str | None = None
    _url = field_validator("base_url")(valid_url)


class ConnectionPatch(Body):
    key: Key = None
    name: Annotated[str, Field(min_length=1)] = None
    base_url: str = None
    _url = field_validator("base_url")(valid_url)


class Binding(Body):
    connection_id: str
    model: Annotated[str, Field(min_length=1)]


class ModelsPatch(Body):
    roles: dict[Role, Binding | None] = Field(default_factory=dict)


class LimitsPatch(Body):
    confirm_tokens: Annotated[int, Field(ge=1)] = None
    daily_tokens: Annotated[int, Field(ge=1)] | None = None


class EstimateIngest(Body):
    op: Literal["ingest"]
    course_id: str
    material_ids: list[str]


class EstimateSession(Body):
    op: Literal["session"]
    kind: Literal["quick", "kp", "review", "mistakes", "mock"]
    course_id: str | None = None
    count: Annotated[int, Field(ge=0)]


def connection(conn, user, cid, mock):
    row = conn.execute(
        """SELECT * FROM provider_connections WHERE id=? AND user_id=? AND (mock_only=0 OR ?)""",
        (cid, user.id, mock),
    ).fetchone()
    if row is None:
        raise not_found("模型连接")
    return row


def view(row, timezone):
    return {
        key: row[key] for key in ("id", "preset_id", "name", "protocol", "base_url", "key_last4", "status", "status_message")
    } | {
        "checked_at": local_iso(row["checked_at"], timezone) if row["checked_at"] else None,
        "capabilities": load(row["capabilities"]), "models": load(row["models"]),
    }


def last_four(key):
    return key[-4:] if len(key) > 4 else "••••"


def create_connection(conn, app, user, body, *, mock_only=False):
    cid = new_id("pv")
    if isinstance(body, PresetInput):
        preset = app.state.presets.get(body.preset_id)
        if preset is None:
            raise not_found("服务商预设")
        preset_id, name, protocol, url, default = (preset[key] for key in ("id", "name", "protocol", "base_url", "default_model"))
        models = [item["id"] for item in preset["models"]]
    else:
        preset_id, name, protocol, url, default = None, body.name, body.protocol, body.base_url, body.model
        models = [default] if default else []
    key_data = app.state.vault.encrypt(conn, user.id, cid, body.key)
    conn.execute(
        """INSERT INTO provider_connections
           (id,user_id,preset_id,name,protocol,base_url,key_ciphertext,key_last4,default_model,models,mock_only)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (cid, user.id, preset_id, name, protocol, url, key_data, last_four(body.key), default, dump(models), mock_only),
    )
    return connection(conn, user, cid, app.state.mock_model)


def models_view(conn, user, mock):
    roles = dict.fromkeys(ROLES)
    for row in conn.execute(
        """SELECT r.role,r.connection_id,r.model FROM model_roles r
           JOIN provider_connections c ON c.id=r.connection_id
           WHERE r.user_id=? AND (c.mock_only=0 OR ?)""", (user.id, mock),
    ):
        roles[row["role"]] = {"connection_id": row["connection_id"], "model": row["model"]}
    return {"roles": roles, "ocr": "builtin", "speech": "disabled"}


def bind(conn, user_id, role, cid, model):
    conn.execute(
        """INSERT INTO model_roles(user_id,role,connection_id,model) VALUES (?,?,?,?)
           ON CONFLICT(user_id,role) DO UPDATE SET connection_id=excluded.connection_id,model=excluded.model""",
        (user_id, role, cid, model),
    )


def bind_defaults(conn, user, row, caps, default, mock):
    if not any(models_view(conn, user, mock)["roles"].values()):
        for role in ROLES:
            if role != "vision" or caps["vision"]:
                bind(conn, user.id, role, row["id"], default)


def notify(request, user):
    request.app.state.events.publish(user.id, changed(["providers"]))


def check_step(key, ok, message=None):
    return {"id": key, "ok": ok, "message": message}


def red_square():
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))
    raw = (b"\x00" + b"\xff\x00\x00" * 16) * 16
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", 16, 16, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def mock_check(model, row, metadata, names):
    key = model.key().casefold()
    if any(word in key for word in ("bad", "invalid", "wrong")):
        raise ProviderFailure("密钥无效或没有权限，请更新密钥", "invalid")
    if any(word in key for word in ("quota", "empty")):
        raise ProviderFailure("服务商余额不足，请充值或换一个服务商", "limited")
    tools = row["protocol"] != "longcat"
    vision = bool(metadata and metadata["vision"])
    caps = {"chat": True, "json": True, "tools": tools, "vision": vision, "stream": True,
            "context_k": metadata["context_k"] if metadata else None}
    return (
        [check_step("connect", True), check_step("models", True), check_step("json", True),
         check_step("tools", tools, None if tools else "这个连接使用 JSON 意图"),
         check_step("vision", vision, None if vision else "当前模型不能看图")], caps, names,
    )


def live_check(model, row, metadata, names):
    model.complete("check_connect", "只回复 OK。", "连接检查")
    steps = [check_step("connect", True)]
    try:
        listed = model.request("check_models", "models", optional=True)
        if listed is not None and isinstance(listed.get("data"), list):
            names = list(dict.fromkeys(names + [item["id"] for item in listed["data"] if isinstance(item.get("id"), str)]))
    except ProviderFailure:
        raise
    except (JobFailure, RetryLater) as error:
        return steps + [check_step("models", False, str(error))], None, names
    if not names:
        return steps + [check_step("models", False, "服务商没有返回可用模型，请手动填写模型")], None, names
    steps.append(check_step("models", True))
    try:
        raw = model.complete("check_json", '只返回 JSON 对象 {"ok": true}。', "格式检查")
        json_ok = legacy_model.parse_json(raw) == {"ok": True}
    except ProviderFailure:
        raise
    except (ValueError, JobFailure, RetryLater):
        json_ok = False
    steps.append(check_step("json", json_ok, None if json_ok else "模型未返回预期 JSON"))
    tools_ok = False
    if row["protocol"] != "longcat":
        try:
            tools_ok = model.tool_intent("调用 ping，不要输出正文。", {"input": "ping"}, [
                {"name": "ping", "description": "无副作用的连接检查", "parameters": {"type": "object", "properties": {}}},
            ]) == {"tool": "ping", "params": {}}
        except ProviderFailure:
            raise
        except (KeyError, IndexError, TypeError, OutputError, JobFailure, RetryLater):
            tools_ok = False
    steps.append(check_step("tools", tools_ok, None if tools_ok else "这个连接使用 JSON 意图"))
    try:
        vision = "red" in model.complete("check_vision", "Reply with the predominant color in one English word.",
                                         "What color is the image?", [red_square()]).casefold()
    except ProviderFailure:
        raise
    except (JobFailure, RetryLater):
        vision = False
    steps.append(check_step("vision", vision, None if vision else "当前模型不能看图"))
    return steps, {"chat": True, "json": json_ok, "tools": tools_ok, "vision": vision, "stream": False,
                   "context_k": metadata["context_k"] if metadata else None}, names


def check_connection(conn_row, app, user):
    default = conn_row["default_model"]
    names = load(conn_row["models"])
    preset = app.state.presets.get(conn_row["preset_id"])
    metadata = next((item for item in preset["models"] if item["id"] == default), None) if preset else None
    model = Model(app, conn_row, default, "chat")
    caps = None
    status = "limited"
    try:
        if default is None:
            listing = model.request("check_models", "models", optional=True) if not app.state.mock_model else None
            names = [row["id"] for row in listing.get("data", [])] if listing else names
            if not names:
                raise JobFailure("请填写要使用的模型名称", True)
            default = names[0]
            model.model = default
        check = mock_check if app.state.mock_model else live_check
        steps, caps, names = check(model, conn_row, metadata, names)
        note = None if caps else steps[-1]["message"]
        status = "ok" if caps else "limited"
    except ProviderFailure as error:
        status, note = error.status, str(error)
        steps = [check_step("connect", False, note)]
    except (JobFailure, RetryLater) as error:
        note = str(error)
        steps = [check_step("connect", False, note)]
    with app.state.db.transaction(write=True) as conn:
        current = connection(conn, user, conn_row["id"], app.state.mock_model)
        if current["key_ciphertext"] != conn_row["key_ciphertext"] or current["base_url"] != conn_row["base_url"]:
            return {"connection": view(current, user.timezone), "steps": steps}
        conn.execute(
            """UPDATE provider_connections SET status=?,status_message=?,checked_at=?,capabilities=?,models=?,default_model=?
               WHERE id=?""",
            (status, note, utc_now().isoformat(), dump(caps) if caps else None, dump(names), default, conn_row["id"]),
        )
        current = connection(conn, user, conn_row["id"], app.state.mock_model)
        if caps is not None:
            bind_defaults(conn, user, current, caps, default, app.state.mock_model)
            from .pipeline import release_waiting
            release_waiting(conn, app, user)
        return {"connection": view(current, user.timezone), "steps": steps}


def limits(conn, user):
    row = conn.execute("SELECT confirm_tokens,daily_tokens FROM model_limits WHERE user_id=?", (user.id,)).fetchone()
    return dict(row) | {"today_tokens": today_tokens(conn, user)}


def estimate(conn, app, user, op, units):
    role = "organize" if op == "ingest" else "generate"
    base = 3000 if op == "ingest" else 10000
    kind = "ingest" if op == "ingest" else "session"
    history = conn.execute(
        """SELECT SUM(input_tokens+output_tokens) AS tokens FROM model_usage WHERE user_id=? AND job_id IN (
                SELECT id FROM jobs WHERE user_id=? AND kind=? AND status='done'
           )""", (user.id, user.id, kind),
    ).fetchone()
    recorded = conn.execute(
        """SELECT SUM(CAST(json_extract(payload,'$.units') AS INTEGER)) FROM jobs
           WHERE user_id=? AND kind=? AND status='done'""", (user.id, kind),
    ).fetchone()[0]
    if recorded and history["tokens"]:
        base = history["tokens"] / recorded
    low, high = round(base * units * 0.6), round(base * units * 1.4)
    row = binding(conn, user.id, role, app.state.mock_model)
    costs = []
    for count in (low, high):
        if row is None:
            costs.append(None)
        else:
            from .model_runtime import cost_of
            output = round(count * 0.3)
            costs.append(cost_of(app.state.presets, row, row["model"], count - output, output))
    threshold = conn.execute("SELECT confirm_tokens FROM model_limits WHERE user_id=?", (user.id,)).fetchone()[0]
    return {"tokens_min": low, "tokens_max": high, "cost_min": costs[0], "cost_max": costs[1],
            "needs_confirm": (low + high) / 2 > threshold}


def tally(rows):
    cost = sum(row["cost"] for row in rows) if rows and all(row["cost"] is not None for row in rows) else None
    return {"tokens_in": sum(row["input_tokens"] for row in rows), "tokens_out": sum(row["output_tokens"] for row in rows),
            "cost": round(cost, 8) if cost is not None else None}


def usage_view(conn, user, period):
    zone = ZoneInfo(user.timezone)
    today = plans.local_today(user)
    start = today - timedelta(days=6 if period == "week" else 29)
    from_utc = datetime.combine(start, datetime.min.time(), zone).astimezone(ZoneInfo("UTC")).isoformat()
    rows = conn.execute(
        """SELECT u.*,c.name AS course_name FROM model_usage u LEFT JOIN courses c ON c.id=u.course_id
           WHERE u.user_id=? AND u.created_at>=? ORDER BY u.created_at DESC,u.id""", (user.id, from_utc),
    ).fetchall()
    features, courses_, plugins, days = [defaultdict(list) for _ in range(4)]
    for row in rows:
        features[row["feature"]].append(row)
        if row["course_name"] is not None:
            courses_[(row["course_id"], row["course_name"])].append(row)
        if row["plugin_id"] is not None:
            plugins[row["plugin_id"]].append(row)
        on = datetime.fromisoformat(row["created_at"]).astimezone(zone).date().isoformat()
        days[on].append(row)
    return {
        "period": period, "from": str(start), "to": str(today), "total": tally(rows),
        "by_feature": [{"feature": key, **tally(value)} for key, value in features.items()],
        "by_course": [{"course_id": key[0], "name": key[1], **tally(value)} for key, value in courses_.items()],
        "by_plugin": [{"plugin_id": key, "name": key, **tally(value)} for key, value in plugins.items()],
        "daily": [{"date": str(day), "tokens": sum(row["input_tokens"] + row["output_tokens"] for row in days[str(day)])}
                  for day in plans.date_span(start, (today - start).days + 1)],
        "recent": [{"id": row["id"], "label": row["label"] or row["feature"], "course_name": row["course_name"],
                    "tokens": row["input_tokens"] + row["output_tokens"], "cost": row["cost"],
                    "created_at": local_iso(row["created_at"], user.timezone)} for row in rows[:20]],
    }


@router.get("/providers/presets")
def presets(request: Request):
    return list(request.app.state.presets.values())


@router.get("/me/providers")
def read_connections(request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        return [view(row, user.timezone) for row in conn.execute(
            "SELECT * FROM provider_connections WHERE user_id=? AND (mock_only=0 OR ?) ORDER BY rowid",
            (user.id, request.app.state.mock_model),
        )]


@router.post("/me/providers")
def add_provider(body: PresetInput | CustomInput, request: Request, user: Principal = Depends(principal)):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        status, result = run(conn, request, user, lambda: (
            200, view(create_connection(conn, request.app, user, body), user.timezone),
        ))
    notify(request, user)
    return JSONResponse(result, status_code=status)


@router.patch("/me/providers/{cid}")
def patch_provider(cid: str, body: ConnectionPatch, request: Request, user: Principal = Depends(principal)):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        previous = connection(conn, user, cid, request.app.state.mock_model)
        updates = body.model_dump(exclude_unset=True)
        if "key" in updates:
            key = updates.pop("key")
            updates["key_ciphertext"] = request.app.state.vault.encrypt(conn, user.id, cid, key)
            updates["key_last4"] = last_four(key)
        if "key_ciphertext" in updates or ("base_url" in updates and updates["base_url"] != previous["base_url"]):
            updates.update(status="unchecked", status_message=None, checked_at=None, capabilities=None)
        if updates:
            assignments = ",".join(f"{column}=?" for column in updates)
            conn.execute(f"UPDATE provider_connections SET {assignments} WHERE id=?", (*updates.values(), cid))
        result = view(connection(conn, user, cid, request.app.state.mock_model), user.timezone)
    notify(request, user)
    return result


@router.delete("/me/providers/{cid}", status_code=204)
def delete_provider(cid: str, request: Request, user: Principal = Depends(principal)):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        connection(conn, user, cid, request.app.state.mock_model)
        conn.execute("DELETE FROM provider_connections WHERE user_id=? AND id=?", (user.id, cid))
    notify(request, user)
    return Response(status_code=204)


@router.post("/me/providers/{cid}/check")
def test_provider(cid: str, request: Request, user: Principal = Depends(principal)):
    require_member(user)
    with request.app.state.db.transaction() as conn:
        row = connection(conn, user, cid, request.app.state.mock_model)
    result = check_connection(row, request.app, user)
    notify(request, user)
    return result


@router.get("/me/models")
def read_models(request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        return models_view(conn, user, request.app.state.mock_model)


@router.put("/me/models")
def set_models(body: ModelsPatch, request: Request, user: Principal = Depends(principal)):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        for role, target in body.roles.items():
            if target is None:
                conn.execute("DELETE FROM model_roles WHERE user_id=? AND role=?", (user.id, role))
            else:
                connection(conn, user, target.connection_id, request.app.state.mock_model)
                bind(conn, user.id, role, target.connection_id, target.model)
        from .pipeline import release_waiting
        release_waiting(conn, request.app, user)
        result = models_view(conn, user, request.app.state.mock_model)
    notify(request, user)
    return result


@router.get("/me/usage")
def usage(request: Request, period: Literal["week", "month"] = "week", user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        return usage_view(conn, user, period)


@router.get("/me/limits")
def read_limits(request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        return limits(conn, user)


@router.put("/me/limits")
def set_limits(body: LimitsPatch, request: Request, user: Principal = Depends(principal)):
    require_member(user)
    updates = body.model_dump(exclude_unset=True)
    with request.app.state.db.transaction(write=True) as conn:
        if updates:
            assignments = ",".join(f"{name}=?" for name in updates)
            conn.execute(f"UPDATE model_limits SET {assignments} WHERE user_id=?", (*updates.values(), user.id))
        return limits(conn, user)


@router.post("/estimate")
def read_estimate(body: EstimateIngest | EstimateSession, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        if body.course_id is not None:
            courses.course(conn, user.id, body.course_id)
        if isinstance(body, EstimateIngest):
            units = 0
            for mid in dict.fromkeys(body.material_ids):
                row = conn.execute("SELECT pages FROM materials WHERE id=? AND user_id=? AND course_id=?",
                                   (mid, user.id, body.course_id)).fetchone()
                if row is None:
                    raise not_found("资料")
                units += row["pages"] or 1
        else:
            units = body.count
        return estimate(conn, request.app, user, body.op, units)
