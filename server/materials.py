"""Material uploads, extracted pages, version decisions and course topics."""
import hashlib
import re
import subprocess
from email import policy
from email.parser import BytesParser
from pathlib import Path

from core import ApiError, JobFailure, RetryLater, bad_request, dump, fields, load, not_found, now, one_of, text, uid
from kb import evidence_db, revisions, versions
from kb.extract import ExtractionError, extract, filename_date, render
from model import DATA_RULE, LongCatClient, MockClient, OutputError, UnsupportedVision, call_json, require
from workflow.topics import group_once
from plan import stale

KINDS = ("slides", "homework", "notes", "review", "past_paper", "other")
EXTENSIONS = {".pdf", ".ppt", ".pptx", ".doc", ".docx", ".txt", ".md"}
IMAGE_FORMATS = {".pdf", ".ppt", ".pptx"}
MAX_UPLOAD = 64 * 1024 * 1024
MATERIAL_FIELDS = ("title", "kind", "pages", "status", "stage", "progress", "kp_count", "vision",
                   "superseded_by", "uploaded_at")
EXTRACT_PROMPT = DATA_RULE + """逐页找出明确讲到的知识点，覆盖有教学内容的页，略过纯目录和标题页。
返回 {"knowledge_points":[{"title":"名称","summary":"可复习的说明","pages":[1],
"importance":3,"terms":["同义词"],"modes":["understand"]}]}。
重要度为 1 到 5 整数，modes 可从 memory/understand/compute/design/proof/linked/major 选。
页号必须来自本次资料。资料不足时 knowledge_points 可为空。"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    material_id TEXT PRIMARY KEY,
    course TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    ext TEXT NOT NULL,
    pages INTEGER,
    status TEXT NOT NULL,
    stage TEXT,
    progress REAL,
    kp_count INTEGER,
    vision TEXT NOT NULL DEFAULT 'none',
    superseded_by TEXT REFERENCES documents(material_id) ON DELETE SET NULL,
    error TEXT,
    uploaded_at TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    meta_date TEXT,
    filename_date TEXT
);
CREATE INDEX IF NOT EXISTS documents_course ON documents(course, uploaded_at);
CREATE TABLE IF NOT EXISTS units (
    material_id TEXT REFERENCES documents(material_id) ON DELETE CASCADE,
    page INTEGER,
    text TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    image BLOB,
    vision TEXT,
    PRIMARY KEY (material_id, page)
);
CREATE TABLE IF NOT EXISTS reused_pages (
    material_id TEXT NOT NULL,
    page INTEGER NOT NULL,
    PRIMARY KEY (material_id,page),
    FOREIGN KEY (material_id,page) REFERENCES units(material_id,page) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL REFERENCES documents(material_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT
);
CREATE TABLE IF NOT EXISTS topic_requirements (
    source TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    required TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    PRIMARY KEY (source,required)
);
CREATE TABLE IF NOT EXISTS points (
    id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL REFERENCES documents(material_id) ON DELETE CASCADE,
    topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT PRIMARY KEY,
    course TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    choice TEXT
);
"""


def multipart(headers, read_body):
    if headers.get_content_type() != "multipart/form-data":
        raise ApiError(415, "unsupported_type", "上传请求应使用 multipart/form-data")
    envelope = ("Content-Type: " + headers["Content-Type"] + "\r\n\r\n").encode("ascii")
    message = BytesParser(policy=policy.default).parsebytes(envelope + read_body(MAX_UPLOAD))
    if not message.is_multipart() or message.defects:
        raise bad_request("没有读到完整的上传文件")
    files = []
    for part in message.iter_parts():
        if part.get_param("name", header="content-disposition") != "files":
            continue
        filename = part.get_filename()
        if not filename:
            continue
        title = re.split(r"[/\\]", filename)[-1].replace("\x00", "").strip()
        suffix = Path(title).suffix.lower()
        if suffix not in EXTENSIONS:
            raise ApiError(415, "unsupported_type", "支持 PDF、PPT、Word、TXT 和 Markdown")
        files.append((title, suffix, part.get_payload(decode=True)))
    if not files:
        raise bad_request("没有收到文件")
    return files


def classify(name, ext):
    for pattern, kind in ((r"作业|homework|assignment", "homework"),
                          (r"笔记|notes?", "notes"), (r"往年|真题|past.exam", "past_paper")):
        if re.search(pattern, name, re.I):
            return kind
    return "slides" if ext in IMAGE_FORMATS else "other"


def view(row):
    return {**{key: row[key] for key in MATERIAL_FIELDS}, "id": row["material_id"],
            "error": load(row["error"]) if row["error"] else None}


def document(db, mid):
    doc = db.execute("SELECT * FROM documents WHERE material_id=?", (mid,)).fetchone()
    if doc is None:
        raise not_found("资料")
    return doc


def pages_for(db, mid):
    return [dict(row) for row in db.execute(
        """SELECT u.page, u.text, r.page IS NOT NULL AS reused FROM units u LEFT JOIN reused_pages r
           ON u.material_id=r.material_id AND u.page=r.page WHERE u.material_id=? ORDER BY u.page""", (mid,),
    )]


class MaterialRemoved(Exception):
    pass


def still_present(db, mid):
    if db.execute("SELECT 1 FROM documents WHERE material_id=?", (mid,)).fetchone() is None:
        raise MaterialRemoved


def draft_points(client, rows):
    valid_pages = {row["page"] for row in rows}

    def check(data):
        points = data["knowledge_points"]
        require(isinstance(points, list), "knowledge_points 应为数组")
        for kp in points:
            require(isinstance(kp, dict), "知识点应为对象")
            for key in ("title", "summary"):
                require(isinstance(kp[key], str) and kp[key].strip(), f"{key} 应为非空文字")
            require(isinstance(kp["pages"], list) and kp["pages"] and
                    all(type(page) is int and page in valid_pages for page in kp["pages"]), "pages 只能引用本次给出的页码")
            require(type(kp["importance"]) is int and 1 <= kp["importance"] <= 5, "importance 应为 1 到 5 的整数")
            require(isinstance(kp["terms"], list) and all(isinstance(x, str) for x in kp["terms"]), "terms 应为文字数组")
            require(isinstance(kp["modes"], list) and all(x in evidence_db.MODES for x in kp["modes"]), "modes 包含未知考法")

    data = call_json(client, "extract", EXTRACT_PROMPT, dump(rows), check)
    return [{key: kp[key] for key in ("title", "summary", "pages", "importance", "terms", "modes")}
            for kp in data["knowledge_points"]]


class Materials:
    def __init__(self, app, api):
        self.app = app
        self.uploads = app.data_dir / "uploads"
        self.workspace = app.data_dir / "extract"
        self.uploads.mkdir(exist_ok=True)
        self.workspace.mkdir(exist_ok=True)
        self.model = MockClient() if app.mock_model else LongCatClient(app.data_dir)
        with app.db() as db:
            db.executescript(SCHEMA)
        app.job_handlers["ingest"] = self.ingest
        app.job_retry_hooks["ingest"] = self.prepare_retry
        app.materials = self
        api.add("GET", "/courses/([^/]+)/materials", self.list)
        api.add("POST", "/courses/([^/]+)/materials", self.upload, multipart)
        api.add("GET", "/courses/([^/]+)/topics", self.topics)
        api.add("PATCH", "/materials/([^/]+)", self.update_kind, "json")
        api.add("DELETE", "/materials/([^/]+)", self.delete)
        api.add("GET", "/materials/([^/]+)/pages/([0-9]+)", self.page)
        api.add("GET", "/materials/([^/]+)/pages/([0-9]+)/image", self.image)
        api.add("POST", "/suggestions/([^/]+)", self.choose, "json")

    def list(self, cid):
        with self.app.db() as db:
            self.app.course(db, cid)
            materials = db.execute("SELECT * FROM documents WHERE course=? ORDER BY uploaded_at", (cid,))
            suggestions = db.execute(
                "SELECT value FROM suggestions WHERE course=? AND choice IS NULL AND kind IN ('role','version') ORDER BY rowid",
                (cid,),
            )
            return {"materials": [view(item) for item in materials],
                    "suggestions": [load(item["value"]) for item in suggestions]}

    def upload(self, cid, files):
        result = []
        with self.app.db(write=True) as db:
            self.app.course(db, cid)
            for title, ext, contents in files:
                mid = uid("m")
                (self.uploads / (mid + ext)).write_bytes(contents)
                db.execute(
                    """INSERT INTO documents
                           (material_id,course,title,kind,ext,status,stage,progress,uploaded_at,sha256,filename_date)
                       VALUES (?,?,?,?,?,'reading','读取文字',0,?,?,?)""",
                    (mid, cid, title, classify(title, ext), ext, now(), hashlib.sha256(contents).hexdigest(), filename_date(title)),
                )
                result.append(view(document(db, mid)))
            stale(db, cid)
            payload = {"materials": [item["id"] for item in result], "pos": 0, "page_offset": 0,
                       "warnings": [], "retry": [], "resume": {}, "page_skips": []}
            job = self.app.new_job(db, cid, "ingest", "等待读取资料", payload)
            public_job = self.app.job_view(job)
        self.app.wake_jobs()
        return {"materials": result, "job": public_job}

    def update_kind(self, mid, body):
        fields(body, {"kind"})
        kind = one_of(body["kind"], KINDS, "资料类型")
        with self.app.db(write=True) as db:
            row = document(db, mid)
            db.execute("UPDATE documents SET kind=? WHERE material_id=?", (kind, mid))
            stale(db, row["course"])
            for item in db.execute("SELECT id, value FROM suggestions WHERE course=? AND kind='role' AND choice IS NULL", (row["course"],)):
                if mid in load(item["value"])["material_ids"]:
                    db.execute("UPDATE suggestions SET choice=? WHERE id=?", (kind, item["id"]))
            return view(document(db, mid))

    def delete(self, mid):
        with self.app.db(write=True) as db:
            row = document(db, mid)
            db.execute("DELETE FROM documents WHERE material_id=?", (mid,))
            for item in db.execute("SELECT id, value FROM suggestions WHERE course=?", (row["course"],)):
                if mid in load(item["value"])["material_ids"]:
                    db.execute("DELETE FROM suggestions WHERE id=?", (item["id"],))
            self.update_versions(db, row["course"])
            stale(db, row["course"])
        path = self.uploads / (mid + row["ext"])
        self.app.after_commit(lambda: path.unlink(missing_ok=True))

    def delete_files(self, documents):
        for row in documents:
            (self.uploads / (row["material_id"] + row["ext"])).unlink(missing_ok=True)

    @staticmethod
    def read_page(db, mid, number):
        row = db.execute("SELECT * FROM units WHERE material_id=? AND page=?", (mid, int(number))).fetchone()
        if row is None:
            raise not_found("资料页")
        return row

    def page(self, mid, number):
        with self.app.db() as db:
            row = self.read_page(db, mid, number)
            return {"material_id": mid, "page": row["page"], "text": row["text"],
                    "image_url": f"/api/materials/{mid}/pages/{number}/image" if row["image"] else None}

    def image(self, mid, number):
        with self.app.db() as db:
            image = self.read_page(db, mid, number)["image"]
            if image is None:
                raise not_found("页图")
            return image

    def choose(self, sid, body):
        fields(body, {"choice"})
        choice = text(body["choice"], "建议选项")
        with self.app.db(write=True) as db:
            row = db.execute("SELECT * FROM suggestions WHERE id=? AND choice IS NULL", (sid,)).fetchone()
            if row is None:
                raise not_found("建议")
            suggestion = load(row["value"])
            one_of(choice, [o["id"] for o in suggestion["options"]], "建议选项")
            db.execute("UPDATE suggestions SET choice=? WHERE id=?", (choice, sid))
            if row["kind"] == "role":
                db.execute("UPDATE documents SET kind=? WHERE material_id=?", (choice, suggestion["material_ids"][0]))
            elif row["kind"] == "version":
                self.update_versions(db, row["course"])
            stale(db, row["course"])
            return {"ok": True}

    @staticmethod
    def suggest(db, cid, sid, kind, title, detail, options, default, mids, kps=()):
        value = {"id": sid, "kind": kind, "title": title, "detail": detail,
                 "options": [{"id": key, "label": label} for key, label in options],
                 "default_option": default, "material_ids": mids, "kp_ids": list(kps)}
        db.execute("INSERT OR IGNORE INTO suggestions VALUES (?,?,?,?,NULL)", (sid, cid, kind, dump(value)))

    def update_versions(self, db, cid):
        overrides = {row["id"]: row["choice"] for row in db.execute(
            "SELECT id, choice FROM suggestions WHERE course=? AND kind='version' AND choice IS NOT NULL", (cid,),
        )}
        previous = {row["material_id"]: row for row in db.execute("SELECT * FROM documents WHERE course=?", (cid,))}
        groups = versions.analyse(db, cid, overrides)
        db.execute("UPDATE documents SET superseded_by=NULL WHERE course=?", (cid,))
        db.execute("DELETE FROM suggestions WHERE course=? AND kind='version' AND choice IS NULL", (cid,))
        for group in groups:
            canonical = group["canonical"]
            members = group["members"]
            for member in members:
                older = member["material_id"]
                prior = previous[older]
                if older != canonical and prior["superseded_by"] is None and prior["kp_count"]:
                    remap = revisions.mapping(db, older, canonical)
                    revisions.reuse_ready_pages(db, older, canonical, remap)
                    revisions.recheck_questions(db, older, canonical, previous[canonical]["title"], remap)
            for member in members:
                if member["material_id"] != canonical:
                    db.execute("UPDATE documents SET superseded_by=? WHERE material_id=?", (canonical, member["material_id"]))
            if group["confidence"] == "needs_confirmation":
                self.suggest(
                    db, cid, group["group_id"], "version", "这几份像是同一资料的不同版本", "选择这门课要用的版本",
                    [(m["material_id"], m["title"]) for m in members], canonical, [m["material_id"] for m in members],
                )

    def prepare_retry(self, db, job):
        task = load(job["payload"])
        retry = task["retry"]
        if not retry:
            if task["pos"] < len(task["materials"]):
                db.execute("UPDATE documents SET status='extracting', error=NULL, stage='继续整理资料' WHERE material_id=?",
                           (task["materials"][task["pos"]],))
            return
        pending = {mid: task["resume"].get(mid, 0) for mid in retry}
        task.update(materials=retry, pos=0, page_offset=pending[retry[0]], warnings=[], retry=[], resume=pending)
        db.execute("UPDATE jobs SET payload=? WHERE id=?", (dump(task), job["id"]))
        db.executemany(
            """UPDATE documents SET status=CASE WHEN pages IS NULL THEN 'reading' ELSE 'extracting' END,
               error=NULL, stage='继续整理资料' WHERE material_id=?""", [(mid,) for mid in retry],
        )

    def ingest(self, job):
        jid = job["id"]
        task = load(job["payload"])
        try:
            self.process_documents(jid, task)
        except RetryLater as error:
            if job["failures"] >= 4:
                with self.app.db(write=True) as db:
                    saved = load(self.app.job(db, jid)["payload"])
                    mid = saved["materials"][saved["pos"]]
                    db.execute("UPDATE documents SET status='failed', error=?, stage=NULL WHERE material_id=?",
                               (dump({"message": str(error), "retryable": True}), mid))
            raise
        if task["warnings"]:
            message = "；".join(dict.fromkeys(task["warnings"]))
            raise JobFailure(message, bool(task["retry"]))

    def process_documents(self, jid, task):
        while task["pos"] < len(task["materials"]):
            mid = task["materials"][task["pos"]]
            with self.app.db() as db:
                doc = db.execute("SELECT * FROM documents WHERE material_id=?", (mid,)).fetchone()
            if doc is None:
                self.advance(jid, task)
                continue
            try:
                if doc["pages"] is None:
                    self.extract_document(doc)
                self.create_points(jid, doc, task)
                self.group_points(doc)
                self.finish_document(doc, task.get("page_skips", []))
            except MaterialRemoved:
                pass
            except FileNotFoundError:
                with self.app.db() as db:
                    if db.execute("SELECT 1 FROM documents WHERE material_id=?", (mid,)).fetchone():
                        raise
            except ExtractionError as error:
                self.record_error(mid, error, task)
            except OutputError:
                self.record_error(mid, ExtractionError("知识点分组多次未完成，请重试整理", True), task)
            except RetryLater:
                raise
            except JobFailure as error:
                self.record_error(mid, error, task)
            self.advance(jid, task)

    def record_error(self, mid, error, task):
        issue = {"message": str(error), "retryable": error.retryable}
        task["warnings"].append(issue["message"])
        if error.retryable:
            task["retry"].append(mid)
            task["resume"][mid] = task["page_offset"]
        with self.app.db(write=True) as db:
            db.execute("UPDATE documents SET status='failed', stage=NULL, error=? WHERE material_id=?",
                       (dump(issue), mid))

    def advance(self, jid, task):
        task["pos"] += 1
        next_id = task["materials"][task["pos"]] if task["pos"] < len(task["materials"]) else None
        task["page_offset"] = task["resume"].get(next_id, 0)
        task["page_skips"] = []
        with self.app.db(write=True) as db:
            self.app.checkpoint(
                db, jid, task["pos"] / len(task["materials"]),
                f"已整理 {task['pos']} / {len(task['materials'])} 份资料", task,
            )

    def extract_document(self, doc):
        mid = doc["material_id"]
        source = self.uploads / (mid + doc["ext"])
        pages, modified = extract(source, self.workspace)
        with self.app.db(write=True) as db:
            still_present(db, mid)
            db.execute("UPDATE documents SET pages=?, meta_date=?, status='extracting', stage='整理知识点', progress=0.2 WHERE material_id=?",
                       (len(pages), modified, mid))
            db.executemany(
                "INSERT INTO units (material_id,page,text,sha256) VALUES (?,?,?,?)",
                [(mid, i, page, hashlib.sha256(page.encode()).hexdigest()) for i, page in enumerate(pages, 1)],
            )
            if re.search(r"复习课|复习题|review", doc["title"] + "\n" + "\n".join(pages[:3]), re.I) or (
                any(re.search(r"\bProblem\b", page, re.I) for page in pages)
                and any(re.search(r"\bSolution\b", page, re.I) for page in pages)
            ):
                self.suggest(
                    db, doc["course"], "role_" + mid, "role", f"“{doc['title']}”是老师的复习题讲义吗？", None,
                    [("review", "按老师重点处理"), (doc["kind"], "当普通资料")], doc["kind"], [mid],
                )
            self.update_versions(db, doc["course"])

    def create_points(self, jid, doc, task):
        mid = doc["material_id"]
        with self.app.db() as db:
            rows = pages_for(db, mid)
        while task["page_offset"] < len(rows):
            offset = task["page_offset"]
            batch = rows[offset:offset + 4]
            pending = [{"page": row["page"], "text": row["text"]} for row in batch if not row["reused"]]
            points, skipped = self.extract_batch(pending)
            if skipped:
                task.setdefault("page_skips", []).extend(skipped)
                task["warnings"].append(f"第 {', '.join(str(n) for n in skipped)} 页多次整理失败，已跳过这些页")
            task["page_offset"] += len(batch)
            with self.app.db(write=True) as db:
                still_present(db, mid)
                db.executemany("INSERT INTO points VALUES(?,?,NULL,?)", [
                    (uid("kp"), mid, dump(point)) for point in points
                ])
                pct = task["page_offset"] / len(rows)
                db.execute("UPDATE documents SET status='extracting', progress=? WHERE material_id=?", (0.2 + pct * 0.65, mid))
                self.app.checkpoint(db, jid, (task["pos"] + pct * 0.8) / len(task["materials"]),
                                    f"整理知识点（{task['page_offset']} / {len(rows)} 页）", task)

    def extract_batch(self, rows):
        text_rows = [row for row in rows if row["text"]]
        if not text_rows:
            return [], []
        try:
            return draft_points(self.model, text_rows), []
        except OutputError:
            if len(text_rows) == 1:
                return [], [text_rows[0]["page"]]
            points, skipped = [], []
            for row in text_rows:
                more, failed = self.extract_batch([row])
                points.extend(more)
                skipped.extend(failed)
            return points, skipped

    def group_points(self, doc):
        mid, cid = doc["material_id"], doc["course"]
        with self.app.db() as db:
            points = [{"id": row["id"], **load(row["value"])} for row in db.execute(
                "SELECT * FROM points WHERE material_id=? AND topic_id IS NULL ORDER BY rowid", (mid,),
            )]
            course = self.app.course(db, cid)
        if not points:
            return
        try:
            groups = group_once(self.model, (course["name"], doc["title"]), points)
            partitions = [groups]
        except OutputError:
            partitions = [group_once(self.model, (course["name"], doc["title"]), points[start:start + 8])
                          for start in range(0, len(points), 8)]
        with self.app.db(write=True) as db:
            still_present(db, mid)
            for groups in partitions:
                ids = [uid("t") for _ in groups]
                for tid, group in zip(ids, groups):
                    db.execute("INSERT INTO topics VALUES (?,?,?,?)", (tid, mid, group["title"], group["summary"]))
                    db.executemany("UPDATE points SET topic_id=? WHERE id=?", [(tid, kp) for kp in group["kp_ids"]])
                db.executemany("INSERT INTO topic_requirements VALUES (?,?)", [
                    (tid, ids[required - 1]) for tid, group in zip(ids, groups) for required in group["requires"]
                ])

    def finish_document(self, doc, skipped):
        mid = doc["material_id"]
        with self.app.db(write=True) as db:
            still_present(db, mid)
            count = db.execute("SELECT count(*) FROM points WHERE material_id=?", (mid,)).fetchone()[0]
            issue = None
            if skipped:
                issue = {"message": "部分页多次整理未完成，已跳过第 " + "、".join(map(str, skipped)) + " 页",
                         "retryable": False}
            if count == 0:
                raise ExtractionError(issue["message"] if issue else "没有整理出知识点，请上传包含课程正文的资料")
            vision = "partial" if doc["ext"] in IMAGE_FORMATS else "none"
            db.execute("UPDATE documents SET status='ready', stage=NULL, progress=1, kp_count=?, vision=?, error=? WHERE material_id=?",
                       (count, vision, dump(issue) if issue else None, mid))
            stale(db, doc["course"])
            self.app.focus.reconsider_missing_basis(db, doc["course"])
        if vision == "partial":
            self.render_pages(doc)

    def render_pages(self, doc):
        mid = doc["material_id"]
        source = self.uploads / (mid + doc["ext"])
        try:
            images = render(source, self.workspace)
        except (ExtractionError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            images = ()
        with self.app.db(write=True) as db:
            db.executemany("UPDATE units SET image=? WHERE material_id=? AND page=?",
                           [(image, mid, page) for page, image in images])
        state = "done" if images else "unsupported"
        for page, image in sorted(images):
            with self.app.db() as db:
                still_present(db, mid)
                row = self.read_page(db, mid, page)
                if row["vision"] is not None:
                    continue
            def check(reply):
                require(isinstance(reply["content"], str), "content 应为文字")
            try:
                value = call_json(self.model, "vision", DATA_RULE + "只转写页内的图示，返回 {\"content\":\"\"}。",
                                  f"资料第 {page} 页", check, images=[image])
            except UnsupportedVision:
                state = "unsupported"
                break
            except OutputError:
                state = "unsupported"
                continue
            with self.app.db(write=True) as db:
                db.execute("UPDATE units SET vision=? WHERE material_id=? AND page=?", (value["content"], mid, page))
        with self.app.db(write=True) as db:
            db.execute("UPDATE documents SET vision=? WHERE material_id=?", (state, mid))

    @staticmethod
    def inventory(db, cid):
        topics = [dict(row) for row in db.execute(
            """SELECT t.*, d.title AS chapter_title, d.kind FROM topics t
               JOIN documents d ON d.material_id=t.material_id
               WHERE d.course=? AND d.superseded_by IS NULL AND d.kp_count > 0
               ORDER BY d.uploaded_at,t.rowid""", (cid,),
        )]
        points = []
        for topic in topics:
            points.extend({"id": row["id"], "topic_id": topic["id"],
                           "material_id": topic["material_id"], **load(row["value"])}
                          for row in db.execute("SELECT * FROM points WHERE topic_id=? ORDER BY rowid", (topic["id"],)))
        return topics, points

    def topics(self, cid):
        from kb.store import KnowledgeBase
        with self.app.db() as db:
            self.app.course(db, cid)
            return KnowledgeBase(db, cid).topics()
