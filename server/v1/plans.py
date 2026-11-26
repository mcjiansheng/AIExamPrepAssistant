import math
from collections import defaultdict
from datetime import date, timedelta
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request
from pydantic import Field, field_validator

from . import accounts, courses
from .auth import Body, Principal, new_id, principal
from .db import dump, load, utc_now
from .errors import ApiError, not_found
from .events import changed
from .undo import record

router = APIRouter()
AREAS = ["today", "schedule"]
HORIZON = 14
LABELS = {"emphasized": "老师强调", "conflict": "老师强调", "mentioned": "老师提到过", "none": "课件内容"}


class Minutes(Body):
    minutes: Annotated[int, Field(ge=30, le=600)]


class TaskPatch(Body):
    status: Literal["todo", "done", "skipped"] = None
    date: str = None
    pinned: bool = None

    @field_validator("date")
    @classmethod
    def day(cls, value):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("日期格式应为 YYYY-MM-DD")
        return value


def local_today(user):
    return utc_now().astimezone(ZoneInfo(user.timezone)).date()


def date_span(start, count):
    return [start + timedelta(days=offset) for offset in range(count)]


def task(conn, user_id, task_id):
    row = conn.execute("SELECT * FROM schedule_items WHERE user_id=? AND id=?", (user_id, task_id)).fetchone()
    if row is None:
        raise not_found("任务")
    return row


def learned(conn, user_id, kp_id):
    return conn.execute(
        """SELECT 1 WHERE EXISTS (SELECT 1 FROM kp_progress WHERE kp_id=? AND understood_at IS NOT NULL)
        OR EXISTS (
            SELECT 1 FROM practice_sessions s JOIN practice_questions q ON q.session_id=s.id
            WHERE s.user_id=? AND s.kind='kp' AND s.status='finished' AND q.kp_id=?
            GROUP BY s.id HAVING COUNT(*)=COUNT(q.attempt) AND COUNT(*)>0
        )""", (kp_id, user_id, kp_id),
    ).fetchone() is not None


def task_view(conn, row):
    ids = load(row["kp_ids"])
    progress = None
    if row["kind"] == "learn" and ids:
        done = sum(learned(conn, row["user_id"], kid) for kid in ids)
        progress = {"done": done, "total": len(ids)}
    return {
        key: row[key]
        for key in ("id", "course_id", "date", "kind", "title", "minutes", "status", "reason", "moved_from", "session_id")
    } | {"pinned": bool(row["pinned"]), "kp_ids": ids, "progress": progress}


def urgency(course, on):
    if course["exam_date"] is None:
        return 0.5
    days = (date.fromisoformat(course["exam_date"]) - on).days
    return 4 if days <= 2 else 1 + 6 / days


def available(conn, user_id, day, default):
    row = conn.execute("SELECT minutes FROM schedule_day_budget WHERE user_id=? AND date=?", (user_id, str(day))).fetchone()
    return row[0] if row is not None else default


def course_task_order(row):
    priorities = {"review": 0, "learn": 2, "mock": 3, "mistakes": 4, "practice": 5}
    priority = 1 if row["moved_from"] and row["kind"] != "review" else priorities[row["kind"]]
    return priority, row["position"], row["created_at"], row["id"]


def ordered(rows, course_rows, day):
    return sorted(rows, key=lambda row: (-urgency(course_rows[row["course_id"]], day), *course_task_order(row)))


def standing_courses(conn, user_id, day):
    return conn.execute(
        """SELECT * FROM courses WHERE user_id=? AND (exam_date IS NULL OR exam_date>=?)
        ORDER BY exam_date IS NULL, exam_date, created_at, id""", (user_id, str(day)),
    ).fetchall()


def state_for_course(conn, row):
    cid = row["id"]
    return (
        courses.kp_states(conn, cid), courses.kp_levels(conn, cid),
        conn.execute(
            """SELECT k.*, t.title AS topic_title, t.minutes AS topic_minutes, p.due_at,
            COUNT(*) OVER (PARTITION BY k.topic_id) AS topic_size
            FROM active_knowledge_points k JOIN topics t ON t.id=k.topic_id
            LEFT JOIN kp_progress p ON p.kp_id=k.id
            WHERE k.course_id=? ORDER BY k.position""", (cid,),
        ).fetchall(),
    )


def add_task(conn, user, day, course, kind, title, minutes, reason, ids, position):
    task_id = new_id("t")
    conn.execute(
        """INSERT INTO schedule_items (id,user_id,course_id,date,kind,title,minutes,reason,kp_ids,position,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (task_id, user.id, course["id"], str(day), kind, title, minutes, reason, dump(ids), position, utc_now().isoformat()),
    )
    return ("schedule_items", {"id": task_id}, None)


def replan(conn, user, *, dates=None, preserve=()):
    today = local_today(user)
    dates = sorted(set(dates if dates is not None else (today,)))
    current = conn.execute("SELECT daily_minutes FROM settings WHERE user_id=?", (user.id,)).fetchone()[0]
    metadata = {row["id"]: state_for_course(conn, row) for row in standing_courses(conn, user.id, today)}
    snapshots = []
    for day in dates:
        stamp = str(day)
        rows = conn.execute(
            "SELECT * FROM schedule_items WHERE user_id=? AND date=? ORDER BY position", (user.id, stamp),
        ).fetchall()
        kept = []
        for row in rows:
            started = row["session_id"] or (row["kind"] == "learn" and row["status"] == "todo" and
                                            any(learned(conn, user.id, kid) for kid in load(row["kp_ids"])))
            if row["status"] != "todo" or row["pinned"] or row["moved_from"] or started or row["id"] in preserve:
                kept.append(row)
            else:
                snapshots.append(("schedule_items", {"id": row["id"]}, dict(row)))
                conn.execute("DELETE FROM schedule_items WHERE id=?", (row["id"],))
        day_minutes = available(conn, user.id, day, current)
        budget = day_minutes - sum(row["minutes"] for row in kept if row["status"] != "skipped")
        position = max((row["position"] for row in kept), default=-1) + 1
        scheduled = defaultdict(set)
        for row in conn.execute(
            """SELECT kind,kp_ids FROM schedule_items
               WHERE user_id=? AND date>=? AND status<>'skipped'
               AND (date<=? OR pinned=1 OR moved_from IS NOT NULL)""",
            (user.id, str(today), stamp),
        ):
            scheduled[row["kind"]].update(load(row["kp_ids"]))
        rows = standing_courses(conn, user.id, day)
        weights = {}
        for row in rows:
            states, levels, points = metadata[row["id"]]
            need = sum(courses.LEVEL_WEIGHT[levels.get(point["id"], "none")]
                       for point in points if states[point["id"]] != "mastered")
            weights[row["id"]] = urgency(row, day) * need
        weight_total = sum(weights.values())
        for row in sorted(rows, key=lambda candidate: -urgency(candidate, day)):
            if budget < 5:
                break
            cid = row["id"]
            states, levels, points = metadata[cid]
            used = sum(item["minutes"] for item in kept if item["course_id"] == cid and item["status"] != "skipped")
            share = 0
            if weights[cid] > 0:
                ideal = day_minutes * weights[cid] / weight_total
                share = max(15, 5 * math.floor(ideal / 5 + 0.5))
            due = [point["id"] for point in points if point["due_at"] and point["due_at"] <= stamp
                   and levels.get(point["id"], "none") != "excluded" and point["id"] not in scheduled["review"]]
            if due and not share:
                share = min(30, 5 * math.ceil(len(due) * 1.5 / 5))
            cap = row["daily_cap_min"]
            share = max(0, min(budget, (min(share, cap) if cap is not None else share) - used))

            def add(kind, title, minutes, reason, ids):
                nonlocal share, budget, position
                snapshots.append(add_task(conn, user, day, row, kind, title, minutes, reason, ids, position))
                position += 1
                share -= minutes
                budget -= minutes
                scheduled[kind].update(ids)

            due = due[:min(20, math.floor(share / 1.5))]
            if due:
                add("review", f"到期复习 {len(due)} 道", math.ceil(1.5 * len(due)), "按记忆规律到期", due)

            new = [point for point in points if states[point["id"]] == "new"
                   and levels.get(point["id"], "none") != "excluded" and point["id"] not in scheduled["learn"]]
            new.sort(key=lambda point: (-courses.LEVEL_WEIGHT[levels.get(point["id"], "none")], point["position"]))
            while new and share >= 5:
                first = new[0]
                per_point = max(5, math.ceil(first["topic_minutes"] / first["topic_size"]))
                group = [point for point in new if point["topic_id"] == first["topic_id"]][:min(3, max(1, share // per_point))]
                minutes = min(share, per_point * len(group))
                title = group[0]["title"] if len(group) == 1 else first["topic_title"]
                add("learn", title, minutes, f"{LABELS[levels.get(first['id'], 'none')]} · 还没学",
                    [point["id"] for point in group])
                new = [point for point in new if point["id"] not in scheduled["learn"]]
            days_left = (date.fromisoformat(row["exam_date"]) - day).days if row["exam_date"] else None
            if points and days_left is not None and 0 <= days_left <= 7:
                duration = courses.exam_format(conn, cid)["duration_min"]
                recent = conn.execute(
                    """SELECT 1 FROM schedule_items WHERE course_id=? AND kind='mock'
                       AND status<>'skipped' AND date BETWEEN ? AND ?""",
                    (cid, str(day - timedelta(days=2)), str(day + timedelta(days=2))),
                ).fetchone()
                if duration is not None and 0 < duration <= share and recent is None:
                    add("mock", "模拟卷", duration, "按考试形式练一套", [])
            if points and share >= 10 and any(levels.get(point["id"], "none") != "excluded" for point in points):
                add("practice", "快练 5 道", 10, "巩固学过的知识点", [])
    return snapshots


def ensure_plan(conn, user):
    today = local_today(user)
    stamp = str(today)
    state = conn.execute("SELECT planned_on FROM plan_days WHERE user_id=?", (user.id,)).fetchone()
    if state is not None and state["planned_on"] == stamp:
        return
    yesterday = str(today - timedelta(days=1))
    carried = conn.execute(
        """UPDATE schedule_items SET moved_from=date, date=?, reason='昨天没做完'
           WHERE user_id=? AND date=? AND status='todo' AND pinned=0""", (stamp, user.id, yesterday),
    ).rowcount
    conn.execute("UPDATE schedule_items SET status='skipped' WHERE user_id=? AND date<? AND status='todo' AND pinned=0",
                 (user.id, stamp))
    conn.execute(
        """INSERT INTO plan_days (user_id,planned_on,notice,notice_seen) VALUES (?,?,?,0)
           ON CONFLICT(user_id) DO UPDATE SET planned_on=excluded.planned_on,notice=excluded.notice,notice_seen=0""",
        (user.id, stamp, f"昨天有 {carried} 项没做完，已排进今天" if carried else None),
    )
    replan(conn, user, dates=date_span(today, HORIZON))


def listed(conn, user, on):
    course_rows = {row["id"]: row for row in conn.execute("SELECT * FROM courses WHERE user_id=?", (user.id,))}
    tasks = conn.execute("SELECT * FROM schedule_items WHERE user_id=? AND date=?", (user.id, str(on))).fetchall()
    return course_rows, ordered(tasks, course_rows, on)


def brief(todo, countdowns):
    parts = []
    if countdowns:
        nearest = countdowns[0]
        parts.append(f"{nearest['name']}还有 {nearest['days_left']} 天考试。")
    if todo:
        parts.append(f"今天先做「{todo[0]['title']}」。")
    return "".join(parts) or None


def today_view(conn, user, *, consume_notice=False):
    ensure_plan(conn, user)
    on = local_today(user)
    course_rows, all_tasks = listed(conn, user, on)
    prefs = conn.execute("SELECT * FROM settings WHERE user_id=?", (user.id,)).fetchone()
    todo = [task_view(conn, row) for row in all_tasks if row["status"] == "todo"]
    done = [task_view(conn, row) for row in all_tasks if row["status"] != "todo"]
    countdowns = []
    for row in sorted(course_rows.values(), key=lambda c: c["exam_date"] or "9999-12-31"):
        if row["exam_date"] and row["exam_date"] >= str(on):
            days = (date.fromisoformat(row["exam_date"]) - on).days
            countdowns.append({"course_id": row["id"], "name": row["name"], "color": row["color"],
                               "exam_date": row["exam_date"], "days_left": days, "urgent": days <= 3})
    state = conn.execute("SELECT notice,notice_seen FROM plan_days WHERE user_id=?", (user.id,)).fetchone()
    notice = state["notice"] if consume_notice and not state["notice_seen"] else None
    if notice:
        conn.execute("UPDATE plan_days SET notice_seen=1 WHERE user_id=?", (user.id,))
    tomorrow = []
    if not todo:
        _, next_day = listed(conn, user, on + timedelta(days=1))
        tomorrow = [task_view(conn, row) for row in next_day if row["status"] == "todo"][:3]
    return {
        "date": str(on), "briefing": brief(todo, countdowns) if prefs["briefing"] else None,
        "minutes_available": available(conn, user.id, on, prefs["daily_minutes"]),
        "minutes_planned": sum(row["minutes"] for row in all_tasks if row["status"] != "skipped"),
        "progress": {"done": sum(row["status"] == "done" for row in all_tasks),
                     "total": sum(row["status"] != "skipped" for row in all_tasks)},
        "countdowns": countdowns, "resume": accounts.resume_view(conn, user), "tasks": todo,
        "done": done, "notice": notice, "tomorrow": tomorrow,
    }


def next_course_tasks(conn, user, course_id):
    ensure_plan(conn, user)
    tasks = conn.execute(
        "SELECT * FROM schedule_items WHERE user_id=? AND course_id=? AND status='todo' AND date>=?",
        (user.id, course_id, str(local_today(user))),
    )
    upcoming = sorted(tasks, key=lambda row: (row["date"], *course_task_order(row)))[:3]
    return [task_view(conn, row) for row in upcoming]


def day_view(conn, user, on, default):
    course_rows, rows = listed(conn, user, on)
    tasks = [task_view(conn, row) for row in rows if row["status"] != "skipped"]
    return {"date": str(on), "minutes_available": available(conn, user.id, on, default),
            "minutes_planned": sum(row["minutes"] for row in tasks), "tasks": tasks,
            "exams": [{"course_id": row["id"], "name": row["name"], "color": row["color"]}
                      for row in course_rows.values() if row["exam_date"] == str(on)]}


def schedule_view(conn, user, start, end):
    prefs = conn.execute("SELECT daily_minutes,intensity FROM settings WHERE user_id=?", (user.id,)).fetchone()
    return {"from": str(start), "to": str(end), "daily_minutes": prefs["daily_minutes"], "intensity": prefs["intensity"],
            "days": [day_view(conn, user, on, prefs["daily_minutes"])
                     for on in date_span(start, (end - start).days + 1)]}


def set_budget(conn, user, on, minutes):
    row = conn.execute("SELECT * FROM schedule_day_budget WHERE user_id=? AND date=?",
                       (user.id, str(on))).fetchone()
    item_id = row["id"] if row is not None else new_id("bud")
    if row is not None and row["minutes"] == minutes:
        return []
    conn.execute(
        """INSERT INTO schedule_day_budget(id,user_id,date,minutes) VALUES (?,?,?,?)
           ON CONFLICT(user_id,date) DO UPDATE SET minutes=excluded.minutes""",
        (item_id, user.id, str(on), minutes),
    )
    return [("schedule_day_budget", {"id": item_id}, dict(row) if row is not None else None)]


def change(conn, user, result, label, snapshots):
    undo = record(conn, user, label=label, summary="日程已恢复", affects=AREAS, rows=snapshots)
    return {"result": result, "affects": AREAS, "undo": undo}


@router.get("/today")
def read_today(request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        return today_view(conn, user, consume_notice=True)


def adjust_today(conn, user, minutes):
    ensure_plan(conn, user)
    on = local_today(user)
    snapshots = set_budget(conn, user, on, minutes)
    if snapshots:
        snapshots += replan(conn, user)
    return change(conn, user, today_view(conn, user), "已调整今天的时间", snapshots)


@router.patch("/today")
def update_today(body: Minutes, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        result = adjust_today(conn, user, body.minutes)
    request.app.state.events.publish(user.id, changed(AREAS))
    return result


def apply_tasks(conn, user, rows, changes):
    on = local_today(user)
    snapshots, dates, keep = [], {on}, []
    for row in rows:
        updates = {key: value for key, value in changes.items() if value != row[key]}
        if not updates:
            continue
        if "date" in updates:
            updates["pinned"] = True
        assignments = ",".join(f"{key}=?" for key in updates)
        conn.execute(f"UPDATE schedule_items SET {assignments} WHERE id=?", (*updates.values(), row["id"]))
        dates.update((date.fromisoformat(row["date"]), date.fromisoformat(updates.get("date", row["date"]))))
        snapshots.append(("schedule_items", {"id": row["id"]}, dict(row)))
        keep.append(row["id"])
    if snapshots:
        snapshots += replan(conn, user, dates=[day for day in dates if day >= on], preserve=keep)
    return snapshots


@router.patch("/tasks/{task_id}")
def update_task(task_id: str, body: TaskPatch, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        ensure_plan(conn, user)
        row = task(conn, user.id, task_id)
        changes = body.model_dump(mode="json", exclude_unset=True)
        label = "已挪动任务" if changes.get("date", row["date"]) != row["date"] else "已更新任务"
        snapshots = apply_tasks(conn, user, [row], changes)
        current = task_view(conn, task(conn, user.id, task_id))
        result = change(conn, user, current, label, snapshots)
    request.app.state.events.publish(user.id, changed(AREAS, current["course_id"]))
    return result


@router.get("/schedule")
def read_schedule(request: Request, to: date | None = None, user: Principal = Depends(principal)):
    raw = request.query_params.get("from")
    try:
        start = date.fromisoformat(raw) if raw is not None else local_today(user)
    except ValueError:
        raise ApiError(400, "bad_request", "请检查日程开始日期") from None
    end = to if to is not None else start + timedelta(days=6)
    if not 0 <= (end - start).days < 31:
        raise ApiError(400, "bad_request", "日程范围最多 31 天")
    with request.app.state.db.transaction(write=True) as conn:
        ensure_plan(conn, user)
        return schedule_view(conn, user, start, end)


@router.patch("/schedule/days/{on}")
def update_day(on: date, body: Minutes, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        ensure_plan(conn, user)
        snapshots = set_budget(conn, user, on, body.minutes)
        if snapshots and on >= local_today(user):
            snapshots += replan(conn, user, dates=[on])
        default = conn.execute("SELECT daily_minutes FROM settings WHERE user_id=?", (user.id,)).fetchone()[0]
        result = change(conn, user, day_view(conn, user, on, default), "已修改当天时间", snapshots)
    request.app.state.events.publish(user.id, changed(AREAS))
    return result


@router.post("/schedule/rebuild")
def rebuild(request: Request, user: Principal = Depends(principal)):
    start = local_today(user)
    with request.app.state.db.transaction(write=True) as conn:
        ensure_plan(conn, user)
        snapshots = replan(conn, user, dates=date_span(start, HORIZON))
        result = change(conn, user, schedule_view(conn, user, start, start + timedelta(days=6)), "已重排日程", snapshots)
    request.app.state.events.publish(user.id, changed(AREAS))
    return result
