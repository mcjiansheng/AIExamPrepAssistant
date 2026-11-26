"""Account and infrastructure behavior required by API v1.1."""

import hashlib
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from server.v1.app import create_app


SAMPLES = Path(__file__).resolve().parents[3] / "docs" / "接口合同" / "samples-v1"
DEVICE = {"kind": "browser", "name": "测试浏览器", "timezone": "America/Los_Angeles"}
NULLABLE_USER_FIELDS = {
    f"{prefix}.{field}"
    for prefix in ("response", "response.user")
    for field in ("avatar_url", "school", "major", "phone_masked", "deletion_at", "onboarding.ai", "onboarding.course")
}


def assert_sample_structure(case, actual, sample, path="response"):
    """Compare populated sample fields while allowing nullable/empty variants."""
    if sample is None or (actual is None and path in NULLABLE_USER_FIELDS):
        return
    if isinstance(sample, dict):
        case.assertIsInstance(actual, dict, path)
        required = {key for key, value in sample.items() if value is not None}
        case.assertTrue(required <= actual.keys(), f"{path}: missing {required - actual.keys()}")
        case.assertFalse(actual.keys() - sample.keys(), f"{path}: extra fields")
        for key in actual.keys() & sample.keys():
            assert_sample_structure(case, actual[key], sample[key], f"{path}.{key}")
        return
    if isinstance(sample, list):
        case.assertIsInstance(actual, list, path)
        if not sample:
            return
        for index, item in enumerate(actual):
            candidates = sample
            if isinstance(item, dict):
                for discriminator in ("kind", "type"):
                    matches = [value for value in sample if isinstance(value, dict)
                               and value.get(discriminator) == item.get(discriminator)
                               and discriminator in item]
                    if matches:
                        candidates = matches
                        break
            errors = []
            for candidate in candidates:
                try:
                    assert_sample_structure(case, item, candidate, f"{path}[{index}]")
                    break
                except AssertionError as error:
                    errors.append(str(error))
            else:
                case.fail(errors[0])
        return
    if isinstance(sample, bool):
        case.assertIs(type(actual), bool, path)
    elif isinstance(sample, (int, float)):
        case.assertIsInstance(actual, (int, float), path)
        case.assertNotIsInstance(actual, bool, path)
    else:
        case.assertIsInstance(actual, type(sample), path)


class StageOneTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fullgrid-v1-test-")
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name)
        self.app = create_app(data_dir=self.data_dir, mock_model=True, sms_mode="dev")
        self.client = self.enterContext(TestClient(self.app))

    def request(self, method, path, token=None, **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return self.client.request(method, f"/api/v1{path}", headers=headers, **kwargs)

    def error(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        body = response.json()
        self.assertEqual(set(body), {"error"})
        self.assertEqual(body["error"]["code"], code)
        self.assertIsInstance(body["error"]["message"], str)
        self.assertTrue(body["error"]["message"])
        self.assertTrue({"code", "message"} <= body["error"].keys())
        self.assertFalse(set(body["error"]) - {"code", "message", "hint", "detail"})
        return body["error"]

    def sample(self, actual, name):
        sample = json.loads((SAMPLES / name).read_text(encoding="utf-8"))
        assert_sample_structure(self, actual, sample)

    def login(self, phone="13900000001", name="测试浏览器"):
        sms = self.request("POST", "/auth/sms", json={"phone": phone})
        self.assertEqual(sms.status_code, 200, sms.text)
        body = sms.json()
        self.assertEqual(body["cooldown_sec"], 60)
        self.assertRegex(body["dev_code"], r"^\d{6}$")
        self.sample(body, "POST-auth-sms.json")
        response = self.request("POST", "/auth/login", json={
            "phone": phone, "code": body["dev_code"],
            "device": {**DEVICE, "name": name},
        })
        self.assertEqual(response.status_code, 200, response.text)
        tokens = response.json()
        self.sample(tokens, "POST-auth-login.json")
        self.assertEqual(tokens["expires_in"], 900)
        return tokens

    @contextmanager
    def database(self):
        with closing(sqlite3.connect(self.data_dir / "v1.sqlite")) as conn, conn:
            conn.row_factory = sqlite3.Row
            yield conn

    def test_health_and_authenticated_boundaries(self):
        response = self.request("GET", "/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.sample(body, "GET-health.json")
        self.assertTrue(body["ok"])
        self.assertEqual(body["version"], "1.0")
        self.assertEqual(body["sms"], "dev")
        self.assertFalse(body["capabilities"]["speech"])
        self.assertTrue(response.headers["X-Request-ID"])
        for path in ("/me", "/me/settings", "/me/reminders", "/me/memory",
                     "/me/devices", "/notifications", "/jobs/missing", "/events"):
            with self.subTest(path=path):
                self.error(self.request("GET", path), 401, "unauthorized")

    def test_internal_error_has_request_id_and_diagnostic(self):
        @self.app.post("/api/v1/test-error")
        def broken():
            with self.app.state.db.transaction() as conn:
                conn.execute("SELECT * FROM missing_test_table")

        with self.assertLogs("fullgrid.http", level="INFO") as logs:
            response = self.request("POST", "/test-error")
        self.error(response, 500, "internal")
        self.assertNotIn("missing_test_table", response.text)
        self.assertIn("no such table: missing_test_table", logs.records[0].message)
        for record in logs.records:
            self.assertEqual(json.loads(record.message)["request_id"], response.headers["X-Request-ID"])

    def test_signup_profile_timezone_settings_reminders_and_feedback(self):
        tokens = self.login()
        self.assertTrue(tokens["is_new"])
        access = tokens["access_token"]
        response = self.request("PATCH", "/me", access, json={
            "nickname": "小林", "school": "测试大学", "major": "计算机",
            "timezone": "Asia/Shanghai", "onboarding": {"ai": "skipped", "course": "done"},
        })
        self.assertEqual(response.status_code, 200, response.text)
        profile = response.json()
        self.sample(profile, "GET-me.json")
        self.assertEqual(profile["nickname"], "小林")
        self.assertEqual(profile["timezone"], "Asia/Shanghai")
        self.assertEqual(profile["onboarding"], {"ai": "skipped", "course": "done"})
        self.assertEqual(datetime.fromisoformat(profile["created_at"]).utcoffset(), timedelta(hours=8))
        self.assertEqual(self.request("GET", "/me", access).json(), profile)
        settings = self.request("GET", "/me/settings", access).json()
        self.sample(settings, "GET-me-settings.json")
        self.assertEqual(settings["daily_minutes"], 120)
        reminders = {"daily": {"enabled": False, "time": "21:30"}, "exam_soon": False, "jobs": True}
        response = self.request("PUT", "/me/reminders", access, json=reminders)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), reminders)
        self.assertEqual(self.request("GET", "/me/reminders", access).json(), reminders)
        stats = self.request("GET", "/me/stats", access)
        self.assertEqual(stats.status_code, 200, stats.text)
        self.assertEqual(set(stats.json()), {"week_minutes", "streak_days"})
        self.assertEqual(self.request("GET", "/me/memory", access).json(), [])
        self.assertEqual(self.request("DELETE", "/me/memory", access).status_code, 204)
        response = self.request("POST", "/feedback", access, json={
            "kind": "idea", "text": "加一个快捷入口", "context": "/me",
        })
        self.assertEqual(response.status_code, 204, response.text)
        self.assertEqual(response.content, b"")

    def test_request_body_errors_are_contract_errors(self):
        tokens = self.login()
        for path, method, body in (
            ("/me/settings", "PATCH", {"daily_minutes": 29}),
            ("/me/settings", "PATCH", {"daily_minutes": 601}),
            ("/me/settings", "PATCH", {"daily_minutes": "120"}),
            ("/me/settings", "PATCH", {"intensity": "extreme"}),
            ("/me/settings", "PATCH", {"memory": "false"}),
            ("/me", "PATCH", {"timezone": "Invalid/Zone"}),
            ("/me/reminders", "PUT", {"daily": {"enabled": True, "time": "25:61"}, "exam_soon": True, "jobs": True}),
            ("/feedback", "POST", {"kind": "unknown", "text": "内容", "context": None}),
        ):
            with self.subTest(path=path, body=body):
                self.error(self.request(method, path, tokens["access_token"], json=body), 400, "bad_request")
        self.error(self.request("POST", "/auth/login", json={"phone": "13900000002"}), 400, "bad_request")

    def test_guest_tokens_and_member_writes(self):
        response = self.request("POST", "/auth/guest", json={"device": DEVICE})
        self.assertEqual(response.status_code, 200, response.text)
        tokens = response.json()
        self.assertTrue(tokens["user"]["guest"])
        self.assertIsNone(tokens["user"]["phone_masked"])
        me = self.request("GET", "/me", tokens["access_token"])
        self.assertEqual(me.status_code, 200, me.text)
        self.assertTrue(me.json()["guest"])
        self.error(self.request("PATCH", "/me", tokens["access_token"], json={"nickname": "自己的名字"}),
                   403, "login_required")

    def test_huawei_development_identity_and_same_phone(self):
        first = self.login()
        response = self.request("POST", "/auth/huawei", json={
            "auth_code": "dev-13900000001", "device": {**DEVICE, "name": "手机"},
        })
        self.assertEqual(response.status_code, 200, response.text)
        second = response.json()
        self.assertEqual(second["user"]["id"], first["user"]["id"])
        self.assertFalse(second["is_new"])
        self.error(self.request("POST", "/auth/huawei", json={"auth_code": "bad", "device": DEVICE}),
                   400, "bad_request")

    def test_sms_cooldown_and_wrong_code_lock(self):
        phone = "13900000003"
        sms = self.request("POST", "/auth/sms", json={"phone": phone}).json()
        rate = self.error(self.request("POST", "/auth/sms", json={"phone": phone}), 429, "rate_limited")
        self.assertGreater(rate["detail"]["retry_after_sec"], 0)
        self.assertLessEqual(rate["detail"]["retry_after_sec"], 60)
        wrong = "000000" if sms["dev_code"] != "000000" else "999999"
        for remaining in range(4, -1, -1):
            response = self.request("POST", "/auth/login", json={"phone": phone, "code": wrong, "device": DEVICE})
            error = self.error(response, 400, "bad_request")
            if remaining:
                self.assertIn(str(remaining), error["message"])
        error = self.error(self.request("POST", "/auth/login", json={
            "phone": phone, "code": sms["dev_code"], "device": DEVICE,
        }), 429, "rate_limited")
        self.assertGreater(error["detail"]["retry_after_sec"], 0)
        self.assertLessEqual(error["detail"]["retry_after_sec"], 600)

    def test_access_expiration_refresh_rotation_and_replay(self):
        tokens = self.login()
        old_access = tokens["access_token"]
        with self.database() as conn:
            conn.execute("UPDATE auth_tokens SET expires_at=? WHERE token_hash=?", (
                (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),
                hashlib.sha256(old_access.encode()).hexdigest(),
            ))
        self.error(self.request("GET", "/me", old_access), 401, "unauthorized")
        response = self.request("POST", "/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
        self.assertEqual(response.status_code, 200, response.text)
        fresh = response.json()
        self.assertNotEqual(fresh["access_token"], old_access)
        self.assertNotEqual(fresh["refresh_token"], tokens["refresh_token"])
        self.assertEqual(self.request("GET", "/me", fresh["access_token"]).status_code, 200)
        replay = self.request("POST", "/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
        self.error(replay, 401, "unauthorized")
        self.error(self.request("GET", "/me", fresh["access_token"]), 401, "unauthorized")
        self.error(self.request("POST", "/auth/refresh", json={"refresh_token": fresh["refresh_token"]}),
                   401, "unauthorized")

    def test_tokens_are_only_stored_as_hashes(self):
        tokens = self.login()
        with self.database() as conn:
            contents = "\n".join(conn.iterdump())
        for name in ("access_token", "refresh_token"):
            self.assertNotIn(tokens[name], contents)
            self.assertIn(hashlib.sha256(tokens[name].encode()).hexdigest(), contents)

    def test_device_ownership_removal_and_logout(self):
        a = self.login()
        b = self.login("13900000002")
        a_device = self.request("GET", "/me/devices", a["access_token"]).json()
        self.assertEqual(len(a_device), 1)
        self.assertEqual(set(a_device[0]), {"id", "kind", "name", "last_seen", "current"})
        self.assertTrue(a_device[0]["current"])
        self.error(self.request("DELETE", f"/me/devices/{a_device[0]['id']}", b["access_token"]), 404, "not_found")
        self.assertEqual(self.request("DELETE", f"/me/devices/{a_device[0]['id']}", a["access_token"]).status_code, 204)
        self.error(self.request("GET", "/me", a["access_token"]), 401, "unauthorized")
        self.assertEqual(self.request("GET", "/me", b["access_token"]).status_code, 200)
        self.assertEqual(self.request("POST", "/auth/logout", b["access_token"]).status_code, 204)
        self.error(self.request("POST", "/auth/refresh", json={"refresh_token": b["refresh_token"]}),
                   401, "unauthorized")

    def test_qr_requires_phone_confirmation_and_delivers_tokens_once(self):
        phone = self.login()
        ticket_response = self.request("POST", "/auth/qr", json={"device": {**DEVICE, "name": "扫码电脑"}})
        self.assertEqual(ticket_response.status_code, 200, ticket_response.text)
        ticket = ticket_response.json()
        self.assertEqual(set(ticket), {"id", "payload", "expires_at"})
        scan_id = parse_qs(urlparse(ticket["payload"]).query)["qr"][0]
        self.assertNotEqual(scan_id, ticket["id"])
        poll = f"/auth/qr/{ticket['id']}"
        self.assertEqual(self.request("GET", poll).json(), {"status": "waiting", "tokens": None})
        self.error(self.request("POST", f"/auth/qr/{scan_id}/scan"), 401, "unauthorized")
        scan = self.request("POST", f"/auth/qr/{scan_id}/scan", phone["access_token"])
        self.assertEqual(scan.status_code, 200, scan.text)
        self.assertEqual(scan.json(), {"device_name": "扫码电脑"})
        self.assertEqual(self.request("GET", poll).json(), {"status": "scanned", "tokens": None})
        confirm = self.request("POST", f"/auth/qr/{scan_id}/confirm", phone["access_token"])
        self.assertEqual(confirm.status_code, 200, confirm.text)
        self.assertEqual(confirm.json(), {"ok": True})
        confirmed = self.request("GET", poll).json()
        self.assertEqual(confirmed["status"], "confirmed")
        self.assertEqual(confirmed["tokens"]["user"]["id"], phone["user"]["id"])
        self.assertEqual(self.request("GET", "/me", confirmed["tokens"]["access_token"]).status_code, 200)
        repeated = self.request("GET", poll)
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertIsNone(repeated.json()["tokens"])

    def test_settings_undo_restores_state_and_invalidates_after_a_write(self):
        access = self.login()["access_token"]
        before = self.request("GET", "/me/settings", access).json()
        changed = self.request("PATCH", "/me/settings", access, json={"daily_minutes": 60, "intensity": "sprint"})
        self.assertEqual(changed.status_code, 200, changed.text)
        body = changed.json()
        self.assertEqual(set(body), {"result", "affects", "undo"})
        self.assertTrue({"settings", "today", "schedule"} <= set(body["affects"]))
        self.assertEqual(body["result"]["daily_minutes"], 60)
        self.assertEqual(set(body["undo"]), {"id", "label", "expires_at"})
        undo_path = f"/undo/{body['undo']['id']}"
        undone = self.request("POST", undo_path, access)
        self.assertEqual(undone.status_code, 200, undone.text)
        self.assertEqual(set(undone.json()), {"ok", "affects", "summary"})
        self.assertTrue(undone.json()["ok"])
        self.assertEqual(self.request("GET", "/me/settings", access).json(), before)
        self.error(self.request("POST", undo_path, access), 409, "conflict")
        first = self.request("PATCH", "/me/settings", access, json={"daily_minutes": 60}).json()
        second = self.request("PATCH", "/me/settings", access, json={"daily_minutes": 90})
        self.assertEqual(second.status_code, 200, second.text)
        self.error(self.request("POST", f"/undo/{first['undo']['id']}", access), 409, "conflict")
        self.assertEqual(self.request("GET", "/me/settings", access).json()["daily_minutes"], 90)

    def test_undo_and_resource_ids_are_scoped_to_the_user(self):
        a = self.login()["access_token"]
        b = self.login("13900000002")["access_token"]
        change = self.request("PATCH", "/me/settings", a, json={"theme": "dark"}).json()
        self.error(self.request("POST", f"/undo/{change['undo']['id']}", b), 404, "not_found")
        self.assertEqual(self.request("POST", f"/undo/{change['undo']['id']}", a).status_code, 200)
        for method, path in (("GET", "/jobs/missing"), ("POST", "/jobs/missing/retry"),
                             ("POST", "/jobs/missing/continue"), ("DELETE", "/me/memory/missing")):
            with self.subTest(path=path):
                self.error(self.request(method, path, b), 404, "not_found")

    def test_idempotency_saves_one_feedback_per_user_and_key(self):
        a = self.login()["access_token"]
        b = self.login("13900000002")["access_token"]
        body = {"kind": "bug", "text": "同一次提交", "context": None}
        headers = {"Idempotency-Key": "feedback-one-operation"}
        first = self.request("POST", "/feedback", a, headers=headers, json=body)
        second = self.request("POST", "/feedback", a, headers=headers, json=body)
        self.assertEqual(first.status_code, 204, first.text)
        self.assertEqual(second.status_code, first.status_code)
        self.assertEqual(second.content, first.content)
        with self.database() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM feedback").fetchone()[0], 1)
        third = self.request("POST", "/feedback", b, headers=headers, json=body)
        self.assertEqual(third.status_code, 204, third.text)
        with self.database() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM feedback").fetchone()[0], 2)

    def test_notification_list_and_mark_all(self):
        access = self.login()["access_token"]
        response = self.request("GET", "/notifications", access)
        self.assertEqual(response.status_code, 200, response.text)
        self.sample(response.json(), "GET-notifications.json")
        items = response.json()["items"]
        unread = response.json()["unread"]
        self.assertEqual(unread, sum(not item["read"] for item in items))
        response = self.request("POST", "/notifications/read", access, json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"unread": 0})
        self.assertEqual(self.request("GET", "/notifications", access).json()["unread"], 0)

    def test_owned_memory_notifications_jobs_and_learning_position(self):
        a = self.login()
        b = self.login("13900000002")
        stamp = datetime.now(timezone.utc).isoformat()
        with self.database() as conn:
            conn.execute("INSERT INTO courses(id,user_id,name) VALUES(?,?,?)", ("course_a", a["user"]["id"], "演示课程"))
            conn.execute("INSERT INTO knowledge_points(id,user_id,course_id,title) VALUES(?,?,?,?)",
                         ("kp_a", a["user"]["id"], "course_a", "演示知识点"))
            conn.execute("INSERT INTO practice_sessions(id,user_id,course_id,title) VALUES(?,?,?,?)",
                         ("session_a", a["user"]["id"], "course_a", "演示练习"))
            conn.execute("INSERT INTO memory_items(id,user_id,text,source,created_at) VALUES(?,?,?,?,?)",
                         ("memory_a", a["user"]["id"], "讲解先给例子", "user", stamp))
            conn.execute("INSERT INTO notifications(id,user_id,kind,title,created_at) VALUES(?,?,?,?,?)",
                         ("notice_a", a["user"]["id"], "job_done", "整理好了", stamp))
            conn.execute("INSERT INTO jobs(id,user_id,kind,status,target_id,created_at) VALUES(?,?,?,?,?,?)",
                         ("job_a", a["user"]["id"], "ingest", "done", "course_a", stamp))
        memories = self.request("GET", "/me/memory", a["access_token"]).json()
        self.assertEqual(len(memories), 1)
        self.assertEqual(set(memories[0]), {"id", "text", "source", "created_at"})
        self.assertEqual(self.request("GET", "/me/memory", b["access_token"]).json(), [])
        self.error(self.request("DELETE", "/me/memory/memory_a", b["access_token"]), 404, "not_found")
        self.error(self.request("POST", "/notifications/read", b["access_token"], json={"ids": ["notice_a"]}),
                   404, "not_found")
        self.assertEqual(self.request("POST", "/notifications/read", a["access_token"],
                                      json={"ids": ["notice_a"]}).json()["unread"], 0)
        self.error(self.request("GET", "/jobs/job_a", b["access_token"]), 404, "not_found")
        self.error(self.request("POST", "/jobs/job_a/retry", b["access_token"]), 404, "not_found")
        self.error(self.request("POST", "/jobs/job_a/continue", b["access_token"]), 404, "not_found")
        job = self.request("GET", "/jobs/job_a", a["access_token"])
        self.assertEqual(job.status_code, 200, job.text)
        self.assertEqual(set(job.json()), {"id", "kind", "status", "progress", "stage", "error", "course_id",
                                           "target_id", "result", "estimate", "created_at"})
        self.error(self.request("POST", "/jobs/job_a/continue", a["access_token"]), 409, "conflict")
        with self.database() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'failed', progress = 0.5, error = ? WHERE id = ?",
                (json.dumps({"message": "暂时未完成", "retryable": True}), "job_a"),
            )
        retried = self.request("POST", "/jobs/job_a/retry", a["access_token"])
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertEqual(retried.json()["status"], "queued")
        self.assertEqual(retried.json()["progress"], 0.5)
        with self.database() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'needs_input', course_id = ?, estimate = ? WHERE id = ?",
                ("course_a", json.dumps({"tokens_min": 18_000, "tokens_max": 42_000, "cost_min": None,
                                        "cost_max": None, "needs_confirm": True}), "job_a"),
            )
        continued = self.request("POST", "/jobs/job_a/continue", a["access_token"])
        self.assertEqual(continued.status_code, 200, continued.text)
        self.sample(continued.json(), "POST-jobs-id-continue.json")
        self.assertEqual(continued.json()["status"], "queued")
        self.assertIsNone(continued.json()["estimate"])
        self.error(self.request("POST", "/jobs/job_a/continue", a["access_token"]), 409, "conflict")
        for kind, target in (("kp", {"kp_id": "kp_a"}), ("session", {"session_id": "session_a", "position": 2})):
            body = {"kind": kind, "course_id": "course_a", **target}
            with self.subTest(kind=kind):
                response = self.request("PUT", "/me/resume", a["access_token"], json=body)
                self.assertEqual(response.status_code, 204, response.text)
                self.error(self.request("PUT", "/me/resume", b["access_token"], json=body), 404, "not_found")
        self.assertEqual(self.request("DELETE", "/me/memory/memory_a", a["access_token"]).status_code, 204)
        self.assertEqual(self.request("GET", "/me/memory", a["access_token"]).json(), [])


if __name__ == "__main__":
    unittest.main()
