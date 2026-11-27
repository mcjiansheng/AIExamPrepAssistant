"""Teacher focus evidence and exam format endpoints."""
import re
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .auth import Principal, principal, require_member
from .db import dump, load, local_iso, utc_now
from .errors import not_found
from .events import changed
from .idempotency import run as idempotent
from .jobs import new_job, view as job_view
from .undo import record

router = APIRouter()
User = Annotated[Principal, Depends(principal)]
QUESTION_TYPES = ("single", "fill", "calc", "short", "proof", "design")
ALIASES = {
    "os": {"移臂": "磁盘调度", "磁盘调度": "磁盘调度", "页面置换": "虚拟存储与页面置换", "置换算法": "虚拟存储与页面置换", "管程": "管程", "RAID": "RAID 与磁盘高速缓存", "进程调度": "处理机调度"},
    "math": {"中值定理": "中值定理", "换元积分": "不定积分", "洛必达": "洛必达法则"},
    "ds": {"最短路径": "图的应用", "排序算法": "排序", "遍历": "二叉树"},
}
SUFFIX = re.compile(r"(的概念与特征|的原理与组成|的必要条件|的概念与性质|的定义|的概念|的性质|的应用|的分类|与连续|问题|算法|机制|方式|技术|法则|公式|定理|实现互斥|各级别|系统概念)$")


class Input(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class FragmentInput(Input):
    text: str
    source: Literal["text", "photo"] = "text"

    @field_validator("text")
    @classmethod
    def text_required(cls, value):
        if not value.strip():
            raise ValueError("请粘贴老师说的话")
        return value


class IncludeInput(Input):
    kp_id: str
    include: bool | None


class ConflictInput(Input):
    choice: Literal["excluded", "emphasized"]


class FormatType(Input):
    type: Literal["single", "fill", "calc", "short", "proof", "design"]
    count: int = Field(ge=0)
    score: float = Field(ge=0, allow_inf_nan=False)


class FormatInput(Input):
    types: list[FormatType]
    duration_min: int | None = Field(default=None, ge=0)
    open_book: bool | None = None

    @model_validator(mode="after")
    def distinct_types(self):
        if len({item.type for item in self.types}) != len(self.types):
            raise ValueError("同一题型只能设置一次")
        return self


def own_course(conn, user_id, course_id):
    row = conn.execute("SELECT * FROM courses WHERE id=? AND user_id=?", (course_id, user_id)).fetchone()
    if row is None:
        raise not_found("课程")
    return row


def votes(conn, course_id):
    rows = conn.execute(
        "SELECT fm.kp_id,fm.level FROM focus_matches fm "
        "JOIN fragments f ON f.id=fm.fragment_id JOIN knowledge_points k ON k.id=fm.kp_id "
        "WHERE f.course_id=? AND k.course_id=? AND (fm.user_choice=1 OR (fm.user_choice IS NULL AND fm.certainty='sure'))",
        (course_id, course_id),
    )
    result = {}
    for row in rows:
        result.setdefault(row["kp_id"], set()).add(row["level"])
    return result


def levels(conn, course_id):
    evidence = votes(conn, course_id)
    choices = {row["kp_id"]: row["choice"] for row in conn.execute(
        "SELECT kp_id,choice FROM focus_conflicts WHERE course_id=?", (course_id,)
    )}
    result = {}
    for kp_id, evidence_levels in evidence.items():
        if {"excluded", "emphasized"}.issubset(evidence_levels):
            result[kp_id] = choices[kp_id] if kp_id in choices and choices[kp_id] is not None else "conflict"
        elif "emphasized" in evidence_levels:
            result[kp_id] = "emphasized"
        elif "mentioned" in evidence_levels:
            result[kp_id] = "mentioned"
        else:
            result[kp_id] = "excluded"
    return result


def sync_conflicts(conn, user_id, course_id):
    """Keep conflict records for the current opposing included evidence."""
    conflicting = {kp_id for kp_id, evidence in votes(conn, course_id).items() if {"excluded", "emphasized"}.issubset(evidence)}
    existing = {row["kp_id"]: row for row in conn.execute(
        "SELECT * FROM focus_conflicts WHERE course_id=?", (course_id,)
    )}
    snapshots = []
    for kp_id, row in existing.items():
        if kp_id not in conflicting:
            snapshots.append(("focus_conflicts", {"id": row["id"]}, dict(row)))
            conn.execute("DELETE FROM focus_conflicts WHERE id=?", (row["id"],))
    for kp_id in conflicting - existing.keys():
        conflict_id = uuid4().hex
        conn.execute("INSERT INTO focus_conflicts(id,user_id,course_id,kp_id,choice) VALUES(?,?,?,?,NULL)",
                     (conflict_id, user_id, course_id, kp_id))
        snapshots.append(("focus_conflicts", {"id": conflict_id}, None))
    return snapshots


def split_fragments(text):
    return [part.strip() for part in re.split(r"(?<=[。！？!?；;\n])", text) if part.strip()]


def save_fragments(conn, user_id, course_id, text, source="text"):
    ids = []
    for part in split_fragments(text):
        fragment_id = uuid4().hex
        conn.execute("INSERT INTO fragments(id,user_id,course_id,text,source,analyzed,created_at) VALUES(?,?,?,?,?,0,?)",
                     (fragment_id, user_id, course_id, part, source, utc_now().isoformat()))
        ids.append(fragment_id)
    return ids


def normalize(value):
    return re.sub(r"[^\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9]", "", value).lower()


def keywords(title):
    words = {normalize(title)}
    stripped = normalize(SUFFIX.sub("", title))
    if len(stripped) >= 2:
        words.add(stripped)
    words.update(word.lower() for word in re.findall(r"[A-Za-z]{2,}", title))
    return [word for word in words if len(word) >= 2]


def seed_focus(conn, user_id, course_id, text, seed_key, words):
    """Map only the checked-in sample content with the mock's deterministic rules."""
    fragment_ids = save_fragments(conn, user_id, course_id, text)
    kps = conn.execute("SELECT * FROM knowledge_points WHERE course_id=? ORDER BY position", (course_id,)).fetchall()
    topics = conn.execute("SELECT * FROM topics WHERE course_id=?", (course_id,)).fetchall()
    topics_by_title = {row["title"]: row["id"] for row in topics}
    by_id = {row["id"]: row for row in kps}
    for fragment_id in fragment_ids:
        fragment = conn.execute("SELECT text FROM fragments WHERE id=?", (fragment_id,)).fetchone()
        sentence = normalize(fragment["text"])
        level = "excluded" if any(word in fragment["text"] for word in words["exclude"]) else "emphasized" if any(word in fragment["text"] for word in words["emphasize"]) else "mentioned"
        picked = {}
        for kp in kps:
            if any(word in sentence for word in keywords(kp["title"])):
                picked[kp["id"]] = "sure"
        for alias, title in ALIASES[seed_key].items():
            if normalize(alias) not in sentence or title not in topics_by_title:
                continue
            in_topic = [kp for kp in kps if kp["topic_id"] == topics_by_title[title]]
            for index, kp in enumerate(in_topic):
                if kp["id"] not in picked:
                    picked[kp["id"]] = "maybe" if index == 0 and len(in_topic) > 2 else "sure"
        for kp_id in tuple(picked):
            kp = by_id[kp_id]
            following = next((candidate for candidate in kps if candidate["topic_id"] == kp["topic_id"] and candidate["position"] == kp["position"] + 1), None)
            if following is not None and following["id"] not in picked and picked[kp_id] == "sure" and level != "excluded":
                picked[following["id"]] = "maybe"
        conn.executemany("INSERT INTO focus_matches(id,user_id,fragment_id,kp_id,level,certainty,user_choice) VALUES(?,?,?,?,?,?,NULL)",
                         [(uuid4().hex, user_id, fragment_id, kp_id, level, certainty) for kp_id, certainty in picked.items()])
        conn.execute("UPDATE fragments SET analyzed=1 WHERE id=?", (fragment_id,))
    sync_conflicts(conn, user_id, course_id)
    return fragment_ids


def view(conn, user, course_id):
    fragments = []
    for row in conn.execute("SELECT * FROM fragments WHERE course_id=? AND user_id=? ORDER BY created_at,rowid", (course_id, user.id)):
        matches = conn.execute(
            "SELECT fm.*,kp.title FROM focus_matches fm JOIN knowledge_points kp ON kp.id=fm.kp_id "
            "WHERE fm.fragment_id=? ORDER BY fm.rowid", (row["id"],)
        ).fetchall()
        fragments.append({"id": row["id"], "text": row["text"], "found": bool(matches),
                          "created_at": local_iso(row["created_at"], user.timezone), "kps": [
                              {"id": match["kp_id"], "title": match["title"], "level": match["level"],
                               "certainty": match["certainty"], "user_choice": None if match["user_choice"] is None else bool(match["user_choice"]),
                               "included": bool(match["user_choice"]) if match["user_choice"] is not None else match["certainty"] == "sure"}
                              for match in matches]})
    conflicts = conn.execute(
        "SELECT fc.*,kp.title FROM focus_conflicts fc JOIN knowledge_points kp ON kp.id=fc.kp_id "
        "WHERE fc.course_id=? AND fc.user_id=? AND fc.choice IS NULL ORDER BY kp.position", (course_id, user.id)
    ).fetchall()
    job = conn.execute(
        "SELECT * FROM jobs WHERE user_id=? AND course_id=? AND kind='focus' "
        "ORDER BY created_at DESC,rowid DESC LIMIT 1", (user.id, course_id)
    ).fetchone()
    return {"course_id": course_id, "fragments": fragments, "conflicts": [
        {"id": row["id"], "kp_id": row["kp_id"], "title": row["title"],
         "text": f"关于“{row['title']}”，一句说不考，一句说强调", "choice": row["choice"]} for row in conflicts],
        "job": job_view(job, user.timezone) if job is not None and job["status"] != "done" else None}


def exam_format(conn, course_id):
    return load(conn.execute("SELECT value FROM course_formats WHERE course_id=?", (course_id,)).fetchone()["value"])


def set_format(conn, user, course_id, value):
    before = conn.execute("SELECT * FROM course_formats WHERE course_id=?", (course_id,)).fetchone()
    undo = None
    if load(before["value"]) != value:
        conn.execute("UPDATE course_formats SET value=? WHERE course_id=?", (dump(value), course_id))
        undo = record(conn, user, label="已修改考试形式", summary="考试形式恢复原样", affects=["focus", "practice"],
                      rows=[("course_formats", {"course_id": course_id}, dict(before))])
    return {"result": value, "affects": ["focus", "practice"], "undo": undo}


@router.get("/courses/{course_id}/focus")
def get_focus(course_id: str, request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        own_course(conn, user.id, course_id)
        return view(conn, user, course_id)


def submit_fragments(conn, user, course_id, text, source="text"):
    own_course(conn, user.id, course_id)
    ids = save_fragments(conn, user.id, course_id, text, source)
    has_kps = conn.execute("SELECT 1 FROM knowledge_points WHERE course_id=? LIMIT 1", (course_id,)).fetchone() is not None
    job = new_job(conn, user, "focus", course_id, course_id=course_id,
                  stage="分析老师重点" if has_kps else "等待资料整理", payload={"fragment_ids": ids})
    return ids, job


def fragment_undo(conn, user, ids):
    return record(conn, user, label="已记下老师说的重点", summary="删掉刚记的老师原话",
                  affects=["focus", "map", "course", "today", "schedule"],
                  rows=[("fragments", {"id": fid}, None) for fid in ids])


@router.post("/courses/{course_id}/focus/fragments")
def add_fragments(course_id: str, body: FragmentInput, request: Request, user: User):
    require_member(user)
    def create():
        submit_fragments(conn, user, course_id, body.text, body.source)
        return 200, view(conn, user, course_id)
    with request.app.state.db.transaction(write=True) as conn:
        _, result = idempotent(conn, request, user, create)
    request.app.state.events.publish(user.id, changed(["focus", "course"], course_id))
    return result


@router.delete("/focus/fragments/{fragment_id}")
def delete_fragment(fragment_id: str, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        fragment = conn.execute("SELECT * FROM fragments WHERE id=? AND user_id=?", (fragment_id, user.id)).fetchone()
        if fragment is None:
            raise not_found("这句原话")
        course_id = fragment["course_id"]
        matches = conn.execute("SELECT * FROM focus_matches WHERE fragment_id=?", (fragment_id,)).fetchall()
        snapshots = [("focus_matches", {"id": row["id"]}, dict(row)) for row in matches]
        snapshots.append(("fragments", {"id": fragment_id}, dict(fragment)))
        conn.execute("DELETE FROM fragments WHERE id=?", (fragment_id,))
        snapshots += sync_conflicts(conn, user.id, course_id)
        affects = ["focus", "map", "course", "today"]
        undo = record(conn, user, label="已删除这句原话", summary="恢复这句原话", affects=affects, rows=snapshots)
        result = {"result": view(conn, user, course_id), "affects": affects, "undo": undo}
    request.app.state.events.publish(user.id, changed(affects, course_id))
    return result


@router.post("/courses/{course_id}/focus/kps")
def include_kp(course_id: str, body: IncludeInput, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        own_course(conn, user.id, course_id)
        kp = conn.execute("SELECT id FROM knowledge_points WHERE id=? AND user_id=? AND course_id=?", (body.kp_id, user.id, course_id)).fetchone()
        if kp is None:
            raise not_found("知识点")
        rows = conn.execute(
            "SELECT fm.* FROM focus_matches fm JOIN fragments f ON f.id=fm.fragment_id WHERE f.course_id=? AND fm.kp_id=?",
            (course_id, body.kp_id),
        ).fetchall()
        snapshots = []
        for row in rows:
            if row["user_choice"] == body.include:
                continue
            snapshots.append(("focus_matches", {"id": row["id"]}, dict(row)))
            conn.execute("UPDATE focus_matches SET user_choice=? WHERE id=?", (body.include, row["id"]))
        snapshots += sync_conflicts(conn, user.id, course_id)
        affects = ["focus", "map", "course", "today"]
        label = "已移除" if body.include is False else "已选入" if body.include is True else "已恢复"
        undo = record(conn, user, label=label, summary="恢复原来的选择", affects=affects, rows=snapshots)
        result = {"result": view(conn, user, course_id), "affects": affects, "undo": undo}
    request.app.state.events.publish(user.id, changed(affects, course_id))
    return result


@router.post("/focus/conflicts/{conflict_id}")
def resolve_conflict(conflict_id: str, body: ConflictInput, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        before = conn.execute("SELECT * FROM focus_conflicts WHERE id=? AND user_id=?", (conflict_id, user.id)).fetchone()
        if before is None:
            raise not_found("重点冲突")
        course_id = before["course_id"]
        affects = ["focus", "map", "course", "today"]
        undo = None
        if before["choice"] != body.choice:
            conn.execute("UPDATE focus_conflicts SET choice=? WHERE id=?", (body.choice, conflict_id))
            undo = record(conn, user, label="已选定", summary="恢复原来的冲突选择", affects=affects,
                          rows=[("focus_conflicts", {"id": conflict_id}, dict(before))])
        result = {"result": view(conn, user, course_id), "affects": affects, "undo": undo}
    request.app.state.events.publish(user.id, changed(affects, course_id))
    return result


@router.get("/courses/{course_id}/exam-format")
def get_format(course_id: str, request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        own_course(conn, user.id, course_id)
        return exam_format(conn, course_id)


@router.put("/courses/{course_id}/exam-format")
def put_format(course_id: str, body: FormatInput, request: Request, user: User):
    require_member(user)
    kinds = {item.type: item.model_dump() for item in body.types}
    value = {"types": [kinds[kind] if kind in kinds else {"type": kind, "count": 0, "score": 0} for kind in QUESTION_TYPES],
             "duration_min": body.duration_min, "open_book": body.open_book, "basis": "user"}
    with request.app.state.db.transaction(write=True) as conn:
        own_course(conn, user.id, course_id)
        result = set_format(conn, user, course_id, value)
    request.app.state.events.publish(user.id, changed(result["affects"], course_id))
    return result
