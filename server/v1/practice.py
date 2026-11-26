from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field
from starlette.responses import JSONResponse

from server.workflow.items import choice_matches, same_value

from . import courses, learning, plans
from .auth import Body, Principal, new_id, principal
from .db import dump, load, local_iso, utc_now
from .errors import ApiError, conflict, not_found
from .events import changed
from .idempotency import run
from .legacy import module
from .undo import record

router = APIRouter()
SessionKind = Literal["quick", "kp", "review", "mistakes", "mock"]
PointMark = Literal["full", "partial", "none"]
TITLE = {"quick": "快练", "kp": "按知识点练", "review": "到期复习", "mistakes": "错题重做", "mock": "模拟卷"}
AREAS = ["practice", "session", "map", "course", "kp", "mistakes", "insight", "today", "schedule"]
legacy_chat = module("chat")


class NewSession(Body):
    kind: SessionKind
    course_id: str | None = None
    kp_id: str | None = None
    question_ids: list[str] | None = None
    count: Annotated[int, Field(ge=1, le=20)] | None = None
    task_id: str | None = None
    confirm: bool = False


class Position(Body):
    position: Annotated[int, Field(ge=0)]


class Answer(Body):
    response: str | None


class Grade(Body):
    marks: dict[str, PointMark]


class Hint(Body):
    level: Literal[1, 2, 3]


class Report(Body):
    kind: Literal["wrong_answer", "wrong_solution", "out_of_scope", "unclear", "wrong_ref"]
    note: str | None = None


def owned(conn, table, user_id, row_id, label):
    row = conn.execute(f"SELECT * FROM {table} WHERE id=? AND user_id=?", (row_id, user_id)).fetchone()
    if row is None:
        raise not_found(label)
    return row


def session_row(conn, user_id, sid):
    return owned(conn, "practice_sessions", user_id, sid, "练习")


def question_row(conn, user_id, qid):
    return owned(conn, "practice_questions", user_id, qid, "题目")


def bank_for(conn, row):
    return conn.execute("SELECT * FROM bank_questions WHERE id=?", (row["bank_id"],)).fetchone()


def question_view(conn, user, row, *, pending=False):
    bank = bank_for(conn, row)
    point = courses.kp(conn, user.id, row["kp_id"])
    attempt = load(row["attempt"])
    if attempt:
        attempt["answered_at"] = local_iso(attempt["answered_at"], user.timezone)
    return {
        "id": row["id"], "bank_id": row["bank_id"] or row["id"], "index": row["position"],
        "version": row["version"], "type": row["type"], "status": "pending" if pending else row["status"],
        "check": "checking" if pending else row["check_state"], "check_note": row["check_note"],
        "replaced": bool(row["replaced"]), "score": row["score"], "kp": {"id": point["id"], "title": point["title"]},
        "course_id": row["course_id"], "stem": load(bank["stem"]) if bank is not None and not pending else [],
        "options": load(bank["options"]) if bank is not None and not pending else None,
        "refs": load(bank["refs"]) if bank is not None and not pending else [], "hints": load(row["hints"]),
        "peeked": bool(row["peeked"]), "attempt": attempt,
        "solution": load(bank["solution"]) if bank is not None and (attempt or row["peeked"]) else None,
    }


def rows_for_session(conn, sid):
    return conn.execute("SELECT * FROM practice_questions WHERE session_id=? ORDER BY position", (sid,)).fetchall()


def session_view(conn, user, row, *, preparing=False):
    return {
        "id": row["id"], "kind": row["kind"], "course_id": row["course_id"], "title": row["title"],
        "status": "preparing" if preparing else row["status"],
        "created_at": local_iso(row["created_at"], user.timezone),
        "started_at": local_iso(row["started_at"], user.timezone) if row["started_at"] and not preparing else None,
        "finished_at": local_iso(row["finished_at"], user.timezone) if row["finished_at"] else None,
        "time_limit_min": row["time_limit_min"], "position": row["position"], "task_id": row["task_id"],
        "job": session_job(conn, user, row["job_id"]),
        "questions": [question_view(conn, user, item, pending=preparing and item["status"] == "ready")
                      for item in rows_for_session(conn, row["id"])],
        "score": row["score"], "total": row["total"],
    }


def session_job(conn, user, job_id):
    if job_id is None:
        return None
    from .jobs import owned_job, view
    return view(owned_job(conn, user.id, job_id), user.timezone)


def scoped_courses(conn, user, cid):
    if cid:
        return [courses.course(conn, user.id, cid)]
    return conn.execute(
        "SELECT * FROM courses WHERE user_id=? ORDER BY exam_date IS NULL,exam_date,created_at,id", (user.id,),
    ).fetchall()


def scoped_points(conn, user, course_rows, kind, kid):
    out = []
    today = str(plans.local_today(user))
    for row in course_rows:
        cid = row["id"]
        levels = courses.kp_levels(conn, cid)
        states = courses.kp_states(conn, cid)
        for point in conn.execute(
            """SELECT k.*,p.due_at FROM active_knowledge_points k LEFT JOIN kp_progress p ON p.kp_id=k.id
               WHERE k.course_id=? ORDER BY k.position""", (cid,),
        ):
            key = point["id"]
            level = levels.get(key, "none")
            due = point["due_at"] and point["due_at"] <= today
            if (kid is not None and kid != key) or (kid is None and level == "excluded") or (kind == "review" and not due):
                continue
            priority = (0 if states[key] == "shaky" or due else 1,
                        1 if states[key] == "mastered" else 0, -courses.LEVEL_WEIGHT[level], point["position"])
            out.append((priority, point))
    return [point for _, point in sorted(out, key=lambda pair: pair[0])]


def point_bank(conn, kp_id, *, exclude=None):
    rows = conn.execute(
        """SELECT * FROM bank_questions WHERE kp_id=? AND check_state='passed'
           ORDER BY authored DESC, CASE type WHEN 'single' THEN 0 WHEN 'fill' THEN 1 ELSE 2 END,rowid""", (kp_id,),
    )
    return [row for row in rows if row["id"] != exclude]


def scatter_bank(conn, points, count, *, exclude=None):
    pools = [(point, point_bank(conn, point["id"], exclude=exclude)) for point in points]
    return [(point, bank[index]) for index in range(max((len(bank) for _, bank in pools), default=0))
            for point, bank in pools if len(bank) > index][:count]


def mock_bank(conn, points, typed):
    slots = []
    for spec in typed:
        candidates = [(p, b) for p, b in scatter_bank(conn, points, 10_000) if b["type"] == spec["type"]]
        slots += [(p, b, spec["type"], spec["score"]) for p, b in candidates[:spec["count"]]]
        slots += [(points[index % len(points)], None, spec["type"], spec["score"])
                  for index in range(max(0, spec["count"] - len(candidates)))]
    return slots


def mistakes_in(conn, user, cid):
    return conn.execute(
        """SELECT * FROM mistakes WHERE user_id=? AND (? IS NULL OR course_id=?)
           ORDER BY last_wrong_at DESC,bank_id""", (user.id, cid, cid),
    ).fetchall()


def mistakes_bank(conn, user, request, cid):
    rows = {row["bank_id"]: row for row in mistakes_in(conn, user, cid)}
    ids = list(dict.fromkeys(request.question_ids)) if request.question_ids is not None else list(rows)
    out = []
    for bank_id in ids[:request.count or 10]:
        if bank_id not in rows:
            raise not_found("错题")
        bank = owned(conn, "bank_questions", user.id, bank_id, "题目")
        point = courses.kp(conn, user.id, bank["kp_id"])
        out.append((point, bank))
    return out


def insert_questions(conn, user, sid, slots, *, generating=False):
    ids = [new_id("qi") for _ in slots]
    conn.executemany(
        """INSERT INTO practice_questions
           (id,user_id,session_id,course_id,kp_id,bank_id,position,type,score,status,check_state,check_note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(ids[index], user.id, sid, point["course_id"], point["id"], bank["id"] if bank is not None else None,
          index, kind, score, "ready" if bank is not None else "pending" if generating else "failed",
          "passed" if bank is not None else "unchecked",
          None if bank is not None or generating else "题库中没有足够的这类题目")
         for index, (point, bank, kind, score) in enumerate(slots)],
    )
    return [qid for qid, slot in zip(ids, slots) if slot[1] is None]


def build_session(conn, user, request, *, quiz=False, exclude=None, app=None):
    cid = request.course_id
    if request.kind == "kp" and request.kp_id is None:
        raise ApiError(400, "bad_request", "请选一个知识点")
    target = plans.task(conn, user.id, request.task_id) if request.task_id else None
    if target is not None:
        if cid and cid != target["course_id"]:
            raise not_found("任务")
        cid = target["course_id"]
        if target["session_id"] is not None:
            return session_view(conn, user, session_row(conn, user.id, target["session_id"]))
    if request.kp_id:
        point = courses.kp(conn, user.id, request.kp_id)
        if cid and cid != point["course_id"]:
            raise not_found("知识点")
        cid = point["course_id"]
    scope = scoped_courses(conn, user, cid)
    kind = request.kind
    if kind == "mock" and scope:
        scope = scope[:1]
        cid = scope[0]["id"]
    points = scoped_points(conn, user, scope, kind, request.kp_id)
    duration = None
    count = 0
    if kind == "mistakes":
        selected = mistakes_bank(conn, user, request, cid)
        slots = [(point, bank, bank["type"], bank["score"]) for point, bank in selected]
    elif not points:
        raise conflict("这个范围里没有可出题的知识点")
    elif kind == "mock":
        format_ = courses.exam_format(conn, cid)
        duration = format_["duration_min"]
        slots = mock_bank(conn, points, format_["types"])
    else:
        count = request.count or (min(len(points), 20) if kind == "review" else 3 if kind == "kp" else 5)
        slots = [(point, bank, bank["type"], bank["score"]) for point, bank in scatter_bank(conn, points, count, exclude=exclude)]
    generate = app is not None and kind != "mistakes" and bool(points) and not all(row["sample"] for row in scope)
    if generate and kind != "mock":
        missing = count - len(slots)
        if missing:
            common = [("single", 2), ("fill", 4), ("short", 6)]
            for index in range(missing):
                point = points[index % len(points)]
                desired, score = common[index % len(common)]
                slots.append((point, None, desired, score))
    missing_slots = sum(slot[1] is None for slot in slots) if generate else 0
    if missing_slots:
        from .model_runtime import binding
        from .providers import estimate
        if binding(conn, user.id, "generate", app.state.mock_model) is None:
            raise ApiError(409, "ai_required", "还没有连接 AI 模型")
        quote = estimate(conn, app, user, "session", missing_slots)
        if quote["needs_confirm"] and not request.confirm:
            raise ApiError(409, "needs_confirmation", "这次出题需要先确认用量", detail={"estimate": quote})
    if not slots:
        if kind in {"review", "mock", "mistakes"}:
            raise conflict("这个范围里没有可出题的知识点")
        raise ApiError(409, "ai_required", "还没有连接 AI 模型")
    available = [slot for slot in slots if slot[1] is not None]
    now = utc_now().isoformat()
    sid = new_id("s")
    name = next((row["name"] for row in scope if row["id"] == cid), None)
    title = f"{name} · {TITLE[kind]}" if name else TITLE[kind]
    if quiz:
        title = f"{points[0]['title']}小测"
    conn.execute(
        """INSERT INTO practice_sessions
           (id,user_id,course_id,title,kind,status,created_at,started_at,question_count,total,time_limit_min,task_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (sid, user.id, cid, title, kind, "active" if available else "preparing" if missing_slots else "failed", now, now if available else None,
         len(slots), sum(slot[3] for slot in available), duration, request.task_id),
    )
    pending = insert_questions(conn, user, sid, slots, generating=bool(missing_slots))
    if missing_slots:
        from .jobs import new_job
        job = new_job(conn, user, "session", sid, course_id=cid, stage="正在出题",
                      payload={"question_ids": pending, "units": len(pending), "index": 0})
        conn.execute("UPDATE practice_sessions SET job_id=? WHERE id=?", (job["id"], sid))
    if target is not None:
        conn.execute("UPDATE schedule_items SET session_id=? WHERE id=?", (sid, target["id"]))
    return session_view(conn, user, session_row(conn, user.id, sid), preparing=not quiz and bool(available or missing_slots))


def ensure_kp_quiz(conn, user, point):
    existing = conn.execute(
        """SELECT s.* FROM practice_sessions s JOIN practice_questions q ON q.session_id=s.id
           WHERE s.user_id=? AND s.kind='kp' AND s.title=? AND q.kp_id=?
           ORDER BY s.created_at DESC LIMIT 1""", (user.id, f"{point['title']}小测", point["id"]),
    ).fetchone()
    if existing is not None:
        return session_view(conn, user, existing)["questions"]
    if not conn.execute("SELECT 1 FROM active_knowledge_points WHERE id=?", (point["id"],)).fetchone() or not point_bank(conn, point["id"]):
        return []
    request = NewSession(kind="kp", course_id=point["course_id"], kp_id=point["id"])
    return build_session(conn, user, request, quiz=True)["questions"]


def tally(conn, session_id):
    eligible = [row for row in rows_for_session(conn, session_id)
                if row["status"] == "ready" and row["check_state"] != "flagged"]
    attempts = [load(row["attempt"]) for row in eligible if row["attempt"] is not None]
    score = sum(value["score"] or 0 for value in attempts)
    total = sum(row["score"] for row in eligible)
    conn.execute("UPDATE practice_sessions SET score=?,total=?,answered=? WHERE id=?",
                 (score, total, len(attempts), session_id))
    return eligible, attempts, score, total


def sync_mistake(conn, user, row, outcome, reason):
    key = row["bank_id"]
    existing = conn.execute("SELECT * FROM mistakes WHERE user_id=? AND bank_id=?", (user.id, key)).fetchone()
    if outcome != "correct":
        conn.execute(
            """INSERT INTO mistakes(user_id,bank_id,course_id,wrong_count,correct_streak,last_wrong_at,reason,question_id)
               VALUES (?,?,?,1,0,?,?,?) ON CONFLICT(bank_id) DO UPDATE SET wrong_count=wrong_count+1,
               correct_streak=0,last_wrong_at=excluded.last_wrong_at,reason=excluded.reason,question_id=excluded.question_id""",
            (user.id, key, row["course_id"], utc_now().isoformat(), reason, row["id"]),
        )
        return existing is None
    if existing is not None:
        streak = conn.execute(
            """SELECT COUNT(DISTINCT session_id) FROM learning_events WHERE user_id=? AND bank_id=?
               AND outcome='correct' AND counted=1 AND created_at>?""", (user.id, key, existing["last_wrong_at"]),
        ).fetchone()[0]
        if streak >= 2:
            conn.execute("DELETE FROM mistakes WHERE user_id=? AND bank_id=?", (user.id, key))
        else:
            conn.execute("UPDATE mistakes SET correct_streak=? WHERE user_id=? AND bank_id=?", (streak, user.id, key))
    return False


def outcome_for(score, maximum):
    return "correct" if score >= maximum else "partial" if score > 0 else "wrong"


def graded(conn, user, row, attempt, reason):
    counted = not row["peeked"] and row["check_state"] != "flagged"
    outcome = outcome_for(attempt["score"], row["score"])
    changes = learning.record_event(conn, user, row["kp_id"], row["bank_id"], row["session_id"], row["id"], outcome,
                                    counted=counted, hinted=bool(load(row["hints"])))
    return changes, sync_mistake(conn, user, row, outcome, reason) if counted else False


def attempt_question(conn, user, qid, response):
    row = question_row(conn, user.id, qid)
    session = session_row(conn, user.id, row["session_id"])
    if row["attempt"] is not None:
        raise conflict("这道题已经答过了")
    if row["status"] != "ready" or session["status"] == "finished":
        raise conflict("当前不能作答这道题")
    bank = bank_for(conn, row)
    attempt = {"response": response, "state": "needs_self_grade", "correct": None, "score": None,
               "marks": None, "answered_at": utc_now().isoformat()}
    changes, mistake_added = [], False
    if row["type"] in {"single", "fill"}:
        if row["type"] == "single":
            correct = response is not None and choice_matches(response, bank["answer"],
                                                               [option["text"] for option in load(bank["options"])])
            reason = f"选了 {response}" if response else "没有作答"
        else:
            correct = response is not None and same_value(response, bank["answer"])
            reason = f"填了 {response}" if response else "没有作答"
        attempt.update(state="graded", correct=correct, score=row["score"] if correct else 0)
        changes, mistake_added = graded(conn, user, row, attempt, reason)
    elif row["type"] == "calc":
        final_correct = response is not None and same_value(response, bank["answer"])
        attempt["correct"] = final_correct
        if final_correct:
            attempt["marks"] = {point["id"]: "full" for point in load(bank["solution"])["rubric"] or []}
            attempt["score"] = row["score"]
    conn.execute("UPDATE practice_questions SET attempt=? WHERE id=?", (dump(attempt), qid))
    tally(conn, row["session_id"])
    return {"question": question_view(conn, user, question_row(conn, user.id, qid)),
            "mastery": changes, "mistake_added": mistake_added}


def grade_question(conn, user, qid, marks):
    row = question_row(conn, user.id, qid)
    attempt = load(row["attempt"])
    session = session_row(conn, user.id, row["session_id"])
    if attempt is None or attempt["state"] != "needs_self_grade" or session["status"] == "finished":
        raise conflict("这道题现在不能自评")
    rubric = load(bank_for(conn, row)["solution"])["rubric"] or []
    if not marks.keys() <= {point["id"] for point in rubric}:
        raise ApiError(400, "bad_request", "评分点不属于这道题")
    score = sum(point["score"] * {"full": 1, "partial": 0.5, "none": 0}[marks.get(point["id"], "none")]
                for point in rubric)
    outcome = outcome_for(score, row["score"])
    attempt.update(state="graded", score=score, marks=marks, correct={"correct": True, "wrong": False, "partial": None}[outcome])
    changes, added = graded(conn, user, row, attempt, "自评：部分得分" if outcome == "partial" else "自评：没有得分")
    conn.execute("UPDATE practice_questions SET attempt=? WHERE id=?", (dump(attempt), qid))
    tally(conn, row["session_id"])
    return {"question": question_view(conn, user, question_row(conn, user.id, qid)),
            "mastery": changes, "mistake_added": added}


def give_hint(conn, user, qid, level):
    row = question_row(conn, user.id, qid)
    if row["status"] != "ready":
        raise conflict("这道题还不能查看提示")
    bank = bank_for(conn, row)
    hints = load(row["hints"])
    hint = next((value for value in hints if value["level"] == level), None)
    if hint is None:
        available = load(bank["hints"])
        text = "完整过程见下方解析。" if level == 3 else available[level - 1]
        if level in (1, 2):
            options = [option["text"] for option in load(bank["options"]) or []]
            stem = " ".join(block.get("text", "") for block in load(bank["stem"]))
            if legacy_chat.reveals_answer(text, row["type"], bank["answer"], options, stem):
                text = legacy_chat.FALLBACK_HINT
        hint = {"level": level, "text": text, "refs": load(bank["refs"]) if level == 1 else []}
        hints.append(hint)
        conn.execute("UPDATE practice_questions SET hints=?,peeked=? WHERE id=?",
                     (dump(hints), bool(row["peeked"]) or level == 3, qid))
    return {"hint": hint, "question": question_view(conn, user, question_row(conn, user.id, qid))}


def rebuild_mistake(conn, user, key):
    row = conn.execute("SELECT * FROM mistakes WHERE user_id=? AND bank_id=?", (user.id, key)).fetchone()
    if row is None:
        return
    track = conn.execute(
        """SELECT * FROM learning_events WHERE user_id=? AND bank_id=? AND counted=1
           ORDER BY created_at,rowid""", (user.id, key),
    ).fetchall()
    wrong = [event for event in track if event["outcome"] != "correct"]
    if not wrong:
        conn.execute("DELETE FROM mistakes WHERE user_id=? AND bank_id=?", (user.id, key))
        return
    last = wrong[-1]
    streak = len({event["session_id"] for event in track if event["outcome"] == "correct"
                  and event["created_at"] > last["created_at"]})
    if streak >= 2:
        conn.execute("DELETE FROM mistakes WHERE user_id=? AND bank_id=?", (user.id, key))
        return
    reason = row["reason"] if row["question_id"] == last["question_id"] else "作答未得满分"
    conn.execute(
        "UPDATE mistakes SET wrong_count=?,correct_streak=?,last_wrong_at=?,question_id=?,reason=? WHERE bank_id=?",
        (len(wrong), streak, last["created_at"], last["question_id"], reason, key),
    )


def mastery_changes(conn, user, sid):
    changes = []
    chapters = {}
    points = conn.execute(
        """SELECT DISTINCT k.* FROM knowledge_points k JOIN learning_events e ON e.kp_id=k.id
           WHERE e.session_id=? AND e.counted=1 ORDER BY k.position""", (sid,),
    )
    for point in points:
        kid = point["id"]
        progress = conn.execute("SELECT understood_at,mark FROM kp_progress WHERE kp_id=?", (kid,)).fetchone()
        events = conn.execute("SELECT * FROM learning_events WHERE kp_id=? AND counted=1 ORDER BY created_at,rowid",
                              (kid,)).fetchall()
        understood = progress["understood_at"] if progress is not None else None
        mark = progress["mark"] if progress is not None else None
        before = courses.state_of(understood, mark, [event for event in events if event["session_id"] != sid])
        after = courses.state_of(understood, mark, events)
        if before != after:
            changes.append({"kp_id": kid, "title": point["title"], "from": before, "to": after})
            chapters[point["chapter_id"]] = point["course_id"]
    views = []
    for chapter_id, cid in chapters.items():
        row = conn.execute("SELECT * FROM chapters WHERE id=?", (chapter_id,)).fetchone()
        views.append(courses.chapter_view(conn, row, courses.kp_states(conn, cid), courses.kp_levels(conn, cid)))
    return changes, views


def finish_session(conn, user, sid):
    row = session_row(conn, user.id, sid)
    if row["result"] is not None:
        return load(row["result"])
    if row["status"] == "failed":
        raise conflict("这组练习还没有可作答的题")
    was_finished = row["status"] == "finished"
    now = row["finished_at"] if was_finished else utc_now().isoformat()
    conn.execute("UPDATE practice_questions SET status='failed' WHERE session_id=? AND status='pending'", (sid,))
    eligible, attempts, score, total = tally(conn, sid)
    elapsed = max(0, int((datetime.fromisoformat(now) - datetime.fromisoformat(row["started_at"] or row["created_at"])).total_seconds()))
    conn.execute("UPDATE practice_sessions SET status='finished',finished_at=? WHERE id=?", (now, sid))
    completed = None
    if row["task_id"] and not was_finished:
        item = plans.task(conn, user.id, row["task_id"])
        did_finish = learning.complete_learn_task(conn, user, item) if item["kind"] == "learn" else item["status"] == "todo"
        if did_finish:
            conn.execute("UPDATE schedule_items SET status='done' WHERE id=?", (item["id"],))
            completed = plans.task_view(conn, plans.task(conn, user.id, item["id"]))
    elif row["kind"] == "kp" and eligible and len(eligible) == len(attempts) and not was_finished:
        item = learning.task_for_quiz(conn, user, eligible[0]["kp_id"], eligible[0]["course_id"])
        if learning.complete_learn_task(conn, user, item):
            completed = plans.task_view(conn, plans.task(conn, user.id, item["id"]))
    mastery, chapters = mastery_changes(conn, user, sid)
    misses = [question_view(conn, user, item) for item in eligible
              if item["attempt"] and (load(item["attempt"])["score"] or 0) < item["score"]]
    review = None
    if misses:
        first = misses[0]
        review = {"text": f"有 {len(misses)} 道题没拿满分，可以先复习「{first['kp']['title']}」。",
                  "actions": [{"label": "复习这个知识点", "kind": "kp", "kp_id": first["kp"]["id"], "session": None}]}
    result = {
        "session": session_view(conn, user, session_row(conn, user.id, sid)), "score": score, "total": total,
        "accuracy": sum(attempt["correct"] is True for attempt in attempts) / len(eligible) if eligible else 0,
        "duration_sec": elapsed, "mastery": mastery, "chapters": chapters, "mistakes": misses, "review": review, "task": completed,
    }
    conn.execute("UPDATE practice_sessions SET result=? WHERE id=?", (dump(result), sid))
    if not was_finished and row["course_id"] and elapsed:
        feature = {"mock": "mock", "review": "review"}.get(row["kind"], "practice")
        conn.execute(
            """INSERT INTO learning_activity(id,user_id,kind,minutes,created_at,course_id)
               VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING""",
            (f"session:{sid}", user.id, feature, elapsed / 60, now, row["course_id"]),
        )
    return result


@router.get("/practice")
def hub(request: Request, course_id: str | None = None, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        scope = scoped_courses(conn, user, course_id)
        due = min(20, len(scoped_points(conn, user, scope, "review", None)))
        format_ = courses.exam_format(conn, scope[0]["id"]) if scope else None
        history = conn.execute(
            """SELECT s.*,c.name AS course_name FROM practice_sessions s LEFT JOIN courses c ON c.id=s.course_id
               WHERE s.user_id=? AND (? IS NULL OR s.course_id=?)
               AND (s.kind<>'kp' OR s.title NOT LIKE '%小测' OR s.answered>0)
               ORDER BY s.created_at DESC LIMIT 20""", (user.id, course_id, course_id),
        ).fetchall()
        return {
            "course_id": course_id, "quick": {"count": 5, "minutes": 10},
            "review": {"count": due, "minutes": max(5, (due * 3 + 1) // 2)},
            "mistakes": {"count": len(mistakes_in(conn, user, course_id))},
            "mock": {"available": format_ is not None, "count": sum(spec["count"] for spec in format_["types"]) if format_ else 0,
                     "minutes": format_["duration_min"] or 120 if format_ else 120, "basis": format_["basis"] if format_ else "default"},
            "history": [courses.session_summary(item, item["course_name"], user.timezone) for item in history],
        }


def publish(request, user, cid=None):
    request.app.state.events.publish(user.id, changed(AREAS, cid))


@router.post("/sessions")
def start(body: NewSession, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        status, result = run(conn, request, user, lambda: (200, build_session(conn, user, body, app=request.app)))
    publish(request, user, result["course_id"])
    return JSONResponse(result, status_code=status)


@router.get("/sessions/{sid}")
def read_session(sid: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        return session_view(conn, user, session_row(conn, user.id, sid))


@router.patch("/sessions/{sid}", status_code=204)
def position(sid: str, body: Position, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        session_row(conn, user.id, sid)
        conn.execute("UPDATE practice_sessions SET position=? WHERE id=?", (body.position, sid))
    return Response(status_code=204)


@router.post("/sessions/{sid}/finish")
def finish(sid: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        result = finish_session(conn, user, sid)
    publish(request, user, result["session"]["course_id"])
    return result


@router.get("/sessions/{sid}/result")
def result(sid: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        if session_row(conn, user.id, sid)["status"] != "finished":
            raise conflict("完成这组练习后才能查看结果")
        return finish_session(conn, user, sid)


@router.delete("/sessions/{sid}", status_code=204)
def delete_session(sid: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        row = session_row(conn, user.id, sid)
        events = conn.execute("SELECT DISTINCT kp_id,bank_id FROM learning_events WHERE session_id=?", (sid,)).fetchall()
        conn.execute("DELETE FROM practice_sessions WHERE id=?", (sid,))
        conn.execute("DELETE FROM learning_activity WHERE user_id=? AND id=?", (user.id, f"session:{sid}"))
        for kid in {item["kp_id"] for item in events}:
            learning.recompute_progress(conn, user, kid)
            learning.snapshot_readiness(conn, user, courses.kp(conn, user.id, kid)["course_id"])
        for bank_id in {item["bank_id"] for item in events}:
            rebuild_mistake(conn, user, bank_id)
        if events:
            plans.replan(conn, user)
    publish(request, user, row["course_id"])
    return Response(status_code=204)


@router.post("/questions/{qid}/attempt")
def attempt(qid: str, body: Answer, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        result = attempt_question(conn, user, qid, body.response)
    if result["question"]["attempt"]["state"] == "needs_self_grade":
        from .generation import grade_assistance
        result = grade_assistance(request.app, user, result)
    publish(request, user, result["question"]["course_id"])
    return result


@router.post("/questions/{qid}/grade")
def grade(qid: str, body: Grade, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        result = grade_question(conn, user, qid, body.marks)
    publish(request, user, result["question"]["course_id"])
    return result


@router.post("/questions/{qid}/hint")
def hint(qid: str, body: Hint, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        result = give_hint(conn, user, qid, body.level)
    request.app.state.events.publish(user.id, changed(["session"], result["question"]["course_id"]))
    return result


@router.post("/questions/{qid}/report")
def report(qid: str, body: Report, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        row = question_row(conn, user.id, qid)
        conn.execute("INSERT INTO question_reports(id,user_id,question_id,kind,note,created_at) VALUES (?,?,?,?,?,?)",
                     (new_id("rep"), user.id, qid, body.kind, body.note, utc_now().isoformat()))
        conn.execute("UPDATE practice_questions SET status='hidden' WHERE id=?", (qid,))
        conn.execute("UPDATE bank_questions SET check_state='unchecked' WHERE id=?", (row["bank_id"],))
        conn.execute("UPDATE practice_sessions SET result=NULL WHERE id=?", (row["session_id"],))
        if conn.execute("UPDATE learning_events SET counted=0 WHERE question_id=? AND counted=1", (qid,)).rowcount:
            learning.recompute_progress(conn, user, row["kp_id"])
            learning.snapshot_readiness(conn, user, row["course_id"])
            rebuild_mistake(conn, user, row["bank_id"])
            plans.replan(conn, user)
        tally(conn, row["session_id"])
        response = {"question": question_view(conn, user, question_row(conn, user.id, qid))}
    publish(request, user, row["course_id"])
    return response


@router.get("/mistakes")
def mistakes(request: Request, course_id: str | None = None, user: Principal = Depends(principal)):
    with request.app.state.db.transaction() as conn:
        if course_id is not None:
            courses.course(conn, user.id, course_id)
        out = []
        for row in mistakes_in(conn, user, course_id):
            item = question_row(conn, user.id, row["question_id"])
            course = courses.course(conn, user.id, row["course_id"])
            out.append({"question": question_view(conn, user, item), "course_id": row["course_id"],
                        "course_name": course["name"], "reason": row["reason"], "wrong_count": row["wrong_count"],
                        "correct_streak": row["correct_streak"], "last_wrong_at": local_iso(row["last_wrong_at"], user.timezone)})
        return out


def owned_mistake(conn, user, bank_id):
    row = conn.execute("SELECT * FROM mistakes WHERE user_id=? AND bank_id=?", (user.id, bank_id)).fetchone()
    if row is None:
        raise not_found("错题")
    return row


@router.delete("/mistakes/{bank_id}")
def remove_mistake(bank_id: str, request: Request, user: Principal = Depends(principal)):
    areas = ["mistakes", "practice", "course"]
    with request.app.state.db.transaction(write=True) as conn:
        before = owned_mistake(conn, user, bank_id)
        conn.execute("DELETE FROM mistakes WHERE user_id=? AND bank_id=?", (user.id, bank_id))
        undo = record(conn, user, label="已移出错题本", summary="已放回错题本", affects=areas,
                      rows=[("mistakes", {"bank_id": bank_id}, dict(before))])
    request.app.state.events.publish(user.id, changed(areas, before["course_id"]))
    return {"result": None, "affects": areas, "undo": undo}


@router.post("/mistakes/{bank_id}/similar")
def similar(bank_id: str, request: Request, user: Principal = Depends(principal)):
    with request.app.state.db.transaction(write=True) as conn:
        row = owned_mistake(conn, user, bank_id)
        bank = owned(conn, "bank_questions", user.id, bank_id, "题目")
        args = NewSession(kind="kp", course_id=row["course_id"], kp_id=bank["kp_id"], count=1)
        status, result = run(conn, request, user, lambda: (200, build_session(
            conn, user, args, exclude=bank_id, app=request.app,
        )))
    publish(request, user, row["course_id"])
    return JSONResponse(result, status_code=status)
