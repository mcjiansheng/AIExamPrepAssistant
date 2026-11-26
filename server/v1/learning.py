from datetime import date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request

from . import courses, plans
from .auth import Body, Principal, new_id, principal
from .db import load, utc_now
from .errors import not_found
from .events import changed
from .undo import record

router = APIRouter()
AREAS = ["map", "today", "course", "kp", "insight"]
INTENSITY = {"easy": 1.3, "standard": 1.0, "sprint": 0.7}


class Understood(Body):
    task_id: str | None = None


class Mark(Body):
    mark: Literal["shaky", "mastered"] | None


def recompute_progress(conn, user, kp_id):
    history = conn.execute(
        "SELECT * FROM learning_events WHERE kp_id=? AND counted=1 ORDER BY created_at,rowid", (kp_id,),
    ).fetchall()
    stability = due = last = None
    if history:
        for event in history:
            if stability is None:
                stability = 2.0 if event["outcome"] == "correct" else 0.5
            elif event["outcome"] == "wrong":
                stability = max(0.5, stability * 0.5)
            else:
                stability *= 1.5 if event["hinted"] or event["outcome"] == "partial" else 2.5
        last = history[-1]["created_at"]
        zone = ZoneInfo(user.timezone)
        reviewed = datetime.fromisoformat(last).astimezone(zone)
        intensity = conn.execute("SELECT intensity FROM settings WHERE user_id=?", (user.id,)).fetchone()[0]
        interval = stability * INTENSITY[intensity]
        exam = conn.execute(
            """SELECT c.exam_date FROM courses c JOIN knowledge_points kp ON kp.course_id=c.id
               WHERE kp.id=?""", (kp_id,),
        ).fetchone()[0]
        if exam:
            remaining = (date.fromisoformat(exam) - reviewed.date()).days
            interval = min(interval, max(1, remaining // 2))
        due = (reviewed + timedelta(days=interval)).date().isoformat()
    conn.execute(
        """INSERT INTO kp_progress(kp_id,user_id,stability,due_at,last_review_at) VALUES (?,?,?,?,?)
        ON CONFLICT(kp_id) DO UPDATE SET stability=excluded.stability,due_at=excluded.due_at,
        last_review_at=excluded.last_review_at""", (kp_id, user.id, stability, due, last),
    )


def snapshot_readiness(conn, user, course_id):
    value = courses.readiness(conn, course_id)
    ratio = value["mastered"] / value["total"] if value["total"] else 0
    conn.execute(
        """INSERT INTO readiness_snapshots(course_id,user_id,date,ratio) VALUES (?,?,?,?)
        ON CONFLICT(course_id,date) DO UPDATE SET ratio=excluded.ratio""",
        (course_id, user.id, str(plans.local_today(user)), ratio),
    )


def record_event(conn, user, kp_id, bank_id, session_id, question_id, outcome, *, counted, hinted):
    point = courses.kp(conn, user.id, kp_id)
    cid = point["course_id"]
    before = courses.kp_states(conn, cid)[kp_id]
    conn.execute(
        """INSERT INTO learning_events(id,user_id,kp_id,bank_id,session_id,question_id,outcome,counted,hinted,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(question_id) WHERE question_id IS NOT NULL
        DO UPDATE SET outcome=excluded.outcome,counted=excluded.counted,hinted=excluded.hinted,created_at=excluded.created_at""",
        (new_id("ev"), user.id, kp_id, bank_id, session_id, question_id, outcome, int(counted), int(hinted), utc_now().isoformat()),
    )
    if counted:
        recompute_progress(conn, user, kp_id)
    after = courses.kp_states(conn, cid)[kp_id]
    if before == after:
        return []
    snapshot_readiness(conn, user, cid)
    plans.replan(conn, user)
    return [{"kp_id": kp_id, "title": point["title"], "from": before, "to": after}]


def applicable_task(conn, user, task_id, point):
    if task_id is None:
        return None
    row = plans.task(conn, user.id, task_id)
    if row["course_id"] != point["course_id"] or row["kind"] != "learn" or point["id"] not in load(row["kp_ids"]):
        raise not_found("任务")
    return row


def complete_learn_task(conn, user, row):
    if row is None or row["status"] != "todo":
        return False
    if not all(plans.learned(conn, user.id, kid) for kid in load(row["kp_ids"])):
        return False
    conn.execute("UPDATE schedule_items SET status='done' WHERE id=?", (row["id"],))
    conn.execute(
        """INSERT INTO learning_activity(id,user_id,kind,minutes,created_at,course_id)
        VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING""",
        (f"task:{row['id']}", user.id, "learn", row["minutes"], utc_now().isoformat(), row["course_id"]),
    )
    return True


def task_for_quiz(conn, user, kp_id, course_id):
    tasks = conn.execute(
        """SELECT * FROM schedule_items WHERE user_id=? AND course_id=? AND date=? AND kind='learn' AND status='todo'
        ORDER BY position""", (user.id, course_id, str(plans.local_today(user))),
    )
    return next((row for row in tasks if kp_id in load(row["kp_ids"])), None)


def finish_understood(conn, user, kid, task_id=None):
    point = courses.kp(conn, user.id, kid)
    row = applicable_task(conn, user, task_id, point)
    progress = conn.execute("SELECT * FROM kp_progress WHERE kp_id=?", (kid,)).fetchone()
    snapshots = []
    if progress is None or progress["understood_at"] is None:
        snapshots.append(("kp_progress", {"kp_id": kid}, dict(progress) if progress is not None else None))
        conn.execute(
            """INSERT INTO kp_progress(kp_id,user_id,understood_at) VALUES (?,?,?)
               ON CONFLICT(kp_id) DO UPDATE SET understood_at=excluded.understood_at""",
            (kid, user.id, utc_now().isoformat()),
        )
    if row is not None:
        activity_id = f"task:{row['id']}"
        existed = conn.execute("SELECT 1 FROM learning_activity WHERE id=?", (activity_id,)).fetchone()
        if complete_learn_task(conn, user, row):
            snapshots.append(("schedule_items", {"id": row["id"]}, dict(row)))
            if existed is None:
                snapshots.append(("learning_activity", {"id": activity_id}, None))
            row = plans.task(conn, user.id, row["id"])
    if row is not None:
        candidates = load(row["kp_ids"])
    else:
        candidates = [candidate[0] for candidate in conn.execute(
            "SELECT id FROM active_knowledge_points WHERE topic_id=? AND position>? ORDER BY position",
            (point["topic_id"], point["position"]),
        )]
    next_kp = next((candidate for candidate in candidates if candidate != kid and not plans.learned(conn, user.id, candidate)), None)
    view = {"kp": courses.kp_brief(conn, user, point), "next_kp_id": next_kp,
            "task": plans.task_view(conn, row) if row is not None else None}
    undo = record(conn, user, label="已标记懂了", summary="学习状态已恢复", affects=AREAS, rows=snapshots)
    return {"result": view, "affects": AREAS, "undo": undo}


@router.post("/kps/{kid}/understood")
def understood(kid: str, request: Request, body: Understood, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        result = finish_understood(conn, user, kid, body.task_id)
    request.app.state.events.publish(user.id, changed(AREAS, result["result"]["kp"]["course_id"]))
    return result


@router.post("/kps/{kid}/mark")
def mark(kid: str, request: Request, body: Mark, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        point = courses.kp(conn, user.id, kid)
        before = conn.execute("SELECT * FROM kp_progress WHERE kp_id=?", (kid,)).fetchone()
        snapshots = []
        if (before["mark"] if before is not None else None) != body.mark:
            conn.execute(
                """INSERT INTO kp_progress(kp_id,user_id,mark) VALUES (?,?,?)
                   ON CONFLICT(kp_id) DO UPDATE SET mark=excluded.mark""", (kid, user.id, body.mark),
            )
            snapshots.append(("kp_progress", {"kp_id": kid}, dict(before) if before is not None else None))
            snapshots += plans.replan(conn, user)
        undo = record(conn, user, label="已更新标记", summary="原标记已恢复", affects=AREAS, rows=snapshots)
        result = {"result": courses.kp_brief(conn, user, point), "affects": AREAS, "undo": undo}
    request.app.state.events.publish(user.id, changed(AREAS, point["course_id"]))
    return result


@router.get("/courses/{cid}/insight")
def insight(cid: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        courses.course(conn, user.id, cid)
        states = courses.kp_states(conn, cid)
        readiness = courses.readiness(conn, cid, states)
        ratio = readiness["mastered"] / readiness["total"] if readiness["total"] else 0
        dates = {row["date"]: row["ratio"] for row in conn.execute(
            "SELECT date,ratio FROM readiness_snapshots WHERE user_id=? AND course_id=? ORDER BY date", (user.id, cid),
        )}
        dates[str(plans.local_today(user))] = ratio
        chapters = []
        for chapter in courses.map_view(conn, cid, states)["chapters"]:
            counts = {state: sum(point["state"] == state for point in chapter["kps"])
                      for state in ("new", "learned", "shaky", "mastered")}
            chapters.append({"id": chapter["id"], "title": chapter["title"], **counts})
        minutes = dict.fromkeys(("learn", "practice", "review", "mock"), 0)
        for row in conn.execute(
            "SELECT kind,SUM(minutes) AS minutes FROM learning_activity WHERE user_id=? AND course_id=? GROUP BY kind",
            (user.id, cid),
        ):
            minutes[row["kind"]] = round(row["minutes"])
        return {
            "course_id": cid,
            "verdict": f"已掌握 {readiness['mastered']} 个重点，还有 {readiness['total'] - readiness['mastered']} 个要复习"
            if readiness["total"] else "整理资料后，就能看到这门课的学情",
            "readiness": [{"date": on, "ratio": value} for on, value in sorted(dates.items())],
            "chapters": chapters, "weak": courses.weak_kps(conn, user, cid, states, limit=6),
            "minutes": {"total": sum(minutes.values()), **minutes},
        }
