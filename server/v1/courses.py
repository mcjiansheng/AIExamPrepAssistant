"""Owned course and knowledge-point projections for API v1."""

import re
from copy import deepcopy
from datetime import date
from pathlib import Path
from typing import Annotated
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field, field_validator
from starlette.responses import JSONResponse

from .auth import Body, Principal, principal, require_member
from .db import dump, load, local_iso, utc_now
from .errors import not_found
from .events import changed
from .idempotency import run
from .undo import record

router = APIRouter()
LEVEL_WEIGHT = {"emphasized": 4, "conflict": 4, "mentioned": 2.5, "none": 1, "excluded": 0}
FOCUS_LEVELS = {"emphasized", "conflict", "mentioned"}
COURSE_AREAS = ["courses", "course", "today", "schedule"]


class CreateCourse(Body):
    name: str
    exam_date: str | None = None
    color: Annotated[int, Field(ge=0, le=7)] | None = None

    @field_validator("name")
    @classmethod
    def named(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("请填写课程名")
        return value

    @field_validator("exam_date")
    @classmethod
    def exam_day(cls, value):
        if value is not None:
            if date.fromisoformat(value).isoformat() != value:
                raise ValueError("日期格式应为 YYYY-MM-DD")
        return value


class UpdateCourse(Body):
    name: str = Field(default=None)
    exam_date: str | None = None
    color: Annotated[int, Field(ge=0, le=7)] = Field(default=None)
    daily_cap_min: Annotated[int, Field(ge=0)] | None = None

    _name = field_validator("name")(CreateCourse.named.__func__)
    _exam_day = field_validator("exam_date")(CreateCourse.exam_day.__func__)


def course(conn, user_id, cid):
    row = conn.execute("SELECT * FROM courses WHERE id = ? AND user_id = ?", (cid, user_id)).fetchone()
    if row is None:
        raise not_found("课程")
    return row


def kp(conn, user_id, kid):
    row = conn.execute("SELECT * FROM knowledge_points WHERE id = ? AND user_id = ?", (kid, user_id)).fetchone()
    if row is None:
        raise not_found("知识点")
    return row


def content_key(name):
    if re.search(r"数学|微积分|高数|数学分析", name):
        return "math"
    if re.search(r"数据结构|算法", name):
        return "ds"
    return "os"


def default_format(seed_key="os"):
    path = Path(__file__).with_name("seed") / "demo-content.json"
    value = load(path.read_text(encoding="utf-8"))["courses"][seed_key]["format"]
    return {**value, "basis": "default"}


def exam_format(conn, course_id):
    return load(conn.execute("SELECT value FROM course_formats WHERE course_id = ?", (course_id,)).fetchone()[0])


def next_color(conn, user_id):
    colors = [row[0] for row in conn.execute("SELECT color FROM courses WHERE user_id = ?", (user_id,))]
    for color in range(8):
        if color not in colors:
            return color
    return len(colors) % 8


def create_course(conn, user, name, exam_date=None, color=None, *, sample=False,
                  seed_key=None, created_at=None, exam_format=None):
    course_id = uuid4().hex
    created = created_at or utc_now().isoformat()
    key = seed_key or content_key(name)
    selected_color = next_color(conn, user.id) if color is None else color
    format_value = deepcopy(exam_format) if exam_format is not None else default_format(key)
    if "basis" not in format_value:
        format_value["basis"] = "default"
    conn.execute(
        """INSERT INTO courses
           (id, user_id, name, created_at, exam_date, color, sample, daily_cap_min, seed_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)""",
        (course_id, user.id, name, created, exam_date, selected_color, int(sample), key),
    )
    conn.execute("INSERT INTO course_formats (course_id, user_id, value) VALUES (?, ?, ?)",
                 (course_id, user.id, dump(format_value)))
    conn.execute(
        """INSERT INTO chat_threads
           (id, user_id, course_id, title, kind, model, updated_at, preview)
           VALUES (?, ?, ?, ?, 'course', NULL, ?, NULL)""",
        (uuid4().hex, user.id, course_id, name, created),
    )
    return course(conn, user.id, course_id)


def state_of(understood_at, mark, events):
    state = "learned" if understood_at else "new"
    correct = set()
    for event in events:
        if event["outcome"] == "correct":
            correct.add(event["bank_id"])
            if len(correct) >= 2 or mark == "mastered":
                state = "mastered"
            elif state == "new":
                state = "learned"
        else:
            state = "shaky"
            correct.clear()
    if mark == "shaky" and state != "mastered":
        state = "shaky"
    return state


def kp_states(conn, course_id):
    rows = conn.execute(
        """SELECT k.id, p.understood_at, p.mark FROM knowledge_points k
           LEFT JOIN kp_progress p ON p.kp_id = k.id
           WHERE k.course_id = ? ORDER BY k.position""", (course_id,),
    ).fetchall()
    by_kp = {row["id"]: [] for row in rows}
    events = conn.execute(
        """SELECT e.* FROM learning_events e JOIN knowledge_points k ON k.id = e.kp_id
           WHERE k.course_id = ? AND e.counted = 1 ORDER BY e.created_at, e.rowid""", (course_id,),
    )
    for event in events:
        by_kp[event["kp_id"]].append(event)
    return {row["id"]: state_of(row["understood_at"], row["mark"], by_kp[row["id"]]) for row in rows}


def kp_levels(conn, course_id):
    # Focus imports the owned lookup helpers from this module.
    from .focus import levels
    return levels(conn, course_id)


def readiness(conn, course_id, states=None, levels=None):
    states = kp_states(conn, course_id) if states is None else states
    levels = kp_levels(conn, course_id) if levels is None else levels
    ids = [row[0] for row in conn.execute("SELECT id FROM active_knowledge_points WHERE course_id = ?", (course_id,))]
    pool = [kid for kid in ids if levels.get(kid, "none") != "excluded"]
    focused = [kid for kid in pool if levels.get(kid, "none") in FOCUS_LEVELS]
    selected = focused or pool
    return {"mastered": sum(states[kid] == "mastered" for kid in selected), "total": len(selected)}


def organizing(conn, course_id):
    job = conn.execute(
        """SELECT * FROM jobs WHERE course_id = ? AND kind = 'ingest'
           AND status IN ('queued', 'running', 'needs_input') ORDER BY created_at DESC LIMIT 1""",
        (course_id,),
    ).fetchone()
    if job:
        state = "waiting_confirm" if job["status"] == "needs_input" and job["estimate"] is not None else "working"
        return {"state": state, "progress": job["progress"], "stage": job["stage"],
                "job_id": job["id"], "attention": None}
    counts = {row["status"]: row["n"] for row in conn.execute(
        "SELECT status, COUNT(*) AS n FROM materials WHERE course_id = ? AND superseded_by IS NULL GROUP BY status",
        (course_id,),
    )}
    if counts.get("waiting_ai", 0):
        return {"state": "waiting_ai", "progress": None, "stage": "等待连接 AI 后整理",
                "job_id": None, "attention": None}
    if counts.get("failed", 0):
        return {"state": "attention", "progress": None, "stage": None, "job_id": None,
                "attention": f"{counts['failed']} 份资料要看"}
    return {"state": "idle", "progress": None, "stage": None, "job_id": None, "attention": None}


def course_view(conn, user, row, states=None):
    states = kp_states(conn, row["id"]) if states is None else states
    today = utc_now().astimezone(ZoneInfo(user.timezone)).date()
    cid = row["id"]
    counts = {
        "kps": conn.execute("SELECT COUNT(*) FROM active_knowledge_points WHERE course_id = ?", (cid,)).fetchone()[0],
        "materials": conn.execute("SELECT COUNT(*) FROM materials WHERE course_id = ? AND superseded_by IS NULL", (cid,)).fetchone()[0],
        "fragments": conn.execute("SELECT COUNT(*) FROM fragments WHERE course_id = ?", (cid,)).fetchone()[0],
        "mistakes": conn.execute("SELECT COUNT(*) FROM mistakes WHERE course_id = ?", (cid,)).fetchone()[0],
    }
    return {
        "id": cid, "name": row["name"], "color": row["color"], "exam_date": row["exam_date"],
        "days_left": (date.fromisoformat(row["exam_date"]) - today).days if row["exam_date"] else None,
        "sample": bool(row["sample"]), "readiness": readiness(conn, cid, states),
        "organizing": organizing(conn, cid), "counts": counts, "daily_cap_min": row["daily_cap_min"],
        "created_at": local_iso(row["created_at"], user.timezone),
    }


def chapter_view(conn, chapter, states, levels):
    points = conn.execute("SELECT * FROM active_knowledge_points WHERE chapter_id = ? ORDER BY position", (chapter["id"],)).fetchall()
    return {
        "id": chapter["id"], "title": chapter["title"], "mastered": sum(states[point["id"]] == "mastered" for point in points),
        "total": len(points), "kps": [{"id": point["id"], "title": point["title"],
            "state": states[point["id"]], "level": levels.get(point["id"], "none"),
            "topic_id": point["topic_id"]} for point in points],
    }


def map_view(conn, course_id, states=None):
    states = kp_states(conn, course_id) if states is None else states
    levels = kp_levels(conn, course_id)
    chapters = conn.execute("SELECT * FROM chapters WHERE course_id = ? ORDER BY position", (course_id,))
    return {"course_id": course_id, "chapters": [chapter_view(conn, row, states, levels) for row in chapters]}


def kp_brief(conn, user, point, states=None):
    states = kp_states(conn, point["course_id"]) if states is None else states
    levels = kp_levels(conn, point["course_id"])
    chapter = conn.execute("SELECT title FROM chapters WHERE id = ?", (point["chapter_id"],)).fetchone()
    return {"id": point["id"], "course_id": point["course_id"], "title": point["title"],
            "state": states[point["id"]], "level": levels.get(point["id"], "none"), "chapter_title": chapter[0]}


def weak_kps(conn, user, course_id, states=None, limit=3):
    states = kp_states(conn, course_id) if states is None else states
    levels = kp_levels(conn, course_id)
    points = conn.execute("SELECT * FROM active_knowledge_points WHERE course_id = ? ORDER BY position", (course_id,)).fetchall()
    selected = [point for point in points if states[point["id"]] == "shaky" and levels.get(point["id"], "none") != "excluded"]
    selected.sort(key=lambda point: (-LEVEL_WEIGHT[levels.get(point["id"], "none")], point["position"]))
    return [kp_brief(conn, user, point, states) for point in selected[:limit]]


def session_summary(row, course_name, timezone):
    return {"id": row["id"], "kind": row["kind"], "course_id": row["course_id"],
            "course_name": course_name, "title": row["title"], "status": row["status"],
            "created_at": local_iso(row["created_at"], timezone),
            "finished_at": local_iso(row["finished_at"], timezone) if row["finished_at"] else None,
            "question_count": row["question_count"], "answered": row["answered"],
            "score": row["score"], "total": row["total"]}


def refs_for(conn, point):
    return [{"material_id": row["material_id"], "material_title": row["title"], "page": row["page"], "quote": row["quote"]}
            for row in conn.execute(
                """SELECT r.*, m.title FROM kp_refs r JOIN materials m ON m.id = r.material_id
                   WHERE r.kp_id = ? ORDER BY r.position""", (point["id"],))]


def kp_detail(conn, user, point):
    states = kp_states(conn, point["course_id"])
    levels = kp_levels(conn, point["course_id"])
    chapter = conn.execute("SELECT * FROM chapters WHERE id = ?", (point["chapter_id"],)).fetchone()
    topic = conn.execute("SELECT id, title FROM topics WHERE id = ?", (point["topic_id"],)).fetchone()
    ordered = [row[0] for row in conn.execute("SELECT id FROM active_knowledge_points WHERE course_id = ? ORDER BY position", (point["course_id"],))]
    at = ordered.index(point["id"]) if point["id"] in ordered else None
    references = refs_for(conn, point)
    blocks = load(point["blocks"])
    if not blocks:
        blocks = [[{"kind": "text", "text": point["summary"]}]]
    teacher = [dict(row) for row in conn.execute(
        """SELECT f.text, f.id AS fragment_id FROM fragments f
           JOIN focus_matches m ON m.fragment_id = f.id
           WHERE m.kp_id = ? AND (m.user_choice = 1 OR (m.user_choice IS NULL AND m.certainty = 'sure'))
           ORDER BY f.created_at, f.rowid""", (point["id"],))]
    types = [row[0] for row in conn.execute(
        "SELECT type FROM bank_questions WHERE kp_id = ? GROUP BY type ORDER BY MIN(rowid)", (point["id"],))]
    progress = conn.execute("SELECT understood_at FROM kp_progress WHERE kp_id = ?", (point["id"],)).fetchone()
    understood = progress["understood_at"] if progress else None
    return {
        "id": point["id"], "course_id": point["course_id"], "title": point["title"],
        "chapter": {"id": chapter["id"], "title": chapter["title"]}, "topic": dict(topic),
        "state": states[point["id"]], "level": levels.get(point["id"], "none"),
        "modes": load(point["modes"]), "types": types, "teacher": teacher,
        "sections": [{"blocks": section, "refs": references[:1] if index == 0 else []} for index, section in enumerate(blocks)],
        "pages": references, "quiz": [], "map": chapter_view(conn, chapter, states, levels),
        "prev_id": ordered[at - 1] if at is not None and at > 0 else None,
        "next_id": ordered[at + 1] if at is not None and at < len(ordered) - 1 else None,
        "task": None, "understood_at": local_iso(understood, user.timezone) if understood else None,
    }


@router.get("/courses")
def courses(request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        rows = conn.execute("SELECT * FROM courses WHERE user_id = ? ORDER BY exam_date IS NULL, exam_date, created_at", (user.id,))
        return [course_view(conn, user, row) for row in rows]


@router.post("/courses")
def new_course(body: CreateCourse, request: Request, user: Principal = Depends(principal)):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        def operation():
            created = create_course(conn, user, body.name, body.exam_date, body.color)
            return 200, course_view(conn, user, created)
        status, result = run(conn, request, user, operation)
    request.app.state.events.publish(user.id, changed(["courses", "threads", "today", "schedule"]))
    return JSONResponse(result, status_code=status)


@router.get("/courses/{cid}")
def read_course(cid: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        return course_view(conn, user, course(conn, user.id, cid))


def update_course(conn, user, cid, changes):
    before = course(conn, user.id, cid)
    updates = {name: value for name, value in changes.items() if before[name] != value}
    undo = None
    if updates:
        assignments = ", ".join(f"{name} = ?" for name in updates)
        conn.execute(f"UPDATE courses SET {assignments} WHERE id = ?", (*updates.values(), cid))
        undo = record(conn, user, label="已修改课程", summary="课程设置已恢复",
                      affects=COURSE_AREAS, rows=[("courses", {"id": cid}, dict(before))])
    return {"result": course_view(conn, user, course(conn, user.id, cid)), "affects": COURSE_AREAS, "undo": undo}


@router.patch("/courses/{cid}")
def patch_course(cid: str, body: UpdateCourse, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        result = update_course(conn, user, cid, body.model_dump(exclude_unset=True))
    request.app.state.events.publish(user.id, changed(COURSE_AREAS, cid))
    return result


@router.delete("/courses/{cid}", status_code=204)
def delete_course(cid: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        course(conn, user.id, cid)
        conn.execute("DELETE FROM courses WHERE id = ? AND user_id = ?", (cid, user.id))
    request.app.state.events.publish(user.id, changed(["courses", "today", "schedule", "practice", "threads"]))
    return Response(status_code=204)


@router.get("/courses/{cid}/home")
def home(cid: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        row = course(conn, user.id, cid)
        states = kp_states(conn, cid)
        latest = conn.execute("SELECT * FROM practice_sessions WHERE course_id = ? ORDER BY created_at DESC LIMIT 1", (cid,)).fetchone()
        return {"course": course_view(conn, user, row, states), "map": map_view(conn, cid, states),
                "next": [], "weak": weak_kps(conn, user, cid, states),
                "last_session": session_summary(latest, row["name"], user.timezone) if latest else None}


@router.get("/courses/{cid}/map")
def map_course(cid: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        course(conn, user.id, cid)
        return map_view(conn, cid)


@router.get("/kps/{kid}")
def read_kp(kid: str, request: Request, task_id: str | None = None, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        return kp_detail(conn, user, kp(conn, user.id, kid))
