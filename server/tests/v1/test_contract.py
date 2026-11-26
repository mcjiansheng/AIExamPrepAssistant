"""Exercise the published sample responses through the real FastAPI router."""
import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from server.tests.v1.test_stage1 import DEVICE, SAMPLES, assert_sample_structure
from server.v1.app import create_app
from server.v1.focus import seed_focus
from server.v1.providers import red_square


NULLABLE = {
    "GET-me-usage": {"response.total.cost", "response.by_feature[].cost", "response.by_course[].cost"},
    "GET-today": {"response.resume.detail", "response.resume.device", "response.tasks[].moved_from"},
    "PATCH-tasks-id": {"response.result.moved_from"},
    "GET-kps-id": {"response.pages[].quote", "response.sections[].refs[].quote"},
    "POST-kps-id-understood": {"response.result.next_kp_id"},
    "POST-sessions": {"response.job"},
    "GET-sessions-id": {"response.job"},
    "POST-courses-id-materials": {"response.job.progress", "response.materials[].kp_count", "response.materials[].progress"},
    "POST-jobs-id-continue": {"response.progress"},
    "POST-sessions-id-finish": {"response.session.job"},
}


def sample_pdf(pages):
    kids = " ".join(f"{number} 0 R" for number in range(3, 3 + pages))
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>"]
    objects += ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"] * pages
    text = "%PDF-1.4\n"
    offsets = []
    for index, body in enumerate(objects, 1):
        offsets.append(len(text))
        text += f"{index} 0 obj\n{body}\nendobj\n"
    xref = len(text)
    text += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    text += "".join(f"{offset:010d} 00000 n \n" for offset in offsets)
    return (text + f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode("ascii")


class ContractTest(unittest.TestCase):
    def setUp(self):
        base = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="fullgrid-contract-test-")))
        self.app = create_app(data_dir=base, mock_model=True, sms_mode="dev", worker_enabled=False)
        self.client = self.enterContext(TestClient(self.app))
        self.headers = {}
        self.matched = set()

    def call(self, method, path, *, sample=None, status=200, **kwargs):
        response = self.client.request(method, "/api/v1" + path, headers=self.headers, **kwargs)
        self.assertEqual(response.status_code, status, response.text)
        if not response.content:
            return None
        content = response.headers.get("content-type", "")
        if content.startswith("image/"):
            return response.content
        if "ndjson" in content:
            value = [json.loads(line) for line in response.text.splitlines()]
            self.assertIn(value[-1]["type"], {"done", "error"})
        else:
            value = response.json()
        if sample:
            name = sample + ".json"
            self.matched.add(name)
            with self.subTest(sample=sample):
                assert_sample_structure(self, value, json.loads((SAMPLES / name).read_text()), nullable=NULLABLE.get(sample, ()))
        return value

    def test_published_response_examples(self):
        call = self.call
        self.assertTrue(call("GET", "/health", sample="GET-health")["ok"])
        call("GET", "/today", status=401, sample="ERROR-unauthorized")
        sms = call("POST", "/auth/sms", json={"phone": "13800000000"}, sample="POST-auth-sms")
        auth = call("POST", "/auth/login", json={"phone": "13800000000", "code": sms["dev_code"], "device": DEVICE},
                    sample="POST-auth-login")
        self.headers = {"Authorization": "Bearer " + auth["access_token"]}
        for path in ("/me", "/me/settings", "/providers/presets", "/me/models", "/me/usage", "/me/limits", "/schedule",
                     "/practice", "/mistakes", "/notifications", "/plugins"):
            call("GET", path, sample="GET-" + path[1:].replace("/", "-"))
        plugins = call("GET", "/plugins/compute-first", sample="GET-plugins-id")
        self.assertEqual(plugins["source"], "builtin")
        provider = call("GET", "/me/providers", sample="GET-me-providers")[0]
        result = call("POST", f"/me/providers/{provider['id']}/check", sample="POST-me-providers-id-check")
        self.assertEqual(result["connection"]["status"], "ok")
        today = call("GET", "/today", sample="GET-today")
        call("PATCH", f"/tasks/{today['tasks'][0]['id']}", json={"status": "done"}, sample="PATCH-tasks-id")
        course_rows = call("GET", "/courses", sample="GET-courses")
        cid = next(row["id"] for row in course_rows if row["name"] == "操作系统")
        home = call("GET", f"/courses/{cid}/home", sample="GET-courses-id-home")
        kid = next(point["id"] for chapter in home["map"]["chapters"] for point in chapter["kps"] if point["title"] == "银行家算法")
        detail = call("GET", f"/kps/{kid}", sample="GET-kps-id")
        call("POST", f"/kps/{kid}/understood", json={}, sample="POST-kps-id-understood")
        for endpoint in ("materials", "focus", "exam-format", "insight"):
            call("GET", f"/courses/{cid}/{endpoint}", sample=f"GET-courses-id-{endpoint}")
        page = detail["pages"][0]
        call("GET", f"/materials/{page['material_id']}/pages/{page['page']}", sample="GET-materials-id-pages-n")
        question_set = call("POST", "/sessions", json={"kind": "quick", "course_id": cid, "count": 3}, sample="POST-sessions")
        sid = question_set["id"]
        ready = call("GET", f"/sessions/{sid}", sample="GET-sessions-id")
        q = next(item for item in ready["questions"] if item["type"] == "single")
        call("POST", f"/questions/{q['id']}/hint", json={"level": 1}, sample="POST-questions-id-hint")
        call("POST", f"/questions/{q['id']}/attempt", json={"response": q["options"][0]["id"]},
             sample="POST-questions-id-attempt")
        call("POST", f"/sessions/{sid}/finish", sample="POST-sessions-id-finish")
        tid = next(row["id"] for row in call("GET", "/threads", sample="GET-threads") if row["course_id"] == cid)
        call("POST", f"/threads/{tid}/messages",
             json={"text": "把操作系统挪到明天", "context": {"route": "/", "course_id": cid}},
             sample="POST-threads-id-messages.ndjson")
        call("GET", f"/threads/{tid}", sample="GET-threads-id")
        contents = sample_pdf(20)
        upload = call("POST", f"/courses/{cid}/materials", data={"source": "file"},
                      files=[("files", ("资料.pdf", contents, "application/pdf"))], sample="POST-courses-id-materials")
        self.assertEqual(upload["job"]["status"], "needs_input")
        call("POST", f"/jobs/{upload['job']['id']}/continue", sample="POST-jobs-id-continue")
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute("UPDATE courses SET sample=0 WHERE id=?", (cid,))
            conn.execute("DELETE FROM bank_questions WHERE course_id=?", (cid,))
        error = call("POST", "/sessions", json={"kind": "quick", "course_id": cid, "count": 5},
                     status=409, sample="ERROR-needs_confirmation")
        self.assertEqual(error["error"]["code"], "needs_confirmation")
        self.assertEqual(self.matched, {sample.name for sample in SAMPLES.glob("*.json")})

    def demo(self):
        result = self.call("POST", "/auth/huawei", json={"auth_code": "dev-13800000000", "device": DEVICE})
        self.headers = {"Authorization": "Bearer " + result["access_token"]}
        courses = self.call("GET", "/courses")
        return next(row["id"] for row in courses if row["name"] == "操作系统")

    def test_remaining_material_focus_and_plan_routes(self):
        call = self.call
        cid = self.demo()
        rows = call("GET", f"/courses/{cid}/materials")
        mid = rows[0]["id"]
        page, *_ = call("GET", f"/materials/{mid}/pages")["pages"]
        png = red_square()
        image = self.app.state.data_dir / "test-page.png"
        image.write_bytes(png)
        decision = {"kind": "role", "text": "请选择资料类型", "options": [
            {"id": "slides", "label": "讲义"}, {"id": "review", "label": "复习资料"},
        ], "choice": "slides"}
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute("UPDATE materials SET decision=? WHERE id=?", (json.dumps(decision), mid))
            conn.execute("UPDATE material_pages SET image_path=? WHERE material_id=? AND page=?",
                         (image.name, mid, page["page"]))
        self.assertEqual(call("GET", f"/materials/{mid}/pages/{page['page']}/image"), png)
        changed = call("POST", f"/materials/{mid}/decision", json={"choice": "review"})
        self.assertEqual(changed["result"]["kind"], "review")
        call("POST", f"/undo/{changed['undo']['id']}")
        link = call("POST", f"/courses/{cid}/photo-link")
        self.assertTrue(link["url"].startswith("fullgrid://photo?"))
        on = call("GET", "/today")["date"]
        self.assertEqual(call("PATCH", f"/schedule/days/{on}", json={"minutes": 90})["result"]["minutes_available"], 90)
        self.assertEqual(call("POST", "/schedule/rebuild")["result"]["from"], on)
        with self.app.state.db.transaction(write=True) as conn:
            uid = conn.execute("SELECT user_id FROM courses WHERE id=?", (cid,)).fetchone()[0]
            seed_focus(conn, uid, cid, "银行家算法不考。银行家算法强调。", "os",
                       {"exclude": ["不考"], "emphasize": ["强调"]})
        focus = call("GET", f"/courses/{cid}/focus")
        conflict = next(row for row in focus["conflicts"] if row["title"] == "银行家算法")
        chose = call("POST", f"/focus/conflicts/{conflict['id']}", json={"choice": "excluded"})
        self.assertNotIn(conflict["id"], {row["id"] for row in chose["result"]["conflicts"]})
        self.assertEqual(call("GET", f"/kps/{conflict['kp_id']}")["level"], "excluded")
        kid = focus["fragments"][0]["kps"][0]["id"]
        self.assertTrue(call("POST", f"/courses/{cid}/focus/kps", json={"kp_id": kid, "include": False})["undo"])
        self.assertEqual(call("POST", f"/kps/{kid}/mark", json={"mark": "shaky"})["result"]["state"], "shaky")
        call("DELETE", f"/materials/{mid}", status=204)
        call("GET", f"/materials/{mid}/pages", status=404)

    def test_remaining_provider_and_practice_routes(self):
        call = self.call
        cid = self.demo()
        latest = call("POST", "/me/providers", json={"preset_id": "longcat", "key": "demo-key-for-contract-tests"})
        provider = call("PATCH", f"/me/providers/{latest['id']}", json={"name": "另一连接"})
        self.assertEqual(provider["name"], "另一连接")
        roles = call("PUT", "/me/models", json={"roles": {"chat": {"connection_id": provider["id"], "model": "LongCat-2.5"}}})
        self.assertEqual(roles["roles"]["chat"]["connection_id"], provider["id"])
        call("DELETE", f"/me/providers/{provider['id']}", status=204)
        self.assertIsNone(call("GET", "/me/models")["roles"]["chat"])
        quote = call("POST", "/estimate", json={"op": "session", "kind": "quick", "course_id": cid, "count": 5})
        self.assertTrue(quote["needs_confirm"])
        sid = call("POST", "/sessions", json={"kind": "quick", "course_id": cid})["id"]
        call("PATCH", f"/sessions/{sid}", status=204, json={"position": 1})
        current = call("GET", f"/sessions/{sid}")
        self.assertEqual(current["position"], 1)
        question = next(row for row in current["questions"] if row["type"] == "single")
        call("POST", f"/questions/{question['id']}/attempt", json={"response": "Z"})
        mistakes = call("GET", "/mistakes")
        bad = next(row["question"] for row in mistakes if row["question"]["bank_id"] == question["bank_id"])
        similar = call("POST", f"/mistakes/{bad['bank_id']}/similar")
        self.assertEqual(similar["kind"], "kp")
        self.assertNotEqual(similar["questions"][0]["bank_id"], bad["bank_id"])
        undo = call("DELETE", f"/mistakes/{bad['bank_id']}")["undo"]
        self.assertIsNotNone(undo)
        call("POST", f"/undo/{undo['id']}")
        hidden = call("POST", f"/questions/{question['id']}/report", json={"kind": "wrong_ref", "note": None})
        self.assertEqual(hidden["question"]["status"], "hidden")

    def test_speech_is_reserved(self):
        result = self.call("POST", "/speech/transcribe", status=409)
        self.assertEqual(result["error"]["code"], "conflict")
