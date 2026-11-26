import logging
import os
import sqlite3
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, JSONResponse

from . import accounts, auth, courses, demo, events, focus, jobs, learning, materials, pipeline, plans, practice, providers, undo
from .db import Database, dump, load, utc_now
from .errors import ApiError, not_found
from .vault import KeyVault

ROOT = Path(__file__).resolve().parents[2]
logger = logging.getLogger("fullgrid.http")
LOG_PATHS = {
    "GET": "/api/v1/auth/qr/{id}",
    "POST": "/api/v1/auth/qr/{id}/action",
}


def exception_chain(error):
    errors = []
    while error is not None and all(current is not error for current, _ in errors):
        detail = {
            "exception": type(error).__name__,
            "stack": "".join(traceback.format_list(traceback.extract_tb(error.__traceback__))),
        }
        if isinstance(error, sqlite3.Error):
            detail["message"] = str(error)
        errors.append((error, detail))
        error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
    return [detail for _, detail in errors]


class RequestLog:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid4().hex
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        started = time.monotonic()
        status = None

        async def wrap_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
            await send(message)

        method = scope["method"]
        path = scope["path"]
        if path.startswith("/api/v1/auth/qr/"):
            path = LOG_PATHS.get(method, "/api/v1/auth/qr/{id}")
        try:
            await self.app(scope, receive, wrap_send)
        except Exception as error:
            logger.error(dump({
                "event": "internal", "request_id": request_id, "errors": exception_chain(error),
            }))
            if status is None:
                reply = ApiError(500, "internal", "服务暂时没有完成这次操作，请稍后重试")
                await JSONResponse(reply.body, status_code=reply.status)(scope, receive, wrap_send)
        finally:
            logger.info(dump({
                "event": "request", "request_id": request_id, "user_id": state.get("user_id"),
                "method": method, "path": path, "status": status,
                "elapsed_ms": round((time.monotonic() - started) * 1000, 1),
            }))


def initialize_courses(conn, user_id, kind):
    conn.execute(
        "INSERT INTO chat_threads (id,user_id,title,kind,updated_at) VALUES (?,?,'全局','global',?)",
        (auth.new_id("th"), user_id, utc_now().isoformat()),
    )
    demo.seed_user(conn, user_id, kind)


def seed_demo_provider(conn, app, user_id):
    if not app.state.mock_model:
        return
    row = conn.execute("SELECT timezone,guest FROM users WHERE id=?", (user_id,)).fetchone()
    user = auth.Principal(user_id, "", row["timezone"], bool(row["guest"]))
    item = providers.create_connection(
        conn, app, user, providers.PresetInput(preset_id="deepseek", key="fullgrid-demo-only"), mock_only=True,
    )
    caps = {"chat": True, "json": True, "tools": True, "vision": False, "stream": True, "context_k": 128}
    conn.execute("UPDATE provider_connections SET status='ok',capabilities=?,checked_at=? WHERE id=?",
                 (dump(caps), utc_now().isoformat(), item["id"]))
    providers.bind_defaults(conn, user, item, caps, item["default_model"], True)


def initialize_user(conn, user_id, kind, app):
    conn.execute("INSERT INTO model_limits (user_id) VALUES (?)", (user_id,))
    initialize_courses(conn, user_id, kind)
    if kind == "demo":
        demo.seed_study(conn, user_id)
        seed_demo_provider(conn, app, user_id)


def initialize_existing_courses(conn, sms_mode):
    for user in conn.execute("SELECT id, phone, guest FROM users").fetchall():
        if user["guest"]:
            kind = "guest"
        elif sms_mode == "dev" and user["phone"] == "13800000000":
            kind = "demo"
        else:
            kind = "new"
        initialize_courses(conn, user["id"], kind)


def initialize_existing_study(conn, sms_mode):
    if sms_mode == "dev":
        found = conn.execute("SELECT id FROM users WHERE phone=?", ("13800000000",)).fetchone()
        if found is not None:
            demo.seed_study(conn, found["id"])


def create_app(*, data_dir=None, mock_model=False, sms_mode=None, client_dir=None, worker_enabled=True):
    base = Path(data_dir or os.environ.get("FULLGRID_DATA_DIR", ROOT / "local" / "data"))
    dist = Path(client_dir or ROOT / "client" / "dist").resolve()

    @asynccontextmanager
    async def serving(app):
        worker = pipeline.Worker(app) if worker_enabled else None
        if worker is not None:
            worker.start()
        try:
            yield
        finally:
            if worker is not None:
                worker.close()

    app = FastAPI(title="满格 API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=serving)
    sms_mode = sms_mode or os.environ.get("SMS_MODE", "dev")
    app.state.mock_model = mock_model
    app.state.vault = KeyVault(base / "v1")
    app.state.presets = {item["id"]: item for item in load(demo.FIXTURE.read_text(encoding="utf-8"))["presets"]}
    app.state.ocr_engine = None

    def add_demo_provider(conn):
        row = conn.execute("SELECT id FROM users WHERE phone=?", ("13800000000",)).fetchone()
        if row is not None and sms_mode == "dev":
            seed_demo_provider(conn, app, row["id"])

    app.state.db = Database(
        base / "v1.sqlite", data_migrations={
            4: lambda conn: initialize_existing_courses(conn, sms_mode),
            5: lambda conn: initialize_existing_study(conn, sms_mode),
            6: add_demo_provider,
        },
    )
    app.state.data_dir = base
    app.state.mock_model = mock_model
    app.state.sms_mode = sms_mode
    app.state.initialize_user = lambda conn, user_id, kind: initialize_user(conn, user_id, kind, app)
    app.state.events = events.EventBus()
    app.add_middleware(RequestLog)

    @app.exception_handler(ApiError)
    async def api_error(request: Request, error: ApiError):
        return JSONResponse(error.body, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def bad_body(request: Request, error: RequestValidationError):
        # Validation input can contain credentials and file names.
        errors = error.errors()
        field = ".".join(str(part) for part in errors[0]["loc"][1:])
        message = f"请检查字段 {field}" if field else "请求内容格式不正确"
        return await api_error(request, ApiError(400, "bad_request", message))

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        reply = not_found("接口") if error.status_code == 404 else ApiError(400, "bad_request", "请求方式不正确")
        return await api_error(request, reply)

    @app.get("/api/v1/health")
    def health():
        return {"ok": True, "version": "1.0", "capabilities": {"ocr": True, "speech": False}, "sms": app.state.sms_mode}

    for module in (auth, accounts, jobs, undo, events, courses, materials, focus, plans, learning, practice, providers, pipeline):
        app.include_router(module.router, prefix="/api/v1")

    @app.get("/{path:path}", include_in_schema=False)
    def client(path: str):
        if path == "api" or path.startswith("api/"):
            raise not_found("接口")
        target = (dist / path).resolve()
        if not target.is_relative_to(dist):
            raise not_found("页面")
        if not target.is_file():
            target = dist / "index.html"
        if not target.is_file():
            raise not_found("页面")
        return FileResponse(target)

    return app
