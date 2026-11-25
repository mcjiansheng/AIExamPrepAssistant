"""SQLite storage and persistent background jobs shared by API services."""
import json
import logging
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date, datetime
from threading import Condition, Thread, local
from uuid import uuid4


def uid(prefix):
    return f"{prefix}_{uuid4().hex}"


def now():
    return datetime.now().astimezone().isoformat(timespec="microseconds")


class ApiError(Exception):
    def __init__(self, status, code, message, hint=None):
        super().__init__(message)
        self.status = status
        self.payload = {"error": {"code": code, "message": message, "hint": hint}}


def bad_request(message):
    return ApiError(400, "bad_request", message)


def not_found(label):
    return ApiError(404, "not_found", f"{label}不存在")


def conflict(message):
    return ApiError(409, "conflict", message)


def fields(body, required, optional=()):
    missing = required - body.keys()
    if missing:
        raise bad_request("缺少字段：" + "、".join(sorted(missing)))
    unknown = body.keys() - required - set(optional)
    if unknown:
        raise bad_request("不认识的字段：" + "、".join(sorted(unknown)))


def text(value, label, *, empty=False):
    if not isinstance(value, str) or not (empty or value.strip()):
        raise bad_request(f"{label}应为{'文字' if empty else '非空文字'}")
    return value if empty else value.strip()


def one_of(value, choices, label):
    if value not in choices:
        raise bad_request(f"{label}不在可选范围内")
    return value


def dump(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def load(value):
    return json.loads(value)


class JobFailure(Exception):
    """Expected job outcome that must be visible on its Job."""
    def __init__(self, message, retryable):
        super().__init__(message)
        self.retryable = retryable


class RetryLater(JobFailure):
    def __init__(self, message):
        super().__init__(message, True)


SCHEMA = """
CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    exam_date TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL,
    stage TEXT,
    error TEXT,
    target_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    retry_at REAL NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_course ON jobs(course_id, created_at);
"""


class App:
    def __init__(self, data_dir, mock_model):
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        self.mock_model = mock_model
        self.job_handlers = {}
        self.job_end_hooks = {}       # kind → 函数(job)；任务结束（done 或最终 failed）后调用
        self.job_retry_hooks = {}     # kind → 函数(db, job)；重试前准备（只重做失败的部分）
        self.transaction = local()
        self.job_signal = Condition()
        with sqlite3.connect(data_dir / "app.sqlite") as db:
            db.execute("PRAGMA journal_mode=WAL")
        db.close()
        with self.db() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def db(self, write=False):
        active = getattr(self.transaction, "db", None)
        if active is not None:
            yield active
            return
        db = sqlite3.connect(self.data_dir / "app.sqlite")
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        self.transaction.db = db
        self.transaction.callbacks = []
        try:
            with db:
                db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                yield db
            callbacks = self.transaction.callbacks
        finally:
            db.close()
            del self.transaction.db
            del self.transaction.callbacks
        for callback in callbacks:
            callback()

    def after_commit(self, work):
        if getattr(self.transaction, "db", None) is not None:
            self.transaction.callbacks.append(work)
        else:
            work()

    def course(self, db, cid):
        row = db.execute("SELECT * FROM courses WHERE id=?", (cid,)).fetchone()
        if row is None:
            raise not_found("课程")
        return row

    def create_course(self, name, exam_date):
        cid = uid("c")
        with self.db(write=True) as db:
            db.execute("INSERT INTO courses VALUES (?, ?, ?)", (cid, name, exam_date))
            return self.course_view(db, self.course(db, cid))

    def delete_course(self, cid):
        with self.db(write=True) as db:
            self.course(db, cid)
            documents = db.execute("SELECT material_id, ext FROM documents WHERE course=?", (cid,)).fetchall()
            db.execute("DELETE FROM courses WHERE id=?", (cid,))
        self.materials.delete_files(documents)

    def course_view(self, db, course):
        cid, when = course["id"], course["exam_date"]
        jobs = db.execute(
            "SELECT * FROM jobs WHERE course_id=? AND status IN ('queued','running','needs_input') ORDER BY created_at",
            (cid,),
        )
        active = [self.job_view(row) for row in jobs]
        material_states = {row["status"] for row in db.execute("SELECT status FROM documents WHERE course=?", (cid,))}
        pending_suggestion = db.execute(
            "SELECT 1 FROM suggestions WHERE course=? AND kind IN ('version','role') AND choice IS NULL LIMIT 1", (cid,),
        ).fetchone()
        material_step = "todo"
        if material_states & {"reading", "extracting"}:
            material_step = "doing"
        elif pending_suggestion or "failed" in material_states:
            material_step = "attention"
        elif "ready" in material_states:
            material_step = "done"
        focus = db.execute("SELECT * FROM focus WHERE course=?", (cid,)).fetchone()
        focus_step = "todo"
        if focus:
            job = self.job(db, focus["job_id"])
            focus_step = {"queued": "doing", "running": "doing", "failed": "attention",
                          "needs_input": "attention", "done": "done"}[job["status"]]
            if db.execute("SELECT 1 FROM suggestions WHERE course=? AND kind='focus_conflict' AND choice IS NULL", (cid,)).fetchone():
                focus_step = "attention"
        row = db.execute("SELECT value FROM plans WHERE course=?", (cid,)).fetchone()
        plan_step = "todo" if row is None else ("attention" if load(row["value"])["stale"] else "done")
        latest = db.execute("SELECT status FROM exams WHERE course=? ORDER BY created_at DESC LIMIT 1", (cid,)).fetchone()
        practice = "todo" if latest is None else {"generating": "doing", "ready": "doing", "finished": "done",
                                                  "failed": "attention"}[latest["status"]]
        return {
            "id": cid, "name": course["name"], "exam_date": when,
            "days_left": (date.fromisoformat(when) - date.today()).days if when else None,
            "steps": {"materials": material_step, "focus": focus_step, "plan": plan_step, "practice": practice},
            "next_step": "plan" if "ready" in material_states else "materials",
            "active_jobs": active,
        }

    @staticmethod
    def job_view(row):
        view = {key: row[key] for key in ("id", "kind", "status", "progress", "stage", "target_id", "created_at")}
        view["error"] = load(row["error"]) if row["error"] else None
        return view

    @staticmethod
    def job(db, jid):
        row = db.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
        if row is None:
            raise not_found("任务")
        return row

    def new_job(self, db, cid, kind, stage, payload, target_id=None):
        jid = uid("j")
        db.execute(
            """INSERT INTO jobs (id, course_id, kind, status, progress, stage, target_id, created_at, payload)
               VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)""",
            (jid, cid, kind, stage, target_id or cid, now(), dump(payload)),
        )
        return self.job(db, jid)

    def retry_job(self, jid):
        with self.db(write=True) as db:
            job = self.job(db, jid)
            if job["status"] == "failed" and load(job["error"])["retryable"]:
                if job["kind"] in self.job_retry_hooks:
                    self.job_retry_hooks[job["kind"]](db, job)
                db.execute("UPDATE jobs SET status='queued', error=NULL, retry_at=0, failures=0 WHERE id=?", (jid,))
            elif job["status"] not in ("queued", "running"):
                raise conflict("这项任务当前不能重试")
            result = self.job_view(self.job(db, jid))
        self.wake_jobs()
        return result

    def wake_jobs(self):
        self.after_commit(self.notify_jobs)

    def notify_jobs(self):
        with self.job_signal:
            self.job_signal.notify()

    def start_jobs(self):
        with self.db(write=True) as db:
            db.execute("UPDATE jobs SET status='queued' WHERE status='running'")
        Thread(target=self.dispatch_jobs, name="jobs", daemon=True).start()

    def dispatch_jobs(self):
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="job") as workers:
            pending = set()
            while True:
                with self.job_signal:
                    pending = {future for future in pending if not future.done()}
                    job = self.claim_job() if len(pending) < 2 else None
                    if job is not None:
                        future = workers.submit(self.run_job, job)
                        pending.add(future)
                        future.add_done_callback(lambda _: self.wake_jobs())
                    else:
                        self.job_signal.wait(1)

    def claim_job(self):
        with self.db(write=True) as db:
            job = db.execute(
                """SELECT * FROM jobs WHERE status='queued' AND retry_at<=?
                   AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.course_id=jobs.course_id
                                   AND active.kind=jobs.kind AND active.status='running')
                   ORDER BY CASE kind WHEN 'exam' THEN 0 ELSE 1 END, created_at LIMIT 1""",
                (time.time(),),
            ).fetchone()
            if job is not None:
                db.execute("UPDATE jobs SET status='running' WHERE id=?", (job["id"],))
            return job

    def run_job(self, job):
        jid = job["id"]
        ended = True
        try:
            self.job_handlers[job["kind"]](job)
        except RetryLater as error:
            failures = job["failures"] + 1
            state = "queued" if failures < 5 else "failed"
            ended = state == "failed"
            message = f"{error}，稍后自动重试" if state == "queued" else f"{error}，连续 {failures} 次没有成功"
            with self.db(write=True) as db:
                db.execute(
                    "UPDATE jobs SET status=?, failures=?, retry_at=?, error=? WHERE id=?",
                    (state, failures, time.time() + 2 ** failures, dump({"message": message, "retryable": True}), jid),
                )
        except JobFailure as error:
            self.fail_job(jid, str(error), error.retryable)
        except Exception:
            logging.exception("Background job failed: %s", jid)
            self.fail_job(jid, "任务处理时出错，请查看服务日志", True)
        else:
            with self.db(write=True) as db:
                db.execute("UPDATE jobs SET status='done', progress=1, error=NULL WHERE id=?", (jid,))
        if ended and job["kind"] in self.job_end_hooks:
            self.job_end_hooks[job["kind"]](job)

    def fail_job(self, jid, message, retryable):
        with self.db(write=True) as db:
            db.execute(
                "UPDATE jobs SET status='failed', error=? WHERE id=?",
                (dump({"message": message, "retryable": retryable}), jid),
            )

    @staticmethod
    def checkpoint(db, jid, progress, stage, payload):
        db.execute(
            "UPDATE jobs SET progress=?, stage=?, payload=?, failures=0, error=NULL WHERE id=?",
            (progress, stage, dump(payload), jid),
        )
