import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.tests.v1.test_contract import sample_pdf
from server.tests.v1.test_stage1 import DEVICE
from server.v1 import generation, pipeline
from server.v1.app import create_app
from server.v1.model_runtime import MockClient, OutputError, legacy_model

TEXT = ("Process scheduling assigns processor time to ready processes. "
        "A priority queue orders candidates by their priorities. "
        "Round-robin scheduling grants each ready process a time slice.").encode()


class AiFlowTest(unittest.TestCase):
    def setUp(self):
        base = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="fullgrid-ai-test-")))
        self.app = create_app(data_dir=base, mock_model=True, sms_mode="dev")
        self.base = base
        self.client = self.enterContext(TestClient(self.app))

    def api(self, method, path, token=None, *, status=200, **kwargs):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = self.client.request(method, f"/api/v1{path}", headers=headers, **kwargs)
        self.assertEqual(response.status_code, status, response.text)
        return response.json() if response.content else None

    def member(self, phone="13900000123"):
        return self.api("POST", "/auth/huawei", json={"auth_code": f"dev-{phone}", "device": DEVICE})["access_token"]

    def add_model(self, token, key="test-fullgrid-key-9876"):
        provider = self.api("POST", "/me/providers", token, json={"preset_id": "longcat", "key": key})
        return self.api("POST", f"/me/providers/{provider['id']}/check", token)

    def wait_for(self, token, path, statuses):
        until = time.monotonic() + 6
        while time.monotonic() < until:
            row = self.api("GET", path, token)
            if row["status"] in statuses:
                return row
            time.sleep(0.025)
        self.fail(f"{path} did not reach {statuses}")

    def upload(self, token, cid, text=TEXT):
        return self.api("POST", f"/courses/{cid}/materials", token, data={"source": "file"},
                        files=[("files", ("scheduling.txt", text, "text/plain"))])

    def new_course(self, token):
        return self.api("POST", "/courses", token, json={"name": "调度演示"})["id"]

    def organize(self, token):
        self.assertEqual(self.add_model(token)["connection"]["status"], "ok")
        cid = self.new_course(token)
        result = self.upload(token, cid)
        job = self.wait_for(token, f"/jobs/{result['job']['id']}", {"done", "failed"})
        self.assertEqual(job["status"], "done", job)
        chapters = self.api("GET", f"/courses/{cid}/map", token)["chapters"]
        self.assertEqual([chapter["title"] for chapter in chapters], ["scheduling"])
        return cid

    def test_keys_are_encrypted_and_invalid_connections_update_visibly(self):
        token = self.member()
        alternate = self.member("13900000124")
        key = "unique-test-secret-model-7719"
        with self.assertLogs("fullgrid.http", level="INFO") as logs:
            good = self.add_model(token, key)
            bad = self.add_model(token, "test-bad-key-invalid")
            limited = self.add_model(token, "test-empty-quota-key")
        self.assertEqual(good["connection"]["key_last4"], "7719")
        self.assertEqual(bad["connection"]["status"], "invalid")
        self.assertEqual([step["id"] for step in bad["steps"]], ["connect"])
        self.assertEqual(limited["connection"]["status"], "limited")
        self.assertNotIn(key, str(good) + str(bad) + "\n".join(logs.output))
        with self.app.state.db.transaction() as conn:
            cipher = conn.execute("SELECT key_ciphertext FROM provider_connections WHERE id=?",
                                  (good["connection"]["id"],)).fetchone()[0]
            self.assertNotIn(key.encode(), cipher)
        self.api("POST", f"/me/providers/{good['connection']['id']}/check", alternate, status=404)
        self.assertEqual(self.api("GET", "/me/providers", alternate), [])

    def test_waiting_upload_resumes_after_connection_and_counts_usage(self):
        token = self.member()
        cid = self.new_course(token)
        received = self.upload(token, cid, b"\f".join([TEXT] * 9))
        self.assertEqual(received["materials"][0]["status"], "waiting_ai")
        self.assertIsNone(received["job"])
        self.add_model(token)
        with self.app.state.db.transaction() as conn:
            jid = conn.execute("SELECT id FROM jobs WHERE course_id=? AND kind='ingest'", (cid,)).fetchone()[0]
        result = self.wait_for(token, f"/jobs/{jid}", {"needs_input", "done", "failed"})
        self.assertEqual(result["status"], "needs_input", result)
        self.assertTrue(result["estimate"]["needs_confirm"])
        paused = self.api("GET", f"/courses/{cid}/materials", token)[0]
        self.assertEqual(paused["status"], "waiting_confirm")
        self.api("POST", f"/jobs/{jid}/continue", token)
        self.api("POST", f"/jobs/{jid}/continue", token, status=409)
        self.assertEqual(self.wait_for(token, f"/jobs/{jid}", {"done", "failed"})["status"], "done")
        usage = self.api("GET", "/me/usage", token)
        self.assertGreater(usage["total"]["tokens_in"], 0)

    def upload_pdf(self, token, cid, pages):
        return self.api("POST", f"/courses/{cid}/materials", token, data={"source": "file"},
                        files=[("files", ("调度资料.pdf", sample_pdf(pages), "application/pdf"))])

    @unittest.skipUnless(sys.platform == "darwin", "PDFKit is a macOS framework")
    def test_pdf_page_count_without_pdfinfo_pauses_in_upload_response(self):
        token = self.member()
        self.add_model(token)
        cid = self.new_course(token)
        with patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}):
            self.assertIsNone(shutil.which("pdfinfo"))
            upload = self.upload_pdf(token, cid, 20)
        self.assertEqual(upload["job"]["status"], "needs_input")
        self.assertEqual(upload["job"]["estimate"]["tokens_max"], 84_000)
        self.assertEqual(upload["materials"][0]["pages"], 20)
        self.assertEqual(upload["materials"][0]["status"], "waiting_confirm")

    def test_pdf_text_layer_counts_pages_before_any_model_call(self):
        token = self.member()
        self.add_model(token)
        cid = self.new_course(token)
        before = self.api("GET", "/me/limits", token)["today_tokens"]
        with patch.object(pipeline, "page_count", return_value=None):
            upload = self.upload_pdf(token, cid, 20)
            self.assertEqual(upload["job"]["status"], "queued")
            paused = self.wait_for(token, f"/jobs/{upload['job']['id']}", {"needs_input", "done", "failed"})
        self.assertEqual(paused["status"], "needs_input", paused)
        self.assertEqual(paused["estimate"]["tokens_max"], 84_000)
        material, = self.api("GET", f"/courses/{cid}/materials", token)
        self.assertEqual((material["pages"], material["status"]), (20, "waiting_confirm"))
        self.assertEqual(self.api("GET", "/me/limits", token)["today_tokens"], before)

    def test_daily_limit_pauses_after_completed_batch_and_allows_later_continue(self):
        token = self.member()
        self.add_model(token)
        cid = self.new_course(token)
        self.api("PUT", "/me/limits", token, json={"daily_tokens": 1})
        upload = self.upload(token, cid)
        jid = upload["job"]["id"]
        result = self.wait_for(token, f"/jobs/{jid}", {"needs_input", "done", "failed"})
        self.assertEqual(result["status"], "needs_input", result)
        self.assertEqual(result["stage"], "已达今日上限")
        self.assertIsNone(result["estimate"])
        self.api("POST", f"/jobs/{jid}/continue", token, status=409)
        self.api("PUT", "/me/limits", token, json={"daily_tokens": None})
        self.api("POST", f"/jobs/{jid}/continue", token)
        self.assertEqual(self.wait_for(token, f"/jobs/{jid}", {"done", "failed"})["status"], "done")

    def test_malformed_model_batch_is_split_and_bad_page_is_visible(self):
        def draw(model, pages):
            if len(pages) > 1 or pages[0]["page"] == 2:
                raise OutputError("bad mock output")
            return [{"title": "调度", "summary": "轮转分配时间片", "pages": [pages[0]["page"]]}]
        with patch.object(pipeline.v0_materials, "draft_points", side_effect=draw) as mocked:
            points, skipped = pipeline.extract_batch(None, [{"page": 1, "text": "one"}, {"page": 2, "text": "two"}])
        self.assertEqual([point["pages"] for point in points], [[1]])
        self.assertEqual(skipped, [2])
        self.assertEqual(mocked.call_count, 3)

    def test_focus_analysis_reuses_the_original_mapping_pipeline(self):
        token = self.member()
        cid = self.organize(token)
        course = self.api("GET", f"/courses/{cid}/map", token)
        point = course["chapters"][0]["kps"][0]
        focus = self.api("POST", f"/courses/{cid}/focus/fragments", token, json={"text": point["title"]})
        jid = focus["job"]["id"]
        self.assertEqual(self.wait_for(token, f"/jobs/{jid}", {"done", "failed"})["status"], "done")
        result = self.api("GET", f"/courses/{cid}/focus", token)
        self.assertTrue(result["fragments"][0]["found"])
        self.assertIn(point["id"], [fragment["id"] for fragment in result["fragments"][0]["kps"]])
        unmatched = self.api("POST", f"/courses/{cid}/focus/fragments", token, json={"text": "月球轨道"})
        self.assertEqual(self.wait_for(token, f"/jobs/{unmatched['job']['id']}", {"done", "failed"})["status"], "done")
        fragments = self.api("GET", f"/courses/{cid}/focus", token)["fragments"]
        self.assertFalse(next(row for row in fragments if row["text"] == "月球轨道")["found"])

    def test_corrupt_file_is_visible_but_does_not_fail_its_batch(self):
        token = self.member()
        self.add_model(token)
        cid = self.new_course(token)
        uploaded = self.api(
            "POST", f"/courses/{cid}/materials", token, data={"source": "file"},
            files=[("files", ("broken.pdf", b"this is not a PDF", "application/pdf")),
                   ("files", ("scheduler.txt", TEXT, "text/plain"))],
        )
        self.assertEqual(self.wait_for(token, f"/jobs/{uploaded['job']['id']}", {"done", "failed"})["status"], "done")
        rows = {item["title"]: item for item in self.api("GET", f"/courses/{cid}/materials", token)}
        self.assertEqual(rows["broken.pdf"]["status"], "failed")
        self.assertIn("另存", rows["broken.pdf"]["error"]["message"])
        self.assertEqual(rows["scheduler.txt"]["status"], "ready")

    def test_only_failed_portion_is_retained_after_consecutive_service_errors(self):
        token = self.member()
        self.add_model(token)
        cid = self.new_course(token)
        from server.v1.model_runtime import RetryLater
        with patch.object(pipeline, "run_ingest", side_effect=RetryLater("服务商暂时异常")):
            payload = self.upload(token, cid)
            jid = payload["job"]["id"]
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                state = self.api("GET", f"/jobs/{jid}", token)
                if state["status"] == "failed":
                    break
                with self.app.state.db.transaction(write=True) as conn:
                    conn.execute("UPDATE jobs SET run_after=NULL WHERE id=? AND status='queued'", (jid,))
                time.sleep(0.03)
            self.assertEqual(state["status"], "failed")
            self.assertEqual(state["error"], {"message": "服务商暂时异常，连续 5 次没有成功", "retryable": True})
        self.api("POST", f"/jobs/{jid}/retry", token)
        self.assertEqual(self.wait_for(token, f"/jobs/{jid}", {"done", "failed"})["status"], "done")

    def test_short_question_accepts_empty_options_and_single_step_rubric(self):
        token = self.member()
        cid = self.organize(token)
        original = MockClient.complete
        altered = []

        def answer(model, step, system, prompt, images=None):
            raw = original(model, step, system, prompt, images)
            if step == "question" and legacy_model.data_from(prompt)["type"] == "short":
                value = json.loads(raw)
                self.assertEqual(len(value["steps"]), 1)
                value["options"] = []
                value["rubric"][1]["step"] = 2
                altered.append(True)
                return json.dumps(value, ensure_ascii=False)
            return raw

        with patch.object(MockClient, "complete", answer):
            session = self.api("POST", "/sessions", token,
                               json={"kind": "quick", "course_id": cid, "count": 5, "confirm": True})
            job = self.wait_for(token, f"/jobs/{session['job']['id']}", {"done", "failed"})
        self.assertTrue(altered)
        self.assertEqual(job["status"], "done", job)
        q = next(item for item in self.api("GET", f"/sessions/{session['id']}", token)["questions"] if item["type"] == "short")
        self.assertEqual(q["status"], "ready")
        self.assertEqual(q["check"], "passed")

    def test_draft_is_answerable_before_review_and_flagged_answer_does_not_score(self):
        token = self.member()
        cid = self.organize(token)
        verifying = Event()
        release = Event()

        def delayed_review(*args, **kwargs):
            verifying.set()
            if not release.wait(5):
                self.fail("the test did not release the verifier")
            return ["核对发现题干条件有误"], [], [], True

        with patch.object(generation.verification, "verify", side_effect=delayed_review):
            new = self.api("POST", "/sessions", token, json={"kind": "quick", "course_id": cid, "count": 1})
            sid = new["id"]
            try:
                self.assertTrue(verifying.wait(5))
                session = self.api("GET", f"/sessions/{sid}", token)
                question = session["questions"][0]
                self.assertEqual(question["check"], "checking")
                self.assertEqual(question["status"], "ready")
                self.assertIsNone(question["solution"])
                qid = question["id"]
                with self.app.state.db.transaction() as conn:
                    key = conn.execute("SELECT answer FROM bank_questions WHERE id=?", (question["bank_id"],)).fetchone()[0]
                submitted = self.api("POST", f"/questions/{qid}/attempt", token, json={"response": key})
                self.assertTrue(submitted["question"]["attempt"]["correct"])
            finally:
                release.set()
            self.assertEqual(self.wait_for(token, f"/jobs/{new['job']['id']}", {"done", "failed"})["status"], "done")
        final = self.api("GET", f"/sessions/{sid}", token)["questions"][0]
        self.assertEqual(final["check"], "flagged")
        self.assertTrue(final["attempt"]["correct"])
        result = self.api("POST", f"/sessions/{sid}/finish", token)
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["score"], 0)

    def test_unanswered_question_is_replaced_in_same_slot(self):
        token = self.member()
        cid = self.organize(token)
        with patch.object(generation.verification, "verify", side_effect=[
            (["有硬错误"], [], [], True), ([], [], [], True),
        ]):
            new = self.api("POST", "/sessions", token, json={"kind": "quick", "course_id": cid, "count": 1})
            self.assertEqual(self.wait_for(token, f"/jobs/{new['job']['id']}", {"done", "failed"})["status"], "done")
        session = self.api("GET", f"/sessions/{new['id']}", token)
        self.assertEqual(session["questions"][0]["id"], new["questions"][0]["id"])
        self.assertEqual(session["questions"][0]["version"], 2)
        self.assertTrue(session["questions"][0]["replaced"])
        self.assertEqual(session["questions"][0]["check"], "passed")
