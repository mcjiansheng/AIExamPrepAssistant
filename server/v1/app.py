import logging
import os
import sqlite3
import time
import traceback
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, JSONResponse

from . import accounts, auth, events, jobs, undo
from .db import Database, dump
from .errors import ApiError, not_found

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


def initialize_user(conn, user_id, kind):
    conn.execute("INSERT INTO model_limits (user_id) VALUES (?)", (user_id,))


def create_app(*, data_dir=None, mock_model=False, sms_mode=None, client_dir=None):
    base = Path(data_dir or os.environ.get("FULLGRID_DATA_DIR", ROOT / "local" / "data"))
    dist = Path(client_dir or ROOT / "client" / "dist").resolve()
    app = FastAPI(title="满格 API", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db = Database(base / "v1.sqlite")
    app.state.data_dir = base
    app.state.mock_model = mock_model
    app.state.sms_mode = sms_mode or os.environ.get("SMS_MODE", "dev")
    app.state.initialize_user = initialize_user
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
        return {"ok": True, "version": "1.0", "capabilities": {"ocr": False, "speech": False}, "sms": app.state.sms_mode}

    for module in (auth, accounts, jobs, undo, events):
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
