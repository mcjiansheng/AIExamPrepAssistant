"""Local HTTP entry point for API v0 and the WebUI."""
import argparse
import json
import logging
import re
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from core import App, ApiError, bad_request, fields, text
from materials import Materials
from focus import FocusService
from plan import Plans
from exams import Exams
from chat import ChatStream, StudyAssistant

ROOT = Path(__file__).resolve().parent.parent


def exam_date(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise bad_request("考试日期请用 YYYY-MM-DD")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise bad_request("考试日期不正确") from None


class Api:
    def __init__(self, app):
        self.app = app
        self.routes = []
        self.add("GET", "/health", self.health)
        self.add("GET", "/courses", self.courses)
        self.add("POST", "/courses", self.create_course, "json")
        self.add("GET", "/courses/([^/]+)", self.course)
        self.add("PATCH", "/courses/([^/]+)", self.update_course, "json")
        self.add("DELETE", "/courses/([^/]+)", self.delete_course)
        self.add("GET", "/jobs", self.jobs)
        self.add("GET", "/jobs/([^/]+)", self.job)
        self.add("POST", "/jobs/([^/]+)/retry", self.retry_job)

    def add(self, method, pattern, handler, body=None):
        self.routes.append((method, re.compile(pattern), handler, body))

    def health(self):
        return {"ok": True, "model": "LongCat-2.5", "mock_model": self.app.mock_model}

    def courses(self):
        with self.app.db() as db:
            rows = db.execute("SELECT * FROM courses ORDER BY exam_date IS NULL, exam_date, id")
            return [self.app.course_view(db, row) for row in rows]

    def course(self, cid):
        with self.app.db() as db:
            return self.app.course_view(db, self.app.course(db, cid))

    def create_course(self, body):
        fields(body, {"name"}, {"exam_date"})
        return self.app.create_course(text(body["name"], "课程名"), exam_date(body.get("exam_date")))

    def update_course(self, cid, body):
        fields(body, set(), {"name", "exam_date"})
        with self.app.db(write=True) as db:
            current = self.app.course(db, cid)
            name = text(body["name"], "课程名") if "name" in body else current["name"]
            when = exam_date(body["exam_date"]) if "exam_date" in body else current["exam_date"]
            db.execute("UPDATE courses SET name=?, exam_date=? WHERE id=?", (name, when, cid))
            return self.app.course_view(db, self.app.course(db, cid))

    def delete_course(self, cid):
        self.app.delete_course(cid)

    def jobs(self):
        with self.app.db() as db:
            return [self.app.job_view(row) for row in db.execute("SELECT * FROM jobs ORDER BY created_at DESC")]

    def job(self, jid):
        with self.app.db() as db:
            return self.app.job_view(self.app.job(db, jid))

    def retry_job(self, jid):
        return self.app.retry_job(jid)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def do_GET(self):
        self.dispatch()

    def do_HEAD(self):
        self.dispatch()

    do_POST = do_PUT = do_PATCH = do_DELETE = do_GET

    def dispatch(self):
        path = urlsplit(self.path).path
        self.streaming = False
        try:
            if path == "/api" or path.startswith("/api/"):
                self.dispatch_api(path.removeprefix("/api"))
            elif self.command == "GET":
                super().do_GET()
            elif self.command == "HEAD":
                super().do_HEAD()
            else:
                self.send_error(405)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except ApiError as error:
            self.send_json(error.payload, error.status)
        except Exception:
            logging.exception("HTTP request failed: %s %s", self.command, path)
            if self.streaming:
                self.send_event({"type": "error", "message": "助手处理请求时出错，请查看服务日志", "retryable": True})
            else:
                self.send_json({"error": {"code": "internal", "message": "服务处理请求时出错，请查看服务日志", "hint": None}}, 500)

    def dispatch_api(self, path):
        for method, pattern, handler, body_type in self.server.api.routes:
            match = pattern.fullmatch(path)
            if method != self.command or match is None:
                continue
            args = [unquote(value) for value in match.groups()]
            if body_type == "json":
                args.append(self.read_json())
            elif body_type:
                args.append(body_type(self.headers, self.read_body))
            result = handler(*args)
            if isinstance(result, ChatStream):
                self.send_stream(result)
            elif isinstance(result, bytes):
                self.send_content(result, "image/png")
            elif result is None:
                self.send_response(204)
                self.end_headers()
            else:
                self.send_json(result)
            return
        raise ApiError(404, "not_found", "接口不存在")

    def read_body(self, limit=None):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 0:
                raise ValueError
        except ValueError:
            raise bad_request("请求长度不正确") from None
        if limit is not None and size > limit:
            raise ApiError(413, "too_large", "上传文件超过大小上限")
        return self.rfile.read(size)

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise bad_request("请求体应为 JSON 对象")
        try:
            body = json.loads(self.read_body().decode("utf-8"))
        except (ValueError, UnicodeError):
            raise bad_request("JSON 格式不正确") from None
        if not isinstance(body, dict):
            raise bad_request("请求体应为 JSON 对象")
        return body

    def send_json(self, body, status=200):
        self.send_content(
            json.dumps(body, ensure_ascii=False, allow_nan=False).encode(),
            "application/json; charset=utf-8", status,
        )

    def send_event(self, event):
        self.wfile.write(json.dumps(event, ensure_ascii=False, allow_nan=False).encode() + b"\n")
        self.wfile.flush()

    def send_stream(self, stream):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.streaming = True
        try:
            for event in stream.iterator:
                self.send_event(event)
        finally:
            stream.iterator.close()

    def send_content(self, content, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)


class Server(ThreadingHTTPServer):
    def __init__(self, address, app):
        self.api = Api(app)
        materials = Materials(app, self.api)
        FocusService(app, self.api, materials)
        Plans(app, self.api)
        Exams(app, self.api)
        StudyAssistant(app, self.api)
        super().__init__(address, Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mock-model", action="store_true")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    app = App(ROOT / "local" / "data", args.mock_model)
    with Server(("127.0.0.1", args.port), app) as server:
        app.start_jobs()
        logging.info("WebUI http://127.0.0.1:%s", server.server_port)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
