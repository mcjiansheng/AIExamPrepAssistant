"""Exam generation, grading and event-derived mastery."""
from collections import defaultdict

from core import JobFailure, bad_request, conflict, dump, fields, load, not_found, now, one_of, text, uid
from focus import exam_format
from kb.store import KnowledgeBase
from plan import stale
from workflow import items, questions, verify
from workflow.llm import OutputError

REPORT_KINDS = ("wrong_answer", "wrong_solution", "out_of_scope", "unclear", "wrong_ref")
READY = ("ready", "disputed")
PENDING = ("generating", "verifying")   # 还没出好的题
SCHEMA = """
CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    course TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    format_basis TEXT NOT NULL,
    result TEXT
);
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    kp_id TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    status TEXT NOT NULL,
    kind TEXT NOT NULL,
    score REAL NOT NULL,
    topic_title TEXT NOT NULL,
    draft TEXT,
    hints TEXT NOT NULL DEFAULT '[]',
    checked INTEGER NOT NULL DEFAULT 0,
    attempt TEXT,
    peeked INTEGER NOT NULL DEFAULT 0,
    report TEXT
);
CREATE TABLE IF NOT EXISTS mastery_events (
    question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
    kp_id TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def exam_row(db, eid):
    row = db.execute("SELECT * FROM exams WHERE id=?", (eid,)).fetchone()
    if not row:
        raise not_found("试卷")
    return row


def question_row(db, qid):
    row = db.execute("SELECT * FROM questions WHERE id=?", (qid,)).fetchone()
    if not row:
        raise not_found("题目")
    return row


def mastery(db, cid, omit_exam=None):
    outcomes = defaultdict(list)
    for row in db.execute(
        """SELECT event.kp_id,event.outcome FROM mastery_events event
           JOIN questions q ON q.id=event.question_id JOIN exams e ON e.id=q.exam_id
           WHERE e.course=? AND q.status!='hidden' AND (? IS NULL OR e.id!=?)
           ORDER BY event.created_at,event.question_id""", (cid, omit_exam, omit_exam),
    ):
        outcomes[row["kp_id"]].append(row["outcome"])
    results = {}
    for kid, history in outcomes.items():
        consecutive, attempted = 0, False
        for item in history:
            if item == "correct":
                consecutive += 1
                attempted = True
            elif item != "peeked":
                consecutive = 0
                attempted = True
        results[kid] = "mastered" if consecutive >= 2 else "shaky" if attempted else "new"
    return results


def change(kp_id, title, before, after):
    return {"kp_id": kp_id, "title": title, "from": before, "to": after}


def spread(format_, count):
    choices = [(entry["type"], entry["count"], entry["score"]) for entry in format_["types"] if entry["count"]]
    total = sum(amount for _, amount, _ in choices)
    if not total:
        return []
    slots = [(count * amount // total, count * amount % total) for _, amount, _ in choices]
    missing = count - sum(quotient for quotient, _ in slots)
    extra = set(sorted(range(len(choices)), key=lambda i: -slots[i][1])[:missing])
    rows = [[(kind, score)] * (slots[i][0] + (i in extra)) for i, (kind, _, score) in enumerate(choices)]
    return [row[i] for i in range(max(map(len, rows))) for row in rows if i < len(row)]


def display_refs(refs, pages):
    titles = {(p["material_id"], p["page"]): p["material_title"] for p in pages}
    return [{**key, "material_title": titles[key["material_id"], key["page"]]}
            for key in ({"material_id": mid, "page": page} for mid, page in
                        dict.fromkeys((r["material_id"], r["page"]) for r in refs))]


def public_blocks(blocks):
    return [{"kind": b["kind"], **({"header": b["header"], "rows": b["rows"]} if b["kind"] == "table" else {"text": b["text"]})}
            for b in blocks]


def seal(draft, spec, qid):
    steps = [
        {"n": i, "blocks": public_blocks(step["blocks"]), "refs": display_refs(step["refs"], spec["pages"])}
        for i, step in enumerate(draft["steps"], 1)
    ]
    rubric = draft["rubric"]
    if rubric is not None:
        rubric = [{"id": f"{qid}_r{i}", "point": row["point"], "score": row["score"]}
                  for i, row in enumerate(rubric, 1)]
    refs = display_refs([ref for step in draft["steps"] for ref in step["refs"]], spec["pages"])
    options = draft["options"]
    return {
        "options": [{"id": a, "text": b} for a, b in zip(items.letters(len(options)), options)] if options else None,
        "stem": public_blocks(draft["stem"]), "refs": refs,
        "source_refs": [[{key: ref[key] for key in ("material_id", "page", "quote")} for ref in step["refs"]]
                        for step in draft["steps"]],
        "solution": {"answer": draft["answer"], "steps": steps, "rubric": rubric},
    }


class Exams:
    def __init__(self, app, api):
        self.app = app
        self.model = app.materials.model
        with app.db() as db:
            db.executescript(SCHEMA)
        app.exams = self
        app.job_handlers["exam"] = self.generate
        app.job_end_hooks["exam"] = self.settle
        app.job_retry_hooks["exam"] = self.prepare_retry
        api.add("GET", "/courses/([^/]+)/exams", self.list)
        api.add("POST", "/courses/([^/]+)/exams", self.create, "json")
        api.add("GET", "/exams/([^/]+)", self.get)
        api.add("DELETE", "/exams/([^/]+)", self.delete)
        api.add("POST", "/exams/([^/]+)/finish", self.finish)
        api.add("GET", "/exams/([^/]+)/result", self.result)
        api.add("POST", "/questions/([^/]+)/attempt", self.attempt, "json")
        api.add("POST", "/questions/([^/]+)/grade", self.grade, "json")
        api.add("POST", "/questions/([^/]+)/report", self.report, "json")

    def create(self, cid, body, topic_id=None):
        fields(body, {"count", "scope"})
        count = body["count"]
        if type(count) is not int or not 1 <= count <= 20:
            raise bad_request("题量应为 1 到 20 的整数")
        scope = one_of(body["scope"], ("plan", "all", "mistakes"), "出题范围")
        with self.app.db(write=True) as db:
            self.app.course(db, cid)
            result = self.enqueue(db, cid, count, scope, topic_id)
        self.app.wake_jobs()
        return result

    def enqueue(self, db, cid, count, scope, topic_id=None):
        kb = KnowledgeBase(db, cid)
        topics, points = kb.inventory()
        if not points:
            raise conflict("先上传资料，整理出知识点后才能出题")
        by_topic = {topic["id"]: topic for topic in topics}
        if topic_id is not None:
            if topic_id not in by_topic:
                raise not_found("主题")
            points = [kp for kp in points if kp["topic_id"] == topic_id]
        kp_states = kb.derived(points)
        if scope == "mistakes":
            wrong = {row["kp_id"] for row in db.execute(
                """SELECT m.kp_id FROM mastery_events m JOIN questions q ON q.id=m.question_id
                   JOIN exams e ON e.id=q.exam_id WHERE e.course=? AND q.status!='hidden' AND m.outcome='wrong'""", (cid,),
            )}
            points = [kp for kp in points if kp["id"] in wrong and kp_states[kp["id"]]["mastery"] == "shaky"]
        if scope == "plan":
            plan = self.app.plans.view(db, cid)
            if plan:
                must = {item["topic_id"] for item in plan["buckets"]["must"]}
                points = [kp for kp in points if kp["topic_id"] in must]
        allowed = [kp for kp in points if kp_states[kp["id"]]["level"] != "excluded"]
        format_ = exam_format(db, cid)
        if not any(entry["count"] for entry in format_["types"]):
            raise conflict("考试形式里各题型的题量都是 0，先在重点页设置考试形式")
        if not allowed:
            if scope == "mistakes":
                raise conflict("还没有做错过、需要再练的知识点")
            if topic_id is not None:
                raise conflict("这个主题的知识点都被标为不考")
            if scope == "plan" and self.app.plans.view(db, cid):
                raise conflict("计划里的必学主题没有可出题的知识点，可以把范围换成“全部”")
            raise conflict("知识点都被标为不考，没有可出的题")
        slots = spread(format_, min(count, len(allowed)))
        eid = uid("e")
        payload = {"pos": 0, "entries": [], "spares": [], "requested": count, "failed": [], "work": {}}
        used = set()
        for index, (kind, score) in enumerate(slots, 1):
            available = [p for p in allowed if p["id"] not in used]
            chosen = next((p for p in available if kind in kp_states[p["id"]]["modes"]), None)
            planned = kind
            if kind == "calc":
                chosen = next((p for p in available if "compute" in kp_states[p["id"]]["modes"]), None)
                if chosen is None:
                    # 没有可计算的知识点时，计算题注定通不过核对（真实冒烟里一道要耗 5–6 万 token），直接出简答题，分值不变
                    kind = "short"
            kp = chosen or available[0]
            used.add(kp["id"])
            entry = self.source(kb, kp, by_topic[kp["topic_id"]]["title"])
            payload["entries"].append({**entry, "qid": uid("q"), "type": kind, "planned": planned, "score": score, "position": index})
        for kp in allowed:
            if kp["id"] not in used:
                payload["spares"].append(self.source(kb, kp, by_topic[kp["topic_id"]]["title"]))
        job = self.app.new_job(db, cid, "exam", "准备出题", payload, target_id=eid)
        db.execute("INSERT INTO exams VALUES (?,?,?,?,'generating',?,?,NULL)",
                   (eid, cid, f"模拟练习 · {len(slots)} 道题", now(), job["id"], format_["basis"]))
        db.executemany(
            "INSERT INTO questions(id,exam_id,kp_id,position,status,kind,score,topic_title) VALUES (?,?,?,?,'generating',?,?,?)",
            [(e["qid"], eid, e["kp_id"], e["position"], e["type"], e["score"], e["topic_title"]) for e in payload["entries"]],
        )
        return self.view(db, exam_row(db, eid))

    @staticmethod
    def source(kb, kp, topic_title):
        return {"kp_id": kp["id"], "title": kp["title"], "summary": kp["summary"], "topic_title": topic_title,
                "pages": kb.pages(kp["material_id"], kp["pages"])}

    def generate(self, job):
        task = load(job["payload"])
        eid, jid = job["target_id"], job["id"]
        entries = task["entries"]
        while task["pos"] < len(entries):
            pos = task["pos"]
            spec = entries[pos]
            qid = spec["qid"]
            with self.app.db() as db:
                live = db.execute("SELECT 1 FROM questions WHERE id=?", (qid,)).fetchone()
            if live:
                self.generate_question(task, jid, spec)
            task["pos"] += 1
            task["work"] = {}
            with self.app.db(write=True) as db:
                self.app.checkpoint(db, jid, task["pos"] / len(entries),
                                    f"已处理 {task['pos']} / {len(entries)} 道题", task)
        with self.app.db(write=True) as db:
            count = self.usable(db, eid)
            stage = f"已生成 {count} 道题"
            if count < task["requested"] and not task["failed"]:
                stage = f"可用知识点有限，已生成 {count} 道题"
            self.app.checkpoint(db, jid, 1, stage, task)
        if task["failed"]:
            raise JobFailure(f"{len(task['failed'])} 道题多次没有通过检查，没有出成", True)
        if not count:
            raise JobFailure("出题用到的资料已被删除，这套题没有出成", False)

    def generate_question(self, task, jid, spec):
        data = task["work"]
        qid = spec["qid"]

        def save():
            with self.app.db(write=True) as db:
                # 有进展就清零失败计数：“连续 5 次没有成功”只算中间没有任何成功调用的失败
                db.execute("UPDATE jobs SET payload=?,stage=?,failures=0 WHERE id=?",
                           (dump(task), f"整理第 {spec['position']} 道题", jid))

        comments = data.setdefault("comments", [])
        hard_tries = data.setdefault("hard_tries", 0)
        soft_used = data.setdefault("soft_used", False)
        swapped = data.setdefault("swapped", False)
        while True:
            try:
                if "draft" not in data:
                    draft, hints = questions.draft(self.model, spec, comments, data, save)
                    data["draft"], data["hints"] = draft, hints
                    data["checks"] = {}
                    save()
                with self.app.db(write=True) as db:
                    db.execute("UPDATE questions SET status='verifying' WHERE id=? AND status='generating'", (qid,))
                hard, soft, notes, checked = verify.verify(self.model, spec["type"], data["draft"], spec["pages"],
                                                            data["checks"], save, data.get("code"))
            except questions.CalculationFailed:
                spec["type"] = "short"
                comments[:] = ["求解程序多次运行失败，请改出理解类简答题"]
                hard_tries, soft_used = 0, False
                data.clear()
                data.update(comments=comments, hard_tries=hard_tries, soft_used=soft_used, fallback=True, swapped=swapped)
                save()
                continue
            except OutputError as error:
                # 带上具体原因：重写时模型才知道上一版错在哪
                hard, soft, notes, checked = [f"上一版多次没有通过格式或出处核对，最后一次的问题：{error}"], [], [], False

            if hard and hard_tries >= 2:
                replacement = None
                if not swapped:
                    replacement = next((entry for entry in task["spares"] if entry["topic_title"] == spec["topic_title"]), None)
                    if replacement is None and task["spares"]:
                        replacement = task["spares"][0]
                if replacement:
                    task["spares"].remove(replacement)
                    spec.update(replacement)
                    hard_tries, soft_used, swapped = 0, False, True
                elif spec["type"] == "calc":
                    spec["type"] = "short"
                    comments[:] = ["计算题多次未通过核对，请改出理解类简答题"]
                    hard_tries, soft_used = 0, False
                    data.clear()
                    data.update(comments=comments, hard_tries=hard_tries, soft_used=soft_used, fallback=True, swapped=swapped)
                    save()
                    continue
                else:
                    with self.app.db(write=True) as db:
                        db.execute("DELETE FROM questions WHERE id=?", (qid,))
                    task["failed"].append(dict(spec))   # 留着规格，重试时重出这一道
                    return
            elif hard:
                hard_tries += 1
            elif soft and not soft_used:
                soft_used = True
            else:
                hints = data["hints"] + notes + soft
                if data.get("fallback"):
                    hints.insert(0, "这道计算题已改为简答题")
                elif spec.get("planned") == "calc" and spec["type"] == "short":
                    hints.insert(0, "资料里没有适合出计算题的知识点，这道按简答题出")
                q = seal(data["draft"], spec, qid)
                with self.app.db(write=True) as db:
                    db.execute(
                        """UPDATE questions SET kp_id=?,topic_title=?,kind=?,status='ready',draft=?,checked=?,hints=?
                           WHERE id=? AND status!='hidden'""",
                        (spec["kp_id"], spec["topic_title"], spec["type"], dump(q), checked,
                         dump(list(dict.fromkeys(hints))), qid),
                    )
                return
            fallback = data.get("fallback", False)
            data.clear()
            comments = hard or soft
            data.update(hard_tries=hard_tries, soft_used=soft_used, comments=comments, fallback=fallback, swapped=swapped)
            save()

    @staticmethod
    def usable(db, eid):
        return db.execute("SELECT count(*) FROM questions WHERE exam_id=? AND status IN ('ready','disputed','hidden')",
                          (eid,)).fetchone()[0]

    def settle(self, job):
        """出题任务结束（完成或最终失败）后定下试卷状态：有可作答的题就是 ready，否则 failed。"""
        with self.app.db(write=True) as db:
            exam = db.execute("SELECT * FROM exams WHERE id=? AND job_id=?", (job["target_id"], job["id"])).fetchone()
            if exam is None or exam["status"] != "generating":
                return
            status = "ready" if self.usable(db, exam["id"]) else "failed"
            db.execute("UPDATE exams SET status=? WHERE id=?", (status, exam["id"]))

    def prepare_retry(self, db, job):
        """只重出没出成的题：放弃过的题按原规格重新排进队列；中途中断的从断点继续。"""
        task = load(job["payload"])
        retry = [spec for spec in task["failed"] if isinstance(spec, dict)]
        for spec in retry:
            spec.update(qid=uid("q"))
            task["entries"].append(spec)
            db.execute(
                "INSERT INTO questions(id,exam_id,kp_id,position,status,kind,score,topic_title) VALUES (?,?,?,?,'generating',?,?,?)",
                (spec["qid"], job["target_id"], spec["kp_id"], spec["position"], spec["type"], spec["score"], spec["topic_title"]),
            )
        task["failed"] = []
        db.execute("UPDATE jobs SET payload=? WHERE id=?", (dump(task), job["id"]))
        db.execute("UPDATE exams SET status='generating' WHERE id=? AND status IN ('ready','failed')", (job["target_id"],))

    def delete(self, eid):
        with self.app.db(write=True) as db:
            exam = exam_row(db, eid)
            answered = db.execute("SELECT 1 FROM mastery_events m JOIN questions q ON q.id=m.question_id WHERE q.exam_id=?",
                                  (eid,)).fetchone()
            db.execute("DELETE FROM exams WHERE id=?", (eid,))
            db.execute("DELETE FROM jobs WHERE id=?", (exam["job_id"],))
            if answered:
                stale(db, exam["course"])

    @staticmethod
    def view_question(row):
        hide = row["status"] == "hidden"
        content = load(row["draft"]) if row["draft"] and not hide else {"stem": [], "options": None, "refs": [], "solution": None}
        return {"id": row["id"], "index": row["position"], "type": row["kind"], "status": row["status"],
                "score": row["score"], "topic_title": row["topic_title"], "hints": load(row["hints"]),
                "checked": bool(row["checked"]), "peeked": bool(row["peeked"]), "stem": content["stem"],
                "options": content["options"], "refs": content["refs"],
                "attempt": load(row["attempt"]) if row["attempt"] and not hide else None,
                "solution": content["solution"] if row["attempt"] and not hide else None}

    def view(self, db, exam):
        qs = [self.view_question(row) for row in db.execute("SELECT * FROM questions WHERE exam_id=? ORDER BY position", (exam["id"],))]
        job = self.app.job(db, exam["job_id"])
        active = [q for q in qs if q["status"] != "hidden"
                  and (exam["status"] == "generating" or q["status"] not in PENDING)]
        score = sum(q["attempt"]["score"] or 0 for q in active if q["attempt"]) if exam["status"] == "finished" else None
        return {"id": exam["id"], "title": exam["title"], "created_at": exam["created_at"],
                "status": exam["status"], "format_basis": exam["format_basis"], "questions": qs,
                "job": self.app.job_view(job), "score": score, "total": sum(q["score"] for q in active)}

    def get(self, eid):
        with self.app.db() as db:
            return self.view(db, exam_row(db, eid))

    def list(self, cid):
        with self.app.db() as db:
            self.app.course(db, cid)
            result = []
            for row in db.execute("SELECT * FROM exams WHERE course=? ORDER BY created_at DESC", (cid,)):
                view = self.view(db, row)
                visible = [q for q in view["questions"] if q["status"] != "hidden"
                           and (row["status"] == "generating" or q["status"] not in PENDING)]
                result.append({key: view[key] for key in ("id", "title", "created_at", "status", "score", "total")} |
                              {"question_count": len(visible), "answered": sum(q["attempt"] is not None for q in visible)})
            return result

    @staticmethod
    def ensure_ready(q, exam):
        if q["status"] not in READY:
            raise conflict("这道题当前不能作答")
        if exam["status"] == "finished":
            raise conflict("这套题已经完成")

    def attempt(self, qid, body):
        fields(body, {"response"})
        response = body["response"]
        if response is not None:
            response = text(response, "作答", empty=True)
        with self.app.db(write=True) as db:
            q = question_row(db, qid)
            exam = exam_row(db, q["exam_id"])
            self.ensure_ready(q, exam)
            if q["attempt"]:
                raise conflict("这道题已经提交过作答")
            draft = load(q["draft"])
            kind = q["kind"]
            answer = draft["solution"]["answer"]
            correct, score, state = None, None, "needs_self_grade"
            if kind == "single":
                correct = bool(response and items.choice_matches(response, answer, [o["text"] for o in draft["options"]]))
            elif kind in ("fill", "calc"):
                correct = bool(response and response.strip() and items.same_quantity(answer, response))
            if correct is not None:
                score = q["score"] if correct else 0
            if kind in ("single", "fill"):
                state = "graded"
            attempt = {"response": response, "state": state, "correct": correct, "score": score, "marks": None}
            db.execute("UPDATE questions SET attempt=? WHERE id=?", (dump(attempt), qid))
            changes = self.record(db, exam, q, correct, "automatic") if state == "graded" else []
            return {"attempt": attempt, "solution": draft["solution"], "mastery_changes": changes}

    def grade(self, qid, body):
        fields(body, {"marks"})
        marks = body["marks"]
        if not isinstance(marks, dict):
            raise bad_request("评分点选择应为对象")
        with self.app.db(write=True) as db:
            q = question_row(db, qid)
            exam = exam_row(db, q["exam_id"])
            self.ensure_ready(q, exam)
            if not q["attempt"] or load(q["attempt"])["state"] != "needs_self_grade":
                raise conflict("这道题当前不需要自评")
            solution = load(q["draft"])["solution"]
            rubric = solution["rubric"]
            if marks.keys() != {r["id"] for r in rubric}:
                raise bad_request("请为每个评分点选择一项")
            weights = {"full": 1, "partial": 0.5, "none": 0}
            score = sum(weights[one_of(marks[r["id"]], tuple(weights), "评分选项")] * r["score"] for r in rubric)
            attempt = load(q["attempt"])
            attempt.update(state="graded", score=score, marks=marks)
            db.execute("UPDATE questions SET attempt=? WHERE id=?", (dump(attempt), qid))
            changes = self.record(db, exam, q, score >= q["score"] and attempt["correct"] is not False, "self")
            return {"attempt": attempt, "solution": solution, "mastery_changes": changes}

    @staticmethod
    def record(db, exam, q, correct, mode):
        cid, kp_id = exam["course"], q["kp_id"]
        before = mastery(db, cid).get(kp_id, "new")
        outcome = "peeked" if correct and q["peeked"] else "correct" if correct else "wrong"
        db.execute("INSERT INTO mastery_events VALUES (?,?,?,?,?)", (q["id"], kp_id, outcome, mode, now()))
        after = mastery(db, cid).get(kp_id, "new")
        if after != before:
            stale(db, cid)
            row = db.execute("SELECT value FROM points WHERE id=?", (kp_id,)).fetchone()
            return [change(kp_id, load(row["value"])["title"], before, after)]
        return []

    def report(self, qid, body):
        fields(body, {"kind"}, {"note"})
        kind = one_of(body["kind"], REPORT_KINDS, "报错类型")
        note = text(body.get("note", ""), "说明", empty=True)
        with self.app.db(write=True) as db:
            q = question_row(db, qid)
            exam = exam_row(db, q["exam_id"])
            db.execute("UPDATE questions SET status='hidden', report=? WHERE id=?", (dump({"kind": kind, "note": note, "at": now()}), qid))
            if db.execute("SELECT 1 FROM mastery_events WHERE question_id=?", (qid,)).fetchone():
                stale(db, exam["course"])
            if exam["status"] == "finished":
                self.save_result(db, exam)
            return {"status": "hidden"}

    def save_result(self, db, exam):
        cid, eid = exam["course"], exam["id"]
        before, after = mastery(db, cid, omit_exam=eid), mastery(db, cid)
        changes = []
        for row in db.execute(
            """SELECT DISTINCT kp.id,kp.value FROM questions q JOIN points kp ON q.kp_id=kp.id
               WHERE q.exam_id=? AND q.status!='hidden'""", (eid,),
        ):
            a, b = before.get(row["id"], "new"), after.get(row["id"], "new")
            if a != b:
                changes.append(change(row["id"], load(row["value"])["title"], a, b))
        plan = self.app.plans.view(db, cid)
        result = {"mastery_changes": changes, "plan_stale": bool(plan and plan["stale"])}
        db.execute("UPDATE exams SET status='finished',result=? WHERE id=?", (dump(result), eid))
        return result

    def finish(self, eid):
        with self.app.db(write=True) as db:
            exam = exam_row(db, eid)
            if exam["status"] == "generating":
                raise conflict("这套练习还在出题")
            if exam["status"] == "failed":
                raise conflict("这套题没有出成，可以重试或删除")
            if not exam["result"]:
                db.execute(f"DELETE FROM questions WHERE exam_id=? AND status IN {PENDING}", (eid,))
            result = load(exam["result"]) if exam["result"] else self.save_result(db, exam)
            return {"exam": self.view(db, exam_row(db, eid)), **result}

    def result(self, eid):
        with self.app.db() as db:
            exam = exam_row(db, eid)
            if not exam["result"]:
                raise conflict("这套练习还没完成")
            return {"exam": self.view(db, exam), **load(exam["result"])}
