"""Teacher focus, evidence and exam format endpoints."""
import math

from core import JobFailure, bad_request, dump, fields, load, not_found, now, one_of, text, uid
from model import OutputError
from plan import stale
from workflow import focus_kp

QUESTION_TYPES = ("single", "fill", "calc", "short", "proof", "design")
DEFAULT_FORMAT = {
    "types": [{"type": kind, "count": count, "score": score}
              for kind, count, score in zip(QUESTION_TYPES, (10, 5, 3, 2, 0, 0), (2, 4, 10, 10, 10, 10))],
    "duration_min": 120,
    "open_book": False,
    "basis": "default",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS focus (
    course TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    analyzed_at TEXT,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS focus_fragments (
    id TEXT PRIMARY KEY,
    course TEXT NOT NULL REFERENCES focus(course) ON DELETE CASCADE,
    text TEXT NOT NULL,
    position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS focus_matches (
    fragment_id TEXT NOT NULL REFERENCES focus_fragments(id) ON DELETE CASCADE,
    kp_id TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    certainty TEXT NOT NULL,
    PRIMARY KEY (fragment_id,kp_id)
);
CREATE TABLE IF NOT EXISTS focus_choices (
    kp_id TEXT PRIMARY KEY REFERENCES points(id) ON DELETE CASCADE,
    include INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS exam_formats (
    course TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    value TEXT NOT NULL
);
"""


def exam_format(db, cid):
    row = db.execute("SELECT value FROM exam_formats WHERE course=?", (cid,)).fetchone()
    return load(row["value"]) if row else DEFAULT_FORMAT


def parse_format(body):
    fields(body, {"types"}, {"duration_min", "open_book"})
    rows = body["types"]
    if not isinstance(rows, list):
        raise bad_request("题型应为列表")
    kinds = {}
    for row in rows:
        if not isinstance(row, dict):
            raise bad_request("每种题型应包含题型、题量和每题分值")
        fields(row, {"type", "count", "score"})
        kind = one_of(row["type"], QUESTION_TYPES, "题型")
        count, score = row["count"], row["score"]
        if kind in kinds:
            raise bad_request("同一题型只能设置一次")
        if type(count) is not int or count < 0:
            raise bad_request("题量应为非负整数")
        if type(score) not in (int, float) or (type(score) is float and not math.isfinite(score)) or score < 0:
            raise bad_request("分值应为非负数字")
        kinds[kind] = {"type": kind, "count": count, "score": score}
    duration, book = body.get("duration_min"), body.get("open_book")
    if duration is not None and (type(duration) is not int or duration < 0):
        raise bad_request("考试时长应为非负整数分钟")
    if book is not None and type(book) is not bool:
        raise bad_request("开卷选项应为布尔值或空")
    return {
        "types": [kinds.get(kind, {"type": kind, "count": 0, "score": 0}) for kind in QUESTION_TYPES],
        "duration_min": duration, "open_book": book, "basis": "user",
    }


class FocusService:
    def __init__(self, app, api, materials):
        self.app = app
        self.materials = materials
        with app.db() as db:
            db.executescript(SCHEMA)
        app.focus = self
        app.job_handlers["focus"] = self.analyse
        api.add("GET", "/courses/([^/]+)/focus", self.get)
        api.add("PUT", "/courses/([^/]+)/focus", self.put, "json")
        api.add("POST", "/courses/([^/]+)/focus/kps", self.choose_kp, "json")
        api.add("GET", "/courses/([^/]+)/exam-format", self.get_format)
        api.add("PUT", "/courses/([^/]+)/exam-format", self.set_format, "json")

    def get(self, cid):
        with self.app.db() as db:
            self.app.course(db, cid)
            return self.view(db, cid)

    def put(self, cid, body):
        fields(body, {"text"})
        value = text(body["text"], "重点", empty=True)
        with self.app.db(write=True) as db:
            self.app.course(db, cid)
            self.start(db, cid, value)
            result = self.view(db, cid)
        self.app.wake_jobs()
        return result

    def start(self, db, cid, value):
        topics, points = self.materials.inventory(db, cid)
        topic_by_id = {topic["id"]: {key: topic[key] for key in ("id", "title", "summary")} |
                       {"kp_titles": []} for topic in topics}
        for point in points:
            topic_by_id[point["topic_id"]]["kp_titles"].append(point["title"])
        payload = {"topics": list(topic_by_id.values()), "points": points,
                   "fragments": focus_kp.fragments(value), "pos": 0, "skipped": []}
        jid = self.app.new_job(db, cid, "focus", "等待分析重点", payload)["id"]
        db.execute(
            """INSERT INTO focus VALUES (?,?,NULL,?) ON CONFLICT(course) DO UPDATE SET
               text=excluded.text, analyzed_at=NULL, job_id=excluded.job_id""", (cid, value, jid),
        )
        db.execute("DELETE FROM focus_fragments WHERE course=?", (cid,))
        db.execute("DELETE FROM suggestions WHERE course=? AND kind='focus_conflict'", (cid,))
        self.clear_choices(db, cid)
        stale(db, cid)

    @staticmethod
    def clear_choices(db, cid):
        db.execute(
            "DELETE FROM focus_choices WHERE kp_id IN (SELECT points.id FROM points JOIN documents ON points.material_id=documents.material_id WHERE documents.course=?)",
            (cid,),
        )

    def reconsider_missing_basis(self, db, cid):
        row = db.execute(
            """SELECT f.text, j.payload FROM focus f JOIN jobs j ON j.id=f.job_id
               WHERE f.course=? AND j.status='done'""", (cid,),
        ).fetchone()
        if row is not None and row["text"].strip() and not load(row["payload"])["points"]:
            self.start(db, cid, row["text"])
            self.app.wake_jobs()

    def view(self, db, cid):
        row = db.execute("SELECT * FROM focus WHERE course=?", (cid,)).fetchone()
        if row is None:
            return {"text": "", "analyzed_at": None, "job": None, "fragments": [], "suggestions": []}
        job = self.app.job(db, row["job_id"]) if row["job_id"] else None
        fragments = []
        for part in db.execute("SELECT * FROM focus_fragments WHERE course=? ORDER BY position", (cid,)):
            matches = db.execute(
                """SELECT m.kp_id AS id, points.value, m.level, m.certainty, c.include AS user_choice
                   FROM focus_matches m JOIN points ON points.id=m.kp_id
                   JOIN documents d ON points.material_id=d.material_id
                   LEFT JOIN focus_choices c ON c.kp_id=m.kp_id
                   WHERE m.fragment_id=? AND d.superseded_by IS NULL ORDER BY m.rowid""",
                (part["id"],),
            )
            points = []
            for point in matches:
                include = point["user_choice"]
                points.append({"id": point["id"], "title": load(point["value"])["title"], "level": point["level"],
                               "certainty": point["certainty"], "user_choice": None if include is None else bool(include)})
            fragments.append({"id": part["id"], "text": part["text"], "found": bool(points), "kps": points})
        suggestions = db.execute("SELECT value FROM suggestions WHERE course=? AND kind='focus_conflict' AND choice IS NULL",
                                 (cid,))
        return {"text": row["text"], "analyzed_at": row["analyzed_at"],
                "job": self.app.job_view(job) if job and job["status"] != "done" else None,
                "fragments": fragments, "suggestions": [load(s["value"]) for s in suggestions]}

    def analyse(self, job):
        cid, jid = job["course_id"], job["id"]
        task = load(job["payload"])
        pieces = task["fragments"]
        positions = list(task["retry_positions"]) if "retry_positions" in task else range(task["pos"], len(pieces))
        for position in positions:
            fragment = pieces[position]
            try:
                matches = focus_kp.analyse(self.materials.model, fragment, task["topics"], task["points"])
            except OutputError:
                task["skipped"].append(position + 1)
                matches = []
            with self.app.db(write=True) as db:
                if not db.execute("SELECT 1 FROM focus WHERE course=? AND job_id=?", (cid, jid)).fetchone():
                    return
                db.execute("DELETE FROM focus_fragments WHERE course=? AND position=?", (cid, position))
                fid = uid("f")
                db.execute("INSERT INTO focus_fragments VALUES (?,?,?,?)", (fid, cid, fragment, position))
                for match in matches:
                    db.execute(
                        """INSERT INTO focus_matches(fragment_id,kp_id,level,certainty)
                           SELECT ?,id,?,? FROM points WHERE id=?""",
                        (fid, match["level"], match["certainty"], match["id"]),
                    )
                if "retry_positions" in task:
                    task["retry_positions"].remove(position)
                    left = len(task["retry_positions"])
                    done = len(pieces) - left
                else:
                    task["pos"] = position + 1
                    done = task["pos"]
                self.app.checkpoint(db, jid, done / len(pieces), f"已分析 {done} / {len(pieces)} 句", task)
        with self.app.db(write=True) as db:
            updated = db.execute("UPDATE focus SET analyzed_at=? WHERE course=? AND job_id=?", (now(), cid, jid))
            if updated.rowcount:
                self.conflicts(db, cid)
                stale(db, cid)
                if pieces and not task["points"] and self.materials.inventory(db, cid)[1]:
                    self.start(db, cid, db.execute("SELECT text FROM focus WHERE course=?", (cid,)).fetchone()["text"])
                    self.app.wake_jobs()
        if task["skipped"]:
            positions = "、".join(str(pos) for pos in task["skipped"])
            raise JobFailure(f"第 {positions} 句多次分析失败，已保留其他结果", True)

    def prepare_retry(self, db, job):
        task = load(job["payload"])
        if task["skipped"]:
            task.update(retry_positions=[position - 1 for position in task["skipped"]], skipped=[])
            db.execute("UPDATE jobs SET payload=? WHERE id=?", (dump(task), job["id"]))

    def choose_kp(self, cid, body):
        fields(body, {"kp_id", "include"})
        kp_id, include = text(body["kp_id"], "知识点"), body["include"]
        if include is not None and type(include) is not bool:
            raise bad_request("include 应为 true、false 或 null")
        with self.app.db(write=True) as db:
            self.app.course(db, cid)
            if not db.execute(
                """SELECT 1 FROM points p JOIN documents d ON d.material_id=p.material_id
                   WHERE p.id=? AND d.course=? AND d.superseded_by IS NULL""", (kp_id, cid),
            ).fetchone():
                raise not_found("知识点")
            if include is None:
                db.execute("DELETE FROM focus_choices WHERE kp_id=?", (kp_id,))
            else:
                db.execute("INSERT INTO focus_choices VALUES (?,?) ON CONFLICT(kp_id) DO UPDATE SET include=excluded.include",
                           (kp_id, include))
            self.conflicts(db, cid)
            stale(db, cid)
            return self.view(db, cid)

    def conflicts(self, db, cid):
        fragments = self.view(db, cid)["fragments"]
        by_kp = {}
        for part in fragments:
            for point in part["kps"]:
                if point["user_choice"] is True or (point["user_choice"] is None and point["certainty"] == "sure"):
                    by_kp.setdefault(point["id"], set()).add(point["level"])
        for row in db.execute("SELECT * FROM suggestions WHERE course=? AND kind='focus_conflict'", (cid,)):
            kp_id = load(row["value"])["kp_ids"][0]
            if not {"emphasized", "excluded"} <= by_kp.get(kp_id, set()):
                db.execute("DELETE FROM suggestions WHERE id=?", (row["id"],))
        for kp_id, levels in by_kp.items():
            if {"emphasized", "excluded"} <= levels:
                point = db.execute("SELECT material_id,value FROM points WHERE id=?", (kp_id,)).fetchone()
                title = load(point["value"])["title"]
                self.materials.suggest(
                    db, cid, "fc_" + kp_id, "focus_conflict", f"“{title}”既被说成不考，也被强调",
                    None, [("excluded", "本次不考"), ("emphasized", "作为重点")],
                    "emphasized", [point["material_id"]], [kp_id],
                )

    def get_format(self, cid):
        with self.app.db() as db:
            self.app.course(db, cid)
            return exam_format(db, cid)

    def set_format(self, cid, body):
        value = parse_format(body)
        with self.app.db(write=True) as db:
            self.app.course(db, cid)
            db.execute("INSERT INTO exam_formats VALUES (?,?) ON CONFLICT(course) DO UPDATE SET value=excluded.value",
                       (cid, dump(value)))
        return value
