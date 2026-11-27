import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from server.tests.v1.test_stage1 import DEVICE
from server.v1.app import create_app


class StudyTest(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory(prefix="fullgrid-study-test-"))
        self.app = create_app(data_dir=Path(directory), mock_model=True, sms_mode="dev", worker_enabled=False)
        self.client = self.enterContext(TestClient(self.app))

    def api(self, method, path, token=None, *, status=200, **kwargs):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = self.client.request(method, f"/api/v1{path}", headers=headers, **kwargs)
        self.assertEqual(response.status_code, status, response.text)
        return response.json() if response.content else None

    def member(self, phone="13900000120"):
        return self.api("POST", "/auth/huawei", json={"auth_code": f"dev-{phone}", "device": DEVICE})["access_token"]

    def test_due_review_precedes_carried_work_and_notice_is_only_once(self):
        token = self.member("13800000000")
        today = self.api("GET", "/today", token)
        self.assertEqual(today["notice"], "昨天有 2 项没做完，已排进今天")
        self.assertIsNone(self.api("GET", "/today", token)["notice"])
        carried = [row for row in today["tasks"] if row["moved_from"]]
        self.assertEqual(len(carried), 2)
        for row in carried:
            course_tasks = [task for task in today["tasks"] if task["course_id"] == row["course_id"]]
            self.assertEqual(course_tasks[0]["kind"], "review")
            upcoming = self.api("GET", f"/courses/{row['course_id']}/home", token)["next"]
            self.assertEqual([item["id"] for item in upcoming if item["date"] == today["date"]],
                             [item["id"] for item in course_tasks[:3]])
        schedule = self.api("GET", "/schedule", token)
        self.assertEqual(len(schedule["days"]), 7)
        self.assertTrue(any(exam["name"] == "高等数学" for day in schedule["days"] for exam in day["exams"]))

    def test_replan_and_undo_preserve_pinned_row_and_restore_original_ids(self):
        token = self.member()
        today = self.api("GET", "/today", token)
        moved = today["tasks"][0]
        tomorrow = str(date.fromisoformat(today["date"]) + timedelta(days=1))
        result = self.api("PATCH", f"/tasks/{moved['id']}", token, json={"date": tomorrow})
        self.assertTrue(result["result"]["pinned"])
        self.assertEqual(result["result"]["date"], tomorrow)

        def rows():
            with self.app.state.db.transaction() as conn:
                return [dict(row) for row in conn.execute("SELECT * FROM schedule_items ORDER BY id")]
        before = rows()
        change = self.api("PATCH", "/today", token, json={"minutes": 60})
        self.assertEqual(change["result"]["minutes_available"], 60)
        self.assertTrue(any(row["id"] == moved["id"] and row["date"] == tomorrow for row in rows()))
        self.api("POST", f"/undo/{change['undo']['id']}", token)
        self.assertEqual(rows(), before)

    def test_course_without_exam_date_is_scheduled_and_excluded_points_are_not(self):
        token = self.member()
        cid = self.api("GET", "/courses", token)[0]["id"]
        self.api("PATCH", f"/courses/{cid}", token, json={"exam_date": None})
        groups = self.api("GET", f"/courses/{cid}/map", token)["chapters"]
        excluded = {kp["id"] for chapter in groups for kp in chapter["kps"] if kp["level"] == "excluded"}
        self.assertTrue(excluded)
        today = self.api("GET", "/today", token)
        self.assertTrue(any(item["course_id"] == cid for item in today["tasks"]))
        self.assertFalse(excluded.intersection(kp for item in today["tasks"] for kp in item["kp_ids"]))

    def test_question_scope_hint_ladder_and_peeked_answer(self):
        token = self.member()
        other = self.member("13900000121")
        start = self.api("POST", "/sessions", token, json={"kind": "quick", "count": 5})
        self.assertEqual(start["status"], "preparing")
        self.assertIsNone(start["course_id"])
        session = self.api("GET", f"/sessions/{start['id']}", token)
        self.assertEqual(session["status"], "active")
        question = next(item for item in session["questions"] if item["type"] == "single")
        qid = question["id"]
        self.assertIsNone(question["solution"])
        self.api("POST", f"/questions/{qid}/hint", other, status=404, json={"level": 1})
        for level in (1, 2):
            result = self.api("POST", f"/questions/{qid}/hint", token, json={"level": level})
            self.assertEqual(result["hint"]["level"], level)
            self.assertIsNone(result["question"]["solution"])
        reveal = self.api("POST", f"/questions/{qid}/hint", token, json={"level": 3})["question"]
        self.assertTrue(reveal["peeked"])
        correct = reveal["solution"]["answer"]
        answer = self.api("POST", f"/questions/{qid}/attempt", token, json={"response": correct})
        self.assertTrue(answer["question"]["attempt"]["correct"])
        self.assertEqual(answer["mastery"], [])
        with self.app.state.db.transaction() as conn:
            event = conn.execute("SELECT counted FROM learning_events WHERE question_id=?", (qid,)).fetchone()
            self.assertEqual(event[0], 0)
        self.api("POST", f"/questions/{qid}/attempt", token, status=409, json={"response": correct})

    def test_partial_completion_reviews_answered_and_unanswered_counts(self):
        token = self.member()
        start = self.api("POST", "/sessions", token, json={"kind": "quick", "count": 5})
        session = self.api("GET", f"/sessions/{start['id']}", token)
        q = next(item for item in session["questions"] if item["type"] == "single")
        with self.app.state.db.transaction() as conn:
            answer = conn.execute("SELECT answer FROM bank_questions WHERE id=?", (q["bank_id"],)).fetchone()[0]
        self.api("POST", f"/questions/{q['id']}/attempt", token, json={"response": answer})
        finished = self.api("POST", f"/sessions/{session['id']}/finish", token)
        self.assertEqual(finished["accuracy"], 0.2)
        self.assertIn("另有 4 道未答", finished["review"]["text"])

    def test_wrong_answer_mistake_and_finish_are_durable(self):
        token = self.member()
        start = self.api("POST", "/sessions", token, json={"kind": "quick", "count": 5})
        session = self.api("GET", f"/sessions/{start['id']}", token)
        question = next(item for item in session["questions"] if item["type"] == "single")
        qid, sid = question["id"], session["id"]
        response = self.api("POST", f"/questions/{qid}/attempt", token, json={"response": "Z"})
        self.assertTrue(response["mistake_added"])
        self.assertEqual(response["mastery"][0]["to"], "shaky")
        mistakes = self.api("GET", "/mistakes", token)
        self.assertEqual([item["question"]["bank_id"] for item in mistakes], [question["bank_id"]])
        result = self.api("POST", f"/sessions/{sid}/finish", token)
        self.assertEqual(result["score"], 0)
        self.assertEqual(self.api("POST", f"/sessions/{sid}/finish", token), result)
        self.assertEqual(self.api("GET", f"/sessions/{sid}/result", token), result)
        self.api("DELETE", f"/sessions/{sid}", token, status=204)
        self.assertEqual(self.api("GET", "/mistakes", token), [])
        self.assertEqual(self.api("GET", f"/kps/{question['kp']['id']}", token)["state"], "new")

    def test_two_distinct_answers_master_a_point_and_exam_compresses_due_date(self):
        token = self.member()
        today = date.fromisoformat(self.api("GET", "/today", token)["date"])
        cid = self.api("GET", "/courses", token)[0]["id"]
        exam = today + timedelta(days=2)
        self.api("PATCH", f"/courses/{cid}", token, json={"exam_date": exam.isoformat()})
        chapters = self.api("GET", f"/courses/{cid}/map", token)["chapters"]
        kid = next(point["id"] for chapter in chapters for point in chapter["kps"] if point["title"] == "银行家算法")
        session = self.api("POST", "/sessions", token, json={"kind": "kp", "kp_id": kid, "count": 3})
        view = self.api("GET", f"/sessions/{session['id']}", token)
        selected = view["questions"][:2]
        self.assertNotEqual(selected[0]["bank_id"], selected[1]["bank_id"])
        for index, question in enumerate(selected):
            with self.app.state.db.transaction() as conn:
                bank = conn.execute("SELECT answer,solution FROM bank_questions WHERE id=?", (question["bank_id"],)).fetchone()
            qid = question["id"]
            response = self.api("POST", f"/questions/{qid}/attempt", token, json={"response": bank["answer"]})
            if response["question"]["attempt"]["state"] == "needs_self_grade":
                marks = {point["id"]: "full" for point in json.loads(bank["solution"])["rubric"]}
                response = self.api("POST", f"/questions/{qid}/grade", token, json={"marks": marks})
            self.assertTrue(response["question"]["attempt"]["correct"])
            self.assertEqual(self.api("GET", f"/kps/{kid}", token)["state"], "learned" if index == 0 else "mastered")
        with self.app.state.db.transaction() as conn:
            point = conn.execute("SELECT due_at,stability FROM kp_progress WHERE kp_id=?", (kid,)).fetchone()
            self.assertEqual(point["due_at"], str(today + timedelta(days=1)))
            self.assertEqual(point["stability"], 5)
