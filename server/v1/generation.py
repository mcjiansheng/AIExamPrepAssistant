from . import courses, learning, plans, practice
from .auth import new_id
from .db import dump, load, utc_now
from .legacy import module
from .model_runtime import JobFailure, OutputError, binding, legacy_model, role_model
from .pipeline import Paused, Removed, check_limit, job_event, set_job

drafting = module("workflow.questions")
verification = module("workflow.verify")
legacy_exams = module("exams")


def spec_for(conn, user, slot):
    kid = slot["kp_id"]
    point = courses.kp(conn, user.id, kid)
    rows = conn.execute(
        """SELECT m.id AS material_id,m.title AS material_title,r.page,p.text
           FROM kp_refs r JOIN materials m ON m.id=r.material_id
           JOIN material_pages p ON p.material_id=r.material_id AND p.page=r.page
           WHERE r.kp_id=? AND m.user_id=? AND m.superseded_by IS NULL ORDER BY r.position""",
        (kid, user.id),
    )
    title = conn.execute("SELECT title FROM topics WHERE id=?", (point["topic_id"],)).fetchone()[0]
    score = slot["score"]
    return {
        "kp_id": kid, "title": point["title"], "summary": point["summary"], "topic_title": title,
        "pages": [dict(row) for row in rows], "type": slot["type"], "position": slot["position"] + 1,
        "score": int(score) if int(score) == score else score,
    }


def question_event(app, user, qid):
    with app.state.db.transaction() as conn:
        row = conn.execute("SELECT * FROM practice_questions WHERE id=? AND user_id=?", (qid, user.id)).fetchone()
        if row is None:
            return
        event = {"type": "question", "session_id": row["session_id"], "question": practice.question_view(conn, user, row)}
    app.state.events.publish(user.id, event)


def conformed_blocks(blocks):
    return [block | {"lang": None} if block["kind"] == "code" and "lang" not in block else block for block in blocks]


def publish_draft(app, user, job, slot, spec, draft, payload):
    qid = slot["id"]
    value = legacy_exams.seal(draft, spec, qid)
    refs = [ref | {"quote": None} for ref in value["refs"]]
    solution = value["solution"]
    for index, step in enumerate(solution["steps"]):
        source = {(ref["material_id"], ref["page"]): ref["quote"] for ref in value["source_refs"][index]}
        step["refs"] = [ref | {"quote": source[(ref["material_id"], ref["page"])]} for ref in step["refs"]]
        step["blocks"] = conformed_blocks(step["blocks"])
    hints = ["先找出题目对应的概念，确认题目给了哪些条件。", "把给出的条件和相关定义逐项对应，再写出关键一步。"]
    bank = new_id("q")
    with app.state.db.transaction(write=True) as conn:
        row = conn.execute("SELECT * FROM practice_questions WHERE id=? AND user_id=?", (qid, user.id)).fetchone()
        if row is None:
            raise Removed
        if row["status"] == "hidden" or row["attempt"] is not None:
            return False
        conn.execute(
            """INSERT INTO bank_questions
               (id,user_id,course_id,kp_id,type,score,stem,options,answer,solution,hints,refs,check_state)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'checking')""",
            (bank, user.id, row["course_id"], row["kp_id"], spec["type"], spec["score"],
             dump(conformed_blocks(value["stem"])), dump(value["options"]), draft["answer"],
             dump(solution), dump(hints), dump(refs)),
        )
        replaced = row["bank_id"] is not None
        conn.execute(
            """UPDATE practice_questions SET bank_id=?,type=?,status='ready',check_state='checking',check_note=NULL,
               version=version+?,replaced=? WHERE id=?""", (bank, spec["type"], int(replaced), int(replaced), qid),
        )
        conn.execute(
            """UPDATE practice_sessions SET status='active',started_at=COALESCE(started_at,?)
               WHERE id=? AND status='preparing'""", (utc_now().isoformat(), row["session_id"]),
        )
        practice.tally(conn, row["session_id"])
        payload["work"]["published"] = True
        set_job(conn, job["id"], payload, f"核对第 {spec['position']} 道题")
    question_event(app, user, qid)
    return True


def mark_question(conn, user, qid, state, note):
    changes = conn.execute(
        "SELECT * FROM practice_questions WHERE id=? AND user_id=?", (qid, user.id),
    ).fetchone()
    if changes is None or changes["status"] == "hidden":
        return None
    conn.execute("UPDATE practice_questions SET check_state=?,check_note=? WHERE id=?", (state, note, qid))
    conn.execute("UPDATE bank_questions SET check_state=?,check_note=? WHERE id=?", (state, note, changes["bank_id"]))
    if state == "flagged":
        if conn.execute("UPDATE learning_events SET counted=0 WHERE question_id=? AND counted=1", (qid,)).rowcount:
            learning.recompute_progress(conn, user, changes["kp_id"])
            learning.snapshot_readiness(conn, user, changes["course_id"])
            practice.rebuild_mistake(conn, user, changes["bank_id"])
            plans.replan(conn, user)
        conn.execute("UPDATE practice_sessions SET result=NULL WHERE id=?", (changes["session_id"],))
        practice.tally(conn, changes["session_id"])
    return changes


def replacement(app, user, jid, qid, hard, payload):
    with app.state.db.transaction(write=True) as conn:
        row = mark_question(conn, user, qid, "flagged", "；".join(hard))
        if row is None or row["attempt"] is not None or row["peeked"]:
            return False
        if payload["work"].get("replaced"):
            return False
        old = payload["work"]
        spec = old["spec"]
        if spec["type"] == "calc":
            spec["type"] = "short"
        payload["work"] = {"spec": spec, "replaced": True, "comments": hard}
        conn.execute("UPDATE practice_questions SET status='pending' WHERE id=?", (qid,))
        set_job(conn, jid, payload, "正在换一道题")
    return True


def draft_next(app, user, job, payload, qid):
    db = app.state.db
    with db.transaction() as conn:
        slot = conn.execute("SELECT * FROM practice_questions WHERE id=? AND user_id=?", (qid, user.id)).fetchone()
        if slot is None or slot["status"] == "hidden":
            return
        work = payload.setdefault("work", {})
        spec = work.setdefault("spec", spec_for(conn, user, slot))
        try:
            check_limit(conn, user)
        except Paused:
            if not work.get("published"):
                raise
            limited = True
        else:
            limited = False
    if limited:
        with db.transaction(write=True) as conn:
            mark_question(conn, user, qid, "unchecked", "已达今日上限，题目尚未完成核对")
        question_event(app, user, qid)
        raise Paused("已达今日上限")
    if not spec["pages"]:
        raise OutputError("找不到支持这道题的资料页")
    model = role_model(app, user.id, "generate", "generate", slot["course_id"], job["id"])

    def save():
        with db.transaction(write=True) as conn:
            set_job(conn, job["id"], payload, f"整理第 {spec['position']} 道题")

    if "draft" not in work:
        try:
            draft, _ = drafting.draft(model, spec, work.get("comments", []), work, save)
        except drafting.CalculationFailed:
            spec["type"] = "short"
            draft, _ = drafting.draft(model, spec, ["求解程序未完成，改出简答题"], work, save)
        except OutputError:
            if spec["type"] == "calc":
                spec["type"] = "short"
                draft, _ = drafting.draft(model, spec, ["计算题未通过校验，改出简答题"], work, save)
            else:
                draft, _ = drafting.draft(model, spec, ["上一版结构有误，按要求出一道简洁的题"], work, save)
        work["draft"] = draft
        save()
    if not work.get("published") and not publish_draft(app, user, job, slot, spec, work["draft"], payload):
        return
    with db.transaction() as conn:
        can_check = not jobs_limit(conn, user)
    if not can_check:
        with db.transaction(write=True) as conn:
            mark_question(conn, user, qid, "unchecked", "已达今日上限，题目尚未完成核对")
        question_event(app, user, qid)
        raise Paused("已达今日上限")
    hard, soft, notes, checked = verification.verify(
        model, spec["type"], work["draft"], spec["pages"], work.setdefault("checks", {}), save, work.get("code"),
    )
    if hard and replacement(app, user, job["id"], qid, hard, payload):
        question_event(app, user, qid)
        draft_next(app, user, job, payload, qid)
        return
    status = "flagged" if hard else "passed" if checked else "unchecked"
    note = "；".join(hard or (soft + notes)) or None
    with db.transaction(write=True) as conn:
        mark_question(conn, user, qid, status, note)
    question_event(app, user, qid)


def jobs_limit(conn, user):
    from .jobs import reached_daily_limit
    return reached_daily_limit(conn, user)


def run_session(app, user, job, payload):
    ids = payload["question_ids"]
    payload.setdefault("index", 0)
    while payload["index"] < len(ids):
        qid = ids[payload["index"]]
        try:
            draft_next(app, user, job, payload, qid)
        except Removed:
            pass
        except OutputError:
            with app.state.db.transaction(write=True) as conn:
                conn.execute(
                    """UPDATE practice_questions SET status='failed',check_state='unchecked',check_note=?
                       WHERE id=? AND user_id=? AND attempt IS NULL""",
                    ("模型多次没有出成这道题", qid, user.id),
                )
            payload.setdefault("failed", []).append(qid)
            question_event(app, user, qid)
        payload["index"] += 1
        payload.pop("work", None)
        with app.state.db.transaction(write=True) as conn:
            set_job(conn, job["id"], payload, f"已出题 {payload['index']} / {len(ids)}", progress=payload["index"] / len(ids))
        job_event(app, user, job["id"])
    if payload.get("failed"):
        raise JobFailure(f"{len(payload['failed'])} 道题没有出成，可以继续出题", True)


def settle_failed(conn, user, job):
    sid = job["target_id"]
    conn.execute(
        """UPDATE practice_questions SET status='failed',check_state='unchecked',
           check_note=COALESCE(check_note,'出题未完成')
           WHERE session_id=? AND user_id=? AND status='pending'""", (sid, user.id),
    )
    conn.execute(
        """UPDATE practice_questions SET check_state='unchecked',check_note='核对未完成'
           WHERE session_id=? AND user_id=? AND check_state='checking'""", (sid, user.id),
    )
    if not conn.execute("SELECT 1 FROM practice_questions WHERE session_id=? AND status='ready'", (sid,)).fetchone():
        conn.execute("UPDATE practice_sessions SET status='failed' WHERE id=? AND status<>'finished'", (sid,))


def grade_assistance(app, user, value):
    question = value["question"]
    attempt = question["attempt"]
    if question["type"] not in {"short", "proof", "design"} or not attempt["response"]:
        return value
    rubric = question["solution"]["rubric"] or []
    if not rubric:
        return value
    db = app.state.db
    cid, qid = question["course_id"], question["id"]
    with db.transaction() as conn:
        course = courses.course(conn, user.id, cid)
        if course["sample"] or not binding(conn, user.id, "generate", app.state.mock_model) or jobs_limit(conn, user):
            return value
    points = {point["id"] for point in rubric}

    def check(reply):
        marks = reply["marks"]
        legacy_model.require(isinstance(marks, dict) and marks.keys() == points and
                             all(mark in {"full", "partial", "none"} for mark in marks.values()),
                             "marks 必须逐条使用给出的评分点和 full、partial、none")

    try:
        model = role_model(app, user.id, "generate", "verify", cid)
        reply = legacy_model.call_json(
            model, "grade", legacy_model.DATA_RULE + "按评分点评估作答，只返回 marks。证据不足给 none，用户会复核。",
            dump({"stem": question["stem"], "rubric": rubric, "response": attempt["response"]}), check,
        )
    except (JobFailure, OutputError):
        return value
    with db.transaction(write=True) as conn:
        row = conn.execute("SELECT * FROM practice_questions WHERE id=? AND user_id=?", (qid, user.id)).fetchone()
        if row is None:
            return value
        saved = load(row["attempt"])
        if saved["state"] == "needs_self_grade" and saved["marks"] is None:
            saved["marks"] = reply["marks"]
            conn.execute("UPDATE practice_questions SET attempt=? WHERE id=?", (dump(saved), qid))
            value["question"] = practice.question_view(conn, user, practice.question_row(conn, user.id, qid))
    return value
