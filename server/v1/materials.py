"""Stored material metadata, source pages, and reversible decisions."""
import base64
import hashlib
from datetime import timedelta
import re
import secrets
from typing import Annotated, Literal
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict

from .auth import Principal, principal, require_member
from .db import dump, load, local_iso, utc_now
from .errors import ApiError, conflict, not_found
from .events import changed
from .idempotency import run as idempotent
from .undo import record

router = APIRouter()
User = Annotated[Principal, Depends(principal)]


class Input(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class KindInput(Input):
    kind: Literal["slides", "homework", "notes", "review", "past_paper", "photo", "other"]


class DecisionInput(Input):
    choice: str


def owned(conn, user_id, material_id):
    row = conn.execute("SELECT * FROM materials WHERE id=? AND user_id=?", (material_id, user_id)).fetchone()
    if row is None:
        raise not_found("资料")
    return row


def own_course(conn, user_id, course_id):
    row = conn.execute("SELECT id FROM courses WHERE id=? AND user_id=?", (course_id, user_id)).fetchone()
    if row is None:
        raise not_found("课程")
    return row


def view(conn, row, timezone):
    counts = conn.execute(
        "SELECT count(DISTINCT kp_id) FROM kp_refs WHERE material_id=?", (row["id"],)
    ).fetchone()[0]
    questions = conn.execute(
        "SELECT count(*) FROM bank_questions b WHERE b.user_id=? AND (b.kp_id IN "
        "(SELECT kp_id FROM kp_refs WHERE material_id=?) OR EXISTS "
        "(SELECT 1 FROM json_each(b.refs) ref WHERE json_extract(ref.value,'$.material_id')=?))",
        (row["user_id"], row["id"], row["id"]),
    ).fetchone()[0]
    return {
        "id": row["id"], "course_id": row["course_id"], "title": row["title"],
        "kind": row["kind"], "source": row["source"], "pages": row["pages"],
        "status": row["status"], "stage": row["stage"], "progress": row["progress"],
        "kp_count": counts if row["status"] == "ready" else None, "question_count": questions,
        "vision": row["vision"], "superseded_by": row["superseded_by"],
        "decision": load(row["decision"]), "skipped_pages": load(row["skipped_pages"]),
        "error": load(row["error"]), "uploaded_at": local_iso(row["uploaded_at"], timezone),
    }


def page_row(conn, material_id, number):
    row = conn.execute("SELECT * FROM material_pages WHERE material_id=? AND page=?", (material_id, number)).fetchone()
    if row is None:
        raise not_found("这一页")
    return row


def image_file(request, page):
    root = request.app.state.data_dir.resolve()
    path = (root / page["image_path"]).resolve()
    if not path.is_relative_to(root):
        raise not_found("页面图片")
    return path


def page_view(conn, user, material, page, request):
    from .courses import kp_brief
    kps = conn.execute(
        "SELECT kp.* FROM knowledge_points kp WHERE kp.user_id=? AND kp.id IN "
        "(SELECT kp_id FROM kp_refs WHERE material_id=? AND page=?) ORDER BY kp.position",
        (user.id, material["id"], page["page"]),
    ).fetchall()
    image_url = None
    if page["image_path"] is not None:
        encoded = base64.b64encode(image_file(request, page).read_bytes()).decode("ascii")
        image_url = f"data:image/png;base64,{encoded}"
    return {
        "material_id": material["id"], "material_title": material["title"],
        "page": page["page"], "total": material["pages"], "text": page["text"],
        "image_url": image_url, "kps": [kp_brief(conn, user, kp) for kp in kps],
    }


def update_kind(conn, user, material, kind):
    undo = None
    if material["kind"] != kind:
        conn.execute("UPDATE materials SET kind=? WHERE id=?", (kind, material["id"]))
        undo = record(conn, user, label="已修改资料类型", summary="恢复原来的类型", affects=["materials", "map", "course"],
                      rows=[("materials", {"id": material["id"]}, dict(material))])
    return {"result": view(conn, owned(conn, user.id, material["id"]), user.timezone),
            "affects": ["materials", "map", "course"], "undo": undo}


def apply_decision(conn, user, material, choice):
    decision = load(material["decision"])
    if decision is None:
        raise conflict("这份资料没有需要修改的判断")
    if choice not in {option["id"] for option in decision["options"]}:
        raise ApiError(400, "bad_request", "请选择这份资料提供的选项")
    affects = ["materials", "map", "course", "courses", "today", "schedule"]
    if decision["choice"] == choice:
        return {"result": view(conn, material, user.timezone), "affects": affects, "undo": None}
    members = [material]
    if decision["kind"] == "version":
        members = conn.execute(
            "SELECT * FROM materials WHERE user_id=? AND course_id=? AND version_group=? ORDER BY uploaded_at,id",
            (user.id, material["course_id"], material["version_group"]),
        ).fetchall()
    snapshots = [("materials", {"id": row["id"]}, dict(row)) for row in members]
    updated_decision = {**decision, "choice": choice}
    if decision["kind"] == "version":
        target = members[0]["id"] if choice == "old" else members[-1]["id"]
        for row in members:
            superseded_by = None if choice == "both" or row["id"] == target else target
            conn.execute("UPDATE materials SET superseded_by=? WHERE id=?", (superseded_by, row["id"]))
        conn.execute("UPDATE materials SET decision=? WHERE id=?", (dump(updated_decision), material["id"]))
    else:
        kind = "slides" if choice == "slides" else "past_paper" if re.search(r"往年|真题|试卷", material["title"]) else "review"
        conn.execute("UPDATE materials SET decision=?,kind=? WHERE id=?", (dump(updated_decision), kind, material["id"]))
    undo = record(conn, user, label="已改正判断", summary="恢复原来的判断", affects=affects, rows=snapshots)
    return {"result": view(conn, owned(conn, user.id, material["id"]), user.timezone), "affects": affects, "undo": undo}


def delete_material(conn, user, material):
    material_id = material["id"]
    candidate_ids = [row["kp_id"] for row in conn.execute("SELECT DISTINCT kp_id FROM kp_refs WHERE material_id=?", (material_id,))]
    conn.execute(
        "DELETE FROM bank_questions WHERE user_id=? AND EXISTS "
        "(SELECT 1 FROM json_each(bank_questions.refs) ref WHERE json_extract(ref.value,'$.material_id')=?)",
        (user.id, material_id),
    )
    conn.execute("DELETE FROM materials WHERE id=?", (material_id,))
    conn.executemany(
        "DELETE FROM knowledge_points WHERE id=? AND NOT EXISTS (SELECT 1 FROM kp_refs WHERE kp_id=knowledge_points.id)",
        [(kp_id,) for kp_id in candidate_ids],
    )
    conn.execute("DELETE FROM topics WHERE course_id=? AND NOT EXISTS (SELECT 1 FROM knowledge_points WHERE topic_id=topics.id)", (material["course_id"],))
    conn.execute("DELETE FROM chapters WHERE course_id=? AND NOT EXISTS (SELECT 1 FROM knowledge_points WHERE chapter_id=chapters.id)", (material["course_id"],))


@router.get("/courses/{course_id}/materials")
def materials(course_id: str, request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        own_course(conn, user.id, course_id)
        rows = conn.execute("SELECT * FROM materials WHERE course_id=? AND user_id=? ORDER BY uploaded_at DESC,id DESC", (course_id, user.id)).fetchall()
        return [view(conn, row, user.timezone) for row in rows]


@router.patch("/materials/{material_id}")
def patch_kind(material_id: str, body: KindInput, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        material = owned(conn, user.id, material_id)
        result = update_kind(conn, user, material, body.kind)
        course_id = material["course_id"]
    request.app.state.events.publish(user.id, changed(result["affects"], course_id))
    return result


@router.post("/materials/{material_id}/decision")
def decide(material_id: str, body: DecisionInput, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        material = owned(conn, user.id, material_id)
        result = apply_decision(conn, user, material, body.choice)
        course_id = material["course_id"]
    request.app.state.events.publish(user.id, changed(result["affects"], course_id))
    return result


@router.delete("/materials/{material_id}", status_code=204)
def remove_material(material_id: str, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        material = owned(conn, user.id, material_id)
        delete_material(conn, user, material)
        course_id = material["course_id"]
    request.app.state.events.publish(user.id, changed(["materials", "map", "kp", "focus", "course", "courses", "today", "schedule", "practice", "mistakes", "insight"], course_id))
    return Response(status_code=204)


@router.get("/materials/{material_id}/pages")
def pages(material_id: str, request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        owned(conn, user.id, material_id)
        rows = conn.execute("SELECT page,title FROM material_pages WHERE material_id=? ORDER BY page", (material_id,)).fetchall()
        return {"pages": [{"page": row["page"], "title": row["title"], "thumb_url": None} for row in rows]}


@router.get("/materials/{material_id}/pages/{number}")
def page(material_id: str, number: int, request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        material = owned(conn, user.id, material_id)
        return page_view(conn, user, material, page_row(conn, material_id, number), request)


@router.get("/materials/{material_id}/pages/{number}/image")
def image(material_id: str, number: int, request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        owned(conn, user.id, material_id)
        page = page_row(conn, material_id, number)
        if page["image_path"] is None:
            raise not_found("页面图片")
    return Response(content=image_file(request, page).read_bytes(), media_type="image/png")


@router.post("/courses/{course_id}/photo-link")
def photo_link(course_id: str, request: Request, user: User):
    require_member(user)
    def create():
        own_course(conn, user.id, course_id)
        token = secrets.token_urlsafe(32)
        expires_at = (utc_now() + timedelta(minutes=10)).isoformat()
        conn.execute("DELETE FROM photo_links WHERE expires_at<=?", (utc_now().isoformat(),))
        conn.execute("INSERT INTO photo_links(id,user_id,course_id,token_hash,expires_at) VALUES(?,?,?,?,?)",
                     (uuid4().hex, user.id, course_id, hashlib.sha256(token.encode()).hexdigest(), expires_at))
        return 200, {"url": f"fullgrid://photo?{urlencode({'course': course_id, 't': token})}",
                     "expires_at": local_iso(expires_at, user.timezone)}
    with request.app.state.db.transaction(write=True) as conn:
        _, result = idempotent(conn, request, user, create)
    return result
