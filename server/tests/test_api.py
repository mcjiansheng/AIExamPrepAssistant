import http.client
import json
import re
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from uuid import uuid4

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))

from app import Server
from core import App


class ApiCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.app = App(Path(temporary.name), True)
        self.server = Server(("127.0.0.1", 0), self.app)
        self.addCleanup(self.server.server_close)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.end_server)
        status, course = self.request("POST", "/courses", {"name": "演示课程"})
        self.assertEqual(status, 200)
        self.course = course
        self.path = f"/courses/{course['id']}"

    def end_server(self):
        self.server.shutdown()
        self.worker.join()

    def request(self, method, path, body=None, mime="application/json"):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            if isinstance(body, dict):
                body = json.dumps(body, ensure_ascii=False).encode()
            conn.request(method, "/api" + path, body, {"Content-Type": mime})
            response = conn.getresponse()
            content = response.read()
            return response.status, json.loads(content) if content and response.getheader("Content-Type").startswith("application/json") else content
        finally:
            conn.close()

    def contract(self, obj, labels, **enums):
        self.assertEqual(set(obj), set(labels.split()))
        for key, choices in enums.items():
            self.assertIn(obj[key], choices)

    def upload(self, *files):
        boundary = uuid4().hex
        data = b""
        for title, content in files:
            data += (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{title}"\r\n\r\n'.encode()
                     + content + b"\r\n")
        status, reply = self.request("POST", self.path + "/materials", data + f"--{boundary}--\r\n".encode(),
                                     f"multipart/form-data; boundary={boundary}")
        self.assertEqual(status, 200, reply)
        return reply

    def run_job(self):
        job = self.app.claim_job()
        self.assertIsNotNone(job)
        self.app.run_job(job)
        status, result = self.request("GET", "/jobs/" + job["id"])
        self.assertEqual(status, 200)
        self.contract(result, "id kind status progress stage error target_id created_at",
                      kind=("ingest", "focus", "exam"), status=("queued", "running", "done", "failed", "needs_input"))
        return result

    def topic_list(self):
        return self.request("GET", self.path + "/topics")[1]

    def chat(self, value, **context):
        status, raw = self.request("POST", self.path + "/chat", {"text": value, "context": context})
        self.assertEqual(status, 200, raw)
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertIn(events[-1]["type"], ("done", "error"))
        return events


class ApiTest(ApiCase):
    def test_course_and_jobs_contract(self):
        self.contract(self.request("GET", "/health")[1], "ok model mock_model")
        self.contract(self.course, "id name exam_date days_left steps next_step active_jobs",
                      next_step=("materials", "focus", "plan", "practice"))
        self.contract(self.course["steps"], "materials focus plan practice",
                      **dict.fromkeys(("materials", "focus", "plan", "practice"), ("todo", "doing", "done", "attention")))
        self.assertIn(self.course, self.request("GET", "/courses")[1])
        self.assertEqual(self.request("GET", self.path)[1], self.course)
        self.assertEqual(self.request("PATCH", self.path, {"name": "已改名"})[1]["name"], "已改名")
        self.assertEqual(self.request("DELETE", self.path)[0], 204)
        self.assertEqual(self.request("GET", self.path)[0], 404)
        self.assertEqual(self.request("GET", "/jobs"), (200, []))

    def test_material_contract_and_mixed_failure(self):
        result = self.upload(("broken.docx", b"invalid ZIP"), ("review.txt", b"Problem: explain vectors.\nSolution: a vector has coordinates."))
        self.contract(result, "materials job")
        job = self.run_job()
        self.assertEqual(job["status"], "failed")
        status, payload = self.request("GET", self.path + "/materials")
        self.assertEqual(status, 200)
        self.contract(payload, "materials suggestions")
        broken, ready = payload["materials"]
        self.contract(ready, "id title kind pages status stage progress kp_count vision superseded_by error uploaded_at",
                      kind=("slides", "homework", "notes", "review", "past_paper", "other"),
                      vision=("none", "partial", "done", "unsupported"), status=("ready",))
        self.assertEqual(broken["status"], "failed")
        self.assertIs(broken["error"]["retryable"], False)
        self.assertGreater(ready["kp_count"], 0)
        role = payload["suggestions"][0]
        self.contract(role, "id kind title detail options default_option material_ids kp_ids", kind=("role",))
        self.assertEqual(self.request("POST", "/suggestions/" + role["id"], {"choice": "review"}), (200, {"ok": True}))
        material_path = "/materials/" + ready["id"]
        self.contract(self.request("GET", material_path + "/pages/1")[1], "material_id page text image_url")
        self.assertEqual(self.request("GET", material_path + "/pages/1/image")[0], 404)
        self.contract(self.topic_list(), "chapters limited_basis")
        self.assertEqual(self.request("PATCH", material_path, {"kind": "notes"})[1]["kind"], "notes")
        self.assertEqual(self.request("DELETE", "/materials/" + broken["id"])[0], 204)
        self.assertEqual(self.request("GET", material_path + "/pages/1")[0], 200)
        self.assertEqual(self.request("POST", "/jobs/" + result["job"]["id"] + "/retry")[0], 409)

    def test_model_output_failures_split_and_skip(self):
        complete = self.app.materials.model.complete
        calls = []
        def respond(step, system, user, images=None):
            if step == "extract" and "SKIP THIS PAGE" in user:
                calls.append(user)
                return "invalid JSON"
            return complete(step, system, user, images)
        self.app.materials.model.complete = respond
        self.upload(("lecture.txt", b"SKIP THIS PAGE\fValid page describes mathematics."))
        final = self.run_job()
        self.assertEqual(len(calls), 6)
        self.assertIn("上次输出未通过校验", calls[1])
        self.assertEqual(final["status"], "failed")
        self.assertIn("已跳过", final["error"]["message"])
        material = self.request("GET", self.path + "/materials")[1]["materials"][0]
        self.assertEqual(material["status"], "ready")
        self.assertEqual(material["kp_count"], 1)
        self.assertIn("已跳过第 1 页", material["error"]["message"])

    def test_focus_and_exam_format_contract(self):
        self.upload(("demo.txt", "矩阵：规则排列\n向量：坐标的有序列表".encode()))
        self.assertEqual(self.run_job()["status"], "done")
        path = self.path + "/focus"
        _, submitted = self.request("PUT", path, {"text": "矩阵必考。矩阵不考。其他内容看一下。"})
        self.assertEqual(submitted["job"]["status"], "queued")
        self.assertEqual(self.run_job()["status"], "done")
        focus = self.request("GET", path)[1]
        self.contract(focus, "text analyzed_at job fragments suggestions")
        first, second, missing = focus["fragments"]
        self.contract(first, "id text found kps")
        sure, maybe = first["kps"]
        self.contract(sure, "id title level certainty user_choice", certainty=("sure",), level=("emphasized",))
        self.assertEqual(maybe["certainty"], "maybe")
        self.assertEqual(second["kps"][0]["level"], "excluded")
        self.assertFalse(missing["found"])
        self.assertEqual(self.request("POST", path + "/kps", {"kp_id": maybe["id"], "include": True})[0], 200)
        self.assertEqual(self.request("POST", path + "/kps", {"kp_id": maybe["id"], "include": None})[0], 200)
        self.assertEqual(focus["suggestions"][0]["default_option"], "emphasized")
        self.assertEqual(self.request("POST", "/suggestions/" + focus["suggestions"][0]["id"], {"choice": "excluded"})[0], 200)
        current = self.topic_list()["chapters"][0]["topics"][0]["kps"][0]
        self.assertEqual((current["level"], current["basis"]), ("excluded", "user"))
        format_path = self.path + "/exam-format"
        format_ = self.request("GET", format_path)[1]
        self.contract(format_, "types duration_min open_book basis", basis=("default",))
        del format_["basis"]
        format_["open_book"] = True
        self.assertEqual(self.request("PUT", format_path, format_)[1]["basis"], "user")
        self.assertTrue(self.request("GET", format_path)[1]["open_book"])

    def test_plan_includes_pins_exclusions_and_reserve(self):
        self.upload(("algebra.txt", "向量：有顺序的数".encode()), ("history.txt", "数学史：古代数学研究".encode()),
                    ("geometry.txt", "点：基本对象".encode()))
        self.assertEqual(self.run_job()["status"], "done")
        self.request("PUT", self.path + "/focus", {"text": "数学史不考。向量一定考。"})
        self.assertEqual(self.run_job()["status"], "done")
        plan_path = self.path + "/plan"
        self.assertEqual(self.request("GET", plan_path), (200, {"plan": None}))
        config = {"days": 3, "hours_per_day": 1, "start_date": "2026-11-24"}
        _, plan = self.request("POST", plan_path, config)
        self.contract(plan, "id days hours_per_day start_date total_min reserved_min limited_basis stale buckets schedule")
        self.assertEqual(plan["reserved_min"], 36)
        self.assertIn("数学史", [topic["title"] for topic in plan["buckets"]["drop"]])
        pin = next(topic for topic in plan["buckets"]["must"] if topic["title"] == "向量")
        self.contract(pin, "topic_id title chapter_title minutes reasons pinned mastery focus_kps")
        _, pinned = self.request("POST", plan_path + "/pins", {"topic_id": pin["topic_id"], "pin": "must"})
        item = next(i for day in pinned["schedule"] for i in day["items"] if i["topic_id"] == pin["topic_id"])
        self.contract(item, "id topic_id title minutes kind done", kind=("study", "practice", "review", "mock"))
        self.assertTrue(self.request("POST", "/plan-items/" + item["id"], {"done": True})[1]["done"])
        config["days"] = 2
        _, rebuilt = self.request("POST", plan_path, config)
        self.assertEqual(rebuilt["reserved_min"], 24)
        self.assertTrue(any(t["topic_id"] == pin["topic_id"] and t["pinned"] == "must" for t in rebuilt["buckets"]["must"]))
        self.assertTrue(any(i["id"] == item["id"] and i["done"] for day in rebuilt["schedule"] for i in day["items"]))
        self.request("PUT", self.path + "/focus", {"text": "点不考。"})
        self.assertTrue(self.request("GET", plan_path)[1]["plan"]["stale"])


    def test_exam_attempt_report_result(self):
        self.upload(("math.txt", "矩阵：数字的有序排列\n向量：按顺序书写的数字。\n长度：向量的模。\n角度：两向量的夹角。\n行列式：方阵的一个数。".encode()))
        self.assertEqual(self.run_job()["status"], "done")
        plan_path = self.path + "/plan"
        self.assertEqual(self.request("POST", plan_path, {"days": 3, "hours_per_day": 1.5,
                                                          "start_date": "2026-11-24"})[0], 200)
        status, exam = self.request("POST", self.path + "/exams", {"count": 5, "scope": "all"})
        self.assertEqual(status, 200, exam)
        self.contract(exam, "id title created_at status job format_basis questions score total", status=("generating",))
        q_path = "/questions/" + exam["questions"][0]["id"]
        self.assertEqual(self.request("POST", q_path + "/attempt", {"response": "A"})[0], 409)
        e_path = "/exams/" + exam["id"]
        self.assertEqual(self.request("GET", e_path + "/result")[0], 409)
        self.assertEqual(self.run_job()["status"], "done")
        live = self.request("GET", e_path)[1]
        self.assertEqual(len(live["questions"]), 5)
        self.assertEqual(live["status"], "ready")
        for q in live["questions"]:
            self.contract(q, "id index type status score topic_title stem options refs hints checked attempt solution peeked",
                          status=("ready",), type=("single","fill","calc","short","proof","design"))
            self.assertIsNone(q["solution"])
            url = "/questions/" + q["id"]
            answer = {"single": "A", "fill": "示范答案", "calc": "42"}.get(q["type"])
            code, result = self.request("POST", url + "/attempt", {"response": answer})
            self.assertEqual(code, 200, result)
            self.contract(result, "attempt solution mastery_changes")
            self.contract(result["attempt"], "response state correct score marks")
            self.contract(result["solution"], "answer steps rubric")
            if result["attempt"]["state"] == "needs_self_grade":
                marks = {point["id"]: "full" for point in result["solution"]["rubric"]}
                self.assertEqual(sum(point["score"] for point in result["solution"]["rubric"]), q["score"])
                self.assertEqual(self.request("POST", url + "/grade", {"marks": marks})[1]["attempt"]["score"], q["score"])
        self.assertEqual(self.request("POST", q_path + "/attempt", {"response":"A"})[0], 409)
        self.assertEqual(self.request("POST", q_path + "/report", {"kind": "wrong_ref", "note": "演示报错"}),
                         (200, {"status": "hidden"}))
        before = self.request("GET", e_path)[1]["questions"][0]
        self.assertEqual(before["status"], "hidden")
        self.assertIsNone(before["attempt"])
        code, final = self.request("POST", e_path + "/finish")
        self.assertEqual(code, 200, final)
        self.contract(final, "exam mastery_changes plan_stale")
        self.assertEqual(len(final["mastery_changes"]), 4)
        self.assertTrue(final["plan_stale"])
        self.assertEqual(self.request("POST", e_path + "/finish")[1], final)
        self.assertEqual(self.request("GET", e_path + "/result")[1], final)
        summary = self.request("GET", self.path + "/exams")[1][0]
        self.contract(summary, "id title created_at status question_count answered score total", status=("finished",))
        self.assertEqual(summary["question_count"], 4)

    def test_calc_with_bad_solver_becomes_short(self):
        self.upload(("demo.txt", "乘法：重复相加".encode()))
        self.assertEqual(self.run_job()["status"], "done")
        original = self.app.materials.model.complete
        def broken_solver(step, system, user, images=None):
            if step == "cfproblem":
                return json.dumps({"stem": "计算乘积", "code": "def solve(): return 1 / 0"})
            return original(step, system, user, images)
        self.app.materials.model.complete = broken_solver
        self.assertEqual(self.request("PUT", self.path + "/exam-format",
                                     {"types": [{"type":"calc","count":1,"score":10}]})[0], 200)
        _, exam = self.request("POST", self.path + "/exams", {"count": 1, "scope": "all"})
        self.assertEqual(self.run_job()["status"], "done")
        questions = self.request("GET", "/exams/" + exam["id"])[1]["questions"]
        self.assertEqual(questions[0]["type"], "short")
        self.assertIn("已改为简答题", questions[0]["hints"][0])


    def test_chat_action_proposal_and_citations(self):
        self.upload(("demo.txt", "矩阵：数字的矩形排列。\n向量：一组有序的数字。".encode()))
        self.assertEqual(self.run_job()["status"], "done")
        path = self.path + "/plan"
        self.request("POST", path, {"days": 6, "hours_per_day": 2, "start_date": "2026-11-24"})
        previous = self.request("GET", path)[1]["plan"]
        events = self.chat("重排计划为 3 天，每天 1 小时", view="plan")
        self.assertEqual(events[-1]["type"], "done", events)
        action = next(item["action"] for item in events if item["type"] == "action")
        self.contract(action, "id kind summary href undoable undone affects", kind=("replan",))
        self.assertEqual(self.request("GET", path)[1]["plan"]["days"], 3)
        self.assertEqual(self.request("POST", "/chat-actions/"+action["id"]+"/undo")[0], 200)
        self.assertEqual(self.request("GET", path)[1]["plan"], previous)
        fmt_path = self.path + "/exam-format"
        fmt = self.request("GET", fmt_path)[1]
        events = self.chat("期末开卷，有 3 道计算题", view="focus")
        proposal = next(item["proposal"] for item in events if item["type"] == "proposal")
        self.contract(proposal, "id kind summary changes status", kind=("exam_format",), status=("pending",))
        self.assertEqual(self.request("GET", fmt_path)[1], fmt)
        self.assertEqual(self.request("POST", "/chat-proposals/"+proposal["id"], {"accept": True})[0], 200)
        self.assertIs(self.request("GET", fmt_path)[1]["open_book"], True)
        events = self.chat("讲讲矩阵", view="materials")
        refs = next(item["refs"] for item in events if item["type"] == "refs")
        self.contract(refs[0], "material_id material_title page quote")
        self.assertIn("矩阵", refs[0]["quote"])
        messages = self.request("GET", self.path+"/chat")[1]["messages"]
        self.contract(messages[-1], "id role text created_at tools refs actions proposals", role=("assistant",))
        self.assertEqual(self.request("DELETE", self.path+"/chat")[0], 204)
        self.assertEqual(self.request("GET", self.path+"/chat")[1]["messages"], [])

    def test_chat_hint_then_reveal_blocks_mastery_credit(self):
        self.upload(("demo.txt", "矩阵：数字的有序排列".encode()))
        self.assertEqual(self.run_job()["status"], "done")
        self.request("PUT", self.path+"/exam-format", {"types":[{"type":"fill","count":1,"score":5}]})
        _, exam = self.request("POST", self.path+"/exams", {"count":1,"scope":"all"})
        self.assertEqual(self.run_job()["status"], "done")
        q = exam["questions"][0]
        context = {"view":"exam","exam_id":exam["id"],"question_id":q["id"]}
        hint = self.chat("这题给个提示", **context)
        self.assertNotIn("示范答案", str(hint))
        self.assertFalse(any(item["type"] == "action" for item in hint))
        reveal = self.chat("告诉我这题的答案", **context)
        self.assertIn("示范答案", str(reveal))
        result = self.request("GET", "/exams/"+exam["id"])[1]["questions"][0]
        self.assertTrue(result["peeked"])
        self.assertIsNone(result["solution"])
        _, attempt = self.request("POST", "/questions/"+q["id"]+"/attempt", {"response":"示范答案"})
        self.assertIs(attempt["attempt"]["correct"], True)
        self.assertEqual(attempt["mastery_changes"], [])
        self.assertEqual(self.topic_list()["chapters"][0]["topics"][0]["kps"][0]["mastery"], "new")


    def test_version_reuses_unchanged_points_and_rechecks_old_questions(self):
        sample = [
            "向量：可以用一组按顺序排好的数字来表示几何中的方向。",
            "矩阵：由多行多列的数排成的矩形，用来表示线性变换。",
            "圆：到定点的距离等于指定半径的所有点组成的图形。",
        ]
        upload = self.upload(("lecture_20261101.txt", "\f".join(sample).encode()))
        self.assertEqual(self.run_job()["status"], "done")
        old = upload["materials"][0]["id"]
        original = {kp["title"]: kp["id"] for t in self.topic_list()["chapters"][0]["topics"] for kp in t["kps"]}
        self.request("PUT", self.path + "/exam-format", {"types":[{"type":"single","count":3,"score":2}]})
        _, exam = self.request("POST", self.path + "/exams", {"count":3,"scope":"all"})
        self.assertEqual(self.run_job()["status"], "done")
        original_questions = self.request("GET", "/exams/"+exam["id"])[1]["questions"]
        self.assertTrue(all(q["refs"][0]["material_id"] == old for q in original_questions))
        newer = self.upload(("lecture_20261124.txt", "\f".join(sample[:2] + ["坐标轴：平面直角坐标系中相互垂直的横轴和纵轴。"]).encode()))
        self.assertEqual(self.run_job()["status"], "done")
        mid = newer["materials"][0]["id"]
        current = {kp["title"]: kp["id"] for t in self.topic_list()["chapters"][0]["topics"] for kp in t["kps"]}
        self.assertEqual(current["矩阵"], original["矩阵"])
        self.assertEqual(current["向量"], original["向量"])
        self.assertIn("坐标轴", current)
        self.assertNotIn("圆", current)
        _, materials = self.request("GET", self.path+"/materials")
        self.assertEqual(next(m for m in materials["materials"] if m["id"] == old)["superseded_by"], mid)
        questions = self.request("GET", "/exams/"+exam["id"])[1]["questions"]
        self.assertEqual([q["status"] for q in questions], ["ready","ready","disputed"])
        self.assertEqual([q["refs"][0]["material_id"] for q in questions[:2]], [mid,mid])
        self.assertIn("待复查", questions[2]["hints"][-1])

    def test_deleting_inflight_material_does_not_break_the_batch(self):
        batch = self.upload(("one.txt", b"First material contains a mathematical concept."),
                            ("two.txt", b"Second material explains a different topic."))
        original = self.app.materials.model.complete
        mid = batch["materials"][0]["id"]
        invoked = False
        def delete_while_running(step, system, user, images=None):
            nonlocal invoked
            if not invoked and step == "extract":
                invoked = True
                self.assertEqual(self.request("DELETE", "/materials/"+mid)[0], 204)
            return original(step, system, user, images)
        self.app.materials.model.complete = delete_while_running
        self.assertEqual(self.run_job()["status"], "done")
        materials = self.request("GET", self.path+"/materials")[1]["materials"]
        self.assertEqual([(m["id"],m["status"]) for m in materials], [(batch["materials"][1]["id"],"ready")])

    def test_focus_clauses_can_have_different_levels(self):
        self.upload(("demo.txt", "矩阵：组合成行列的数组\n向量：有序的坐标".encode()))
        self.assertEqual(self.run_job()["status"], "done")
        self.request("PUT", self.path+"/focus", {"text":"矩阵不考，向量一定考。"})
        self.assertEqual(self.run_job()["status"], "done")
        focus = self.request("GET", self.path+"/focus")[1]
        sure = [(k["title"],k["level"]) for f in focus["fragments"] for k in f["kps"] if k["certainty"]=="sure"]
        self.assertEqual(sure, [("矩阵", "excluded"), ("向量", "emphasized")])

    def test_pending_exam_never_serializes_unknown_model_block_fields(self):
        self.upload(("demo.txt", "矩阵：一个数字数组".encode()))
        self.assertEqual(self.run_job()["status"], "done")
        original = self.app.materials.model.complete
        def add_unknown_field(step, system, user, images=None):
            result = original(step,system,user,images)
            if step == "question":
                payload = json.loads(result)
                payload["stem"][0]["answer"] = "MODEL_ANSWER_FIELD"
                return json.dumps(payload)
            return result
        self.app.materials.model.complete = add_unknown_field
        _, exam = self.request("POST", self.path+"/exams", {"count":1,"scope":"all"})
        self.assertEqual(self.run_job()["status"], "done")
        state = self.request("GET","/exams/"+exam["id"])[1]
        self.assertNotIn("MODEL_ANSWER_FIELD", json.dumps(state))
        self.assertIsNone(state["questions"][0]["solution"])


    def test_focus_saved_before_upload_reuses_existing_text_when_points_arrive(self):
        path = self.path + "/focus"
        self.assertEqual(self.request("PUT", path, {"text":"矩阵必考。"})[0], 200)
        self.assertEqual(self.run_job()["status"], "done")
        self.assertFalse(self.request("GET",path)[1]["fragments"][0]["found"])
        self.upload(("lecture.txt", "矩阵：数字按行列排列。".encode()))
        self.assertEqual(self.run_job()["kind"], "ingest")
        self.assertEqual(self.run_job()["kind"], "focus")
        self.assertTrue(self.request("GET",path)[1]["fragments"][0]["found"])

    def test_compute_environment_exposes_only_declared_math_exports(self):
        from workflow.sandbox import SandboxError, prepare, run_code
        self.assertEqual(run_code(prepare("from math import factorial\ndef solve(): return {'answer': factorial(4)}")), {"answer":24})
        with self.assertRaises(SandboxError):
            prepare("from collections import __builtins__\ndef solve(): return 1")
        with self.assertRaises(SandboxError):
            prepare("from math import *\ndef solve(): return 1")


if __name__ == "__main__":
    unittest.main()


class ReviewFixesTest(ApiCase):
    """审查 v0.1：出题失败、模型失败不永久停用、作答页助手。"""

    def lessons(self, *lines):
        self.upload(("lesson.txt", "\n".join(lines).encode()))
        self.assertEqual(self.run_job()["status"], "done")

    def exam(self, count, kind="single"):
        self.assertEqual(self.request("PUT", self.path + "/exam-format",
                                      {"types": [{"type": kind, "count": count, "score": 2}]})[0], 200)
        status, exam = self.request("POST", self.path + "/exams", {"count": count, "scope": "all"})
        self.assertEqual(status, 200, exam)
        return exam

    def patch_model(self, replace):
        original = self.app.materials.model.complete
        def complete(step, system, user, images=None):
            reply = replace(step, system, user)
            return original(step, system, user, images) if reply is None else reply
        self.app.materials.model.complete = complete
        self.addCleanup(setattr, self.app.materials.model, "complete", original)
        return original

    def test_nothing_to_ask_is_rejected_without_creating_an_exam(self):
        self.lessons("矩阵：数字的有序排列", "向量：一组有序的数字")
        self.assertEqual(self.request("PUT", self.path + "/exam-format", {"types": []})[0], 200)
        status, reply = self.request("POST", self.path + "/exams", {"count": 5, "scope": "all"})
        self.assertEqual(status, 409)
        self.assertIn("题量都是 0", reply["error"]["message"])
        self.request("PUT", self.path + "/exam-format", {"types": [{"type": "single", "count": 2, "score": 2}]})
        status, reply = self.request("POST", self.path + "/exams", {"count": 5, "scope": "mistakes"})
        self.assertEqual(status, 409)
        self.assertIn("做错过", reply["error"]["message"])
        self.assertEqual(self.request("GET", self.path + "/exams")[1], [])

    def test_all_questions_failing_marks_exam_failed_and_retry_redoes_them(self):
        self.lessons("矩阵：数字的有序排列", "向量：一组有序的数字", "行列式：方阵的一个数")
        original = self.patch_model(lambda step, system, user: "不是 JSON" if step == "question" else None)
        exam = self.exam(2)
        job = self.run_job()
        self.assertEqual(job["status"], "failed")
        self.assertIs(job["error"]["retryable"], True)
        e_path = "/exams/" + exam["id"]
        failed = self.request("GET", e_path)[1]
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["questions"], [])
        self.assertEqual(failed["total"], 0)
        self.assertEqual(self.request("POST", e_path + "/finish")[0], 409)
        summary = self.request("GET", self.path + "/exams")[1][0]
        self.assertEqual((summary["status"], summary["question_count"]), ("failed", 0))
        self.assertEqual(self.request("GET", self.path)[1]["steps"]["practice"], "attention")
        self.app.materials.model.complete = original
        self.assertEqual(self.request("POST", "/jobs/" + job["id"] + "/retry")[0], 200)
        self.assertEqual(self.request("GET", e_path)[1]["status"], "generating")
        self.assertEqual(self.run_job()["status"], "done")
        ready = self.request("GET", e_path)[1]
        self.assertEqual(ready["status"], "ready")
        self.assertEqual([q["index"] for q in ready["questions"]], [1, 2])
        self.assertTrue(all(q["status"] == "ready" for q in ready["questions"]))

    def test_failure_midway_keeps_ready_questions_and_finish_drops_the_rest(self):
        from core import JobFailure
        self.lessons("矩阵：数字的有序排列", "向量：一组有序的数字", "行列式：方阵的一个数")
        drafts = []
        def replace(step, system, user):
            if step == "question":
                drafts.append(step)
                if len(drafts) > 1:
                    raise JobFailure("LongCat 鉴权失败（HTTP 401），检查密钥后可以重试", True)
            return None
        self.patch_model(replace)
        exam = self.exam(3)
        job = self.run_job()
        self.assertEqual((job["status"], job["error"]["retryable"]), ("failed", True))
        e_path = "/exams/" + exam["id"]
        partial = self.request("GET", e_path)[1]
        self.assertEqual(partial["status"], "ready")
        self.assertEqual([q["status"] for q in partial["questions"]], ["ready", "generating", "generating"])
        self.assertEqual(partial["total"], 2)
        self.assertEqual(self.request("GET", self.path + "/exams")[1][0]["question_count"], 1)
        code, final = self.request("POST", e_path + "/finish")
        self.assertEqual(code, 200, final)
        self.assertEqual(len(final["exam"]["questions"]), 1)
        self.assertEqual(self.request("DELETE", e_path)[0], 204)
        self.assertEqual(self.request("GET", e_path)[0], 404)
        self.assertEqual(self.request("GET", "/jobs/" + job["id"])[0], 404)

    def test_continue_after_midway_failure_keeps_answers(self):
        from core import JobFailure
        self.lessons("矩阵：数字的有序排列", "向量：一组有序的数字", "行列式：方阵的一个数")
        broken = [False]
        drafts = []
        def replace(step, system, user):
            if step == "question":
                drafts.append(step)
                if broken[0] or len(drafts) > 1:
                    broken[0] = True
                    raise JobFailure("LongCat 鉴权失败（HTTP 401），检查密钥后可以重试", True)
            return None
        original = self.patch_model(replace)
        exam = self.exam(3)
        job = self.run_job()
        e_path = "/exams/" + exam["id"]
        first = self.request("GET", e_path)[1]["questions"][0]
        self.request("POST", "/questions/" + first["id"] + "/attempt", {"response": "A"})
        self.app.materials.model.complete = original
        self.assertEqual(self.request("POST", "/jobs/" + job["id"] + "/retry")[0], 200)
        self.assertEqual(self.run_job()["status"], "done")
        done = self.request("GET", e_path)[1]
        self.assertEqual(done["status"], "ready")
        self.assertEqual([q["index"] for q in done["questions"]], [1, 2, 3])
        self.assertTrue(all(q["status"] == "ready" for q in done["questions"]))
        self.assertEqual(done["questions"][0]["id"], first["id"])
        self.assertEqual(done["questions"][0]["attempt"]["response"], "A")
        self.assertEqual(done["total"], 6)

    def test_flaky_calls_fail_the_job_only_after_five_in_a_row(self):
        from core import RetryLater
        self.lessons("矩阵：数字的有序排列", "向量：一组有序的数字")
        seen = []
        def replace(step, system, user):   # 每一步都先失败两次再成功：累计失败超过 5 次，但从未连续 5 次
            seen.append(step)
            if seen.count(step) <= 2:
                raise RetryLater("LongCat 连接或响应暂时异常")
            return None
        self.patch_model(replace)
        self.exam(1)
        for _ in range(30):
            with self.app.db(write=True) as db:
                db.execute("UPDATE jobs SET retry_at=0")
            job = self.run_job()
            if job["status"] != "queued":
                break
        self.assertGreaterEqual(len(set(seen)), 3)
        self.assertEqual(job["status"], "done", job)

    def test_option_letters_are_not_repeated_in_option_text(self):
        self.lessons("矩阵：数字的有序排列", "向量：一组有序的数字")
        def replace(step, system, user):
            if step != "question":
                return None
            draft = json.loads(original(step, system, user))
            draft["options"] = [f"{letter}. {text}" for letter, text in zip("ABCD", draft["options"])]
            return json.dumps(draft, ensure_ascii=False)
        original = self.patch_model(replace)
        exam = self.exam(1)
        self.assertEqual(self.run_job()["status"], "done")
        options = self.request("GET", "/exams/" + exam["id"])[1]["questions"][0]["options"]
        self.assertTrue(all(not re.match(r"[A-D][.、]", o["text"]) for o in options), options)

    def test_calc_needs_a_computable_point_or_is_asked_as_short(self):
        self.lessons("矩阵：数字的有序排列", "向量：一组有序的数字", "矩阵乘法：按行列相乘求和")
        steps = []
        self.patch_model(lambda step, system, user: steps.append(step))
        exam = self.exam(2, kind="calc")
        self.assertEqual(self.run_job()["status"], "done")
        first, second = self.request("GET", "/exams/" + exam["id"])[1]["questions"]
        from kb.store import KnowledgeBase
        with self.app.db() as db:
            titles = {kp["id"]: kp["title"] for kp in KnowledgeBase(db, self.course["id"]).points()}
            kp_of = dict(db.execute("SELECT id, kp_id FROM questions WHERE exam_id=?", (exam["id"],)).fetchall())
        self.assertEqual((first["type"], titles[kp_of[first["id"]]]), ("calc", "矩阵乘法"))
        self.assertEqual(second["type"], "short")
        self.assertEqual(second["score"], 2)
        self.assertEqual(second["hints"][0], "资料里没有适合出计算题的知识点，这道按简答题出")
        self.assertEqual(steps.count("cfproblem"), 1)

    def test_model_failures_never_disable_the_client(self):
        import io
        import os
        import urllib.error
        from unittest import mock
        import model
        from core import JobFailure, RetryLater
        client = model.LongCatClient(self.app.data_dir)
        ok = json.dumps({"choices": [{"message": {"content": "{\"ok\": true}"}}], "usage": {"total_tokens": 3}}).encode()
        replies = [urllib.error.URLError("offline")] * 5 + [ok]
        def urlopen(request, timeout=None):
            item = replies.pop(0)
            if isinstance(item, Exception):
                raise item
            return io.BytesIO(item)
        with mock.patch.dict(os.environ, {"LONGCAT_API_KEY": "k" * 20}), mock.patch.object(model.urllib.request, "urlopen", urlopen):
            for _ in range(5):
                with self.assertRaises(RetryLater):
                    client.complete("question", "s", "u")
            self.assertEqual(client.complete("question", "s", "u"), "{\"ok\": true}")
            denied = urllib.error.HTTPError("https://x", 401, "Unauthorized", {}, io.BytesIO(b"{}"))
            replies[:] = [denied, ok]
            with self.assertRaises(JobFailure) as caught:
                client.complete("question", "s", "u")
            self.assertIs(caught.exception.retryable, True)
            self.assertIn("鉴权失败", str(caught.exception))
            self.assertEqual(client.complete("question", "s", "u"), "{\"ok\": true}")

    def test_exam_page_assistant_routes_intent_and_never_leaks_the_answer(self):
        self.lessons("矩阵：数字的有序排列", "向量：一组有序的数字")
        exam = self.exam(1)
        self.assertEqual(self.run_job()["status"], "done")
        q = self.request("GET", "/exams/" + exam["id"])[1]["questions"][0]
        context = {"view": "exam", "exam_id": exam["id"], "question_id": q["id"]}
        replan = self.chat("重排计划为 2 天，每天 1 小时", **context)
        self.assertEqual([e["action"]["kind"] for e in replan if e["type"] == "action"], ["replan"])
        hint = self.chat("这题怎么想", **context)
        text_ = "".join(e.get("delta", "") for e in hint)
        self.assertIn("先看下方课件页", text_)
        self.assertTrue(any(e["type"] == "refs" for e in hint))
        self.assertFalse(any(e["type"] == "action" for e in hint))
        self.patch_model(lambda step, system, user: json.dumps({"hint": "答案是 A，直接选它。"}) if step == "chat_hint" else None)
        leaked = "".join(e.get("delta", "") for e in self.chat("这题给个提示", **context))
        self.assertNotIn("答案是 A", leaked)
        self.assertIn("先圈出题干里的已知条件", leaked)
        reveal = self.chat("能直接告诉我这题选什么吗", **context)
        self.assertEqual([e["action"]["kind"] for e in reveal if e["type"] == "action"], ["reveal"])
        self.assertTrue(self.request("GET", "/exams/" + exam["id"])[1]["questions"][0]["peeked"])
        self.request("POST", "/questions/" + q["id"] + "/attempt", {"response": "A"})
        explain = "".join(e.get("delta", "") for e in self.chat("这题为什么这样做", **context))
        self.assertIn("这道题的关键在第一步", explain)

    def test_reveals_answer_rules(self):
        from chat import reveals_answer
        options = ["符合定义", "没有关系", "只能用于另一场景", "与定义矛盾"]
        self.assertTrue(reveals_answer("答案是 A", "single", "A", options, ""))
        self.assertTrue(reveals_answer("A 是正确的", "single", "A", options, ""))
        self.assertFalse(reveals_answer("先看选项 A 和 B 的说法有什么不同", "single", "A", options, ""))
        self.assertTrue(reveals_answer("B 把概念说反了，C 讲的是另一场景，D 与定义矛盾", "single", "A", options, ""))
        self.assertFalse(reveals_answer("比较 B 和 C，看哪个符合定义", "single", "A", options, ""))
        self.assertTrue(reveals_answer("一共缺页 10 次", "fill", "10", None, "引用串 7,0,1,2"))
        self.assertFalse(reveals_answer("引用串里有 7 个不同页面", "fill", "10", None, "引用串 7,0,1,2"))
        answer = "由输入井和输出井、输入缓冲区和输出缓冲区、输入进程和输出进程组成"
        self.assertTrue(reveals_answer("它由输入井和输出井、输入缓冲区和输出缓冲区组成", "short", answer, None, ""))
        self.assertFalse(reveals_answer("想想数据先放在磁盘上的哪里", "short", answer, None, ""))

    def test_hard_failure_swaps_spare_at_most_once_and_calc_falls_back_to_short(self):
        self.lessons("一：计算甲", "二：计算乙", "三：计算丙", "四：计算丁", "五：计算戊", "六：计算己")
        seen = {"readback": 0, "v4_on_calc": 0}
        original = self.app.materials.model.complete

        def replace(step, system, user):
            if step == "readback":
                seen["readback"] += 1
                return json.dumps({"ok": False, "reason": "条件不一致"})
            if step == "v4" and "cfproblem" not in user and "\"table\"" in user:
                seen["v4_on_calc"] += 1
            return None

        self.patch_model(replace)
        exam = self.exam(1, kind="calc")
        self.assertEqual(self.run_job()["status"], "done")
        q = self.request("GET", "/exams/" + exam["id"])[1]["questions"][0]
        self.assertEqual(q["type"], "short")
        self.assertIn("已改为简答题", q["hints"][0])
        self.assertEqual(seen["readback"], 6)
        self.assertEqual(seen["v4_on_calc"], 0)
