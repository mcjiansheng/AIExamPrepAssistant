import io
import tempfile
import time
import unittest
import zipfile
from datetime import timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from server.tests.v1.test_stage1 import DEVICE
from server.v1 import account_lifecycle
from server.v1.app import create_app
from server.v1.auth import Principal
from server.v1.db import utc_now


class AccountLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="fullgrid-lifecycle-")))
        self.app = create_app(data_dir=self.directory, mock_model=True, sms_mode="dev", worker_enabled=False)
        self.client = self.enterContext(TestClient(self.app))

    def api(self, method, path, token=None, *, status=200, **kwargs):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = self.client.request(method, "/api/v1" + path, headers=headers, **kwargs)
        self.assertEqual(response.status_code, status, response.text if response.status_code != 200 else "")
        return response.json() if response.content else None

    def member(self, phone="13900000811"):
        return self.api("POST", "/auth/huawei", json={"auth_code": f"dev-{phone}", "device": DEVICE})

    def principal(self, token):
        profile = self.api("GET", "/me", token)
        return Principal(profile["id"], "", profile["timezone"], profile["guest"])

    def test_export_contains_only_owner_data_and_no_credentials(self):
        owner = self.member()
        token = owner["access_token"]
        other = self.member("13900000812")
        first = self.api("GET", "/courses", token)[0]
        self.api("PATCH", f"/courses/{first['id']}", token, json={"name": "仅属于导出者"})
        self.api("PATCH", "/me", other["access_token"], json={"nickname": "另一个用户独有名字"})
        self.api("POST", "/me/providers", token, json={"preset_id": "longcat", "key": "secret-export-must-exclude-9281"})
        uploaded = self.api("POST", f"/courses/{first['id']}/materials", token, data={"source": "file"},
                            files=[("files", ("owned.txt", b"synthetic original", "text/plain"))])
        # Idempotent export creates a single job even when the request is repeated.
        headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": "export-once"}
        received = self.client.post("/api/v1/me/export", headers=headers)
        self.assertEqual(received.status_code, 200)
        job = received.json()
        self.assertEqual(self.client.post("/api/v1/me/export", headers=headers).json(), job)
        user = self.principal(token)
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute("UPDATE jobs SET status='running' WHERE id=?", (job["id"],))
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job["id"],)).fetchone()
        account_lifecycle.run_export(self.app, user, row, {})
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute("UPDATE jobs SET status='done' WHERE id=?", (job["id"],))
        self.api("GET", f"/jobs/{job['id']}", other["access_token"], status=404)
        ready = self.api("GET", f"/jobs/{job['id']}", token)
        response = self.client.get(ready["result"]["url"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            data = archive.read("data.json").decode()
            self.assertIn("仅属于导出者", data)
            self.assertNotIn("另一个用户独有名字", data)
            self.assertNotIn("secret-export-must-exclude", data)
            self.assertNotIn("key_ciphertext", data)
            self.assertNotIn(owner["refresh_token"], data)
            name = f"materials/{uploaded['materials'][0]['id']}/owned.txt"
            self.assertEqual(archive.read(name), b"synthetic original")
        self.assertEqual(self.client.get(f"/api/v1/exports/{job['id']}?token=wrong").status_code, 404)
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute("UPDATE data_exports SET expires_at=? WHERE job_id=?",
                         ((utc_now() - timedelta(seconds=1)).isoformat(), job["id"]))
        self.assertEqual(self.client.get(ready["result"]["url"]).status_code, 404)
        account_lifecycle.cleanup_exports(self.app, utc_now())
        self.assertFalse(account_lifecycle.export_path(self.app, user.id, job["id"]).exists())

    def test_export_completes_through_worker(self):
        app = create_app(data_dir=self.directory / "worker", mock_model=True, sms_mode="dev")
        with TestClient(app) as client:
            signed_in = client.post("/api/v1/auth/huawei", json={"auth_code": "dev-13900000815", "device": DEVICE}).json()
            headers = {"Authorization": f"Bearer {signed_in['access_token']}"}
            job = client.post("/api/v1/me/export", headers=headers).json()
            until = time.monotonic() + 5
            while time.monotonic() < until:
                job = client.get(f"/api/v1/jobs/{job['id']}", headers=headers).json()
                if job["status"] in {"done", "failed"}:
                    break
                time.sleep(0.025)
            self.assertEqual(job["status"], "done", job)
            response = client.get(job["result"]["url"])
            self.assertEqual(response.status_code, 200)
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                self.assertIn("data.json", archive.namelist())

    def test_cooling_period_restore_and_login_after_deadline(self):
        signed_in = self.member()
        token = signed_in["access_token"]
        uid = signed_in["user"]["id"]
        deletion = self.api("DELETE", "/me", token)["deletion_at"]
        self.assertEqual(self.api("DELETE", "/me", token)["deletion_at"], deletion)
        self.assertIsNone(self.api("POST", "/me/restore", token)["deletion_at"])
        self.api("DELETE", "/me", token)
        logged_in = self.member()
        self.assertFalse(logged_in["is_new"])
        self.assertIsNone(logged_in["user"]["deletion_at"])
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute("UPDATE users SET deletion_at=? WHERE id=?",
                         ((utc_now() - timedelta(seconds=1)).isoformat(), uid))
        self.api("GET", "/me", token, status=401)
        self.api("POST", "/auth/refresh", json={"refresh_token": logged_in["refresh_token"]}, status=401)
        renewed = self.member()
        self.assertTrue(renewed["is_new"])
        self.assertNotEqual(renewed["user"]["id"], uid)

    def test_purge_removes_files_keys_and_keeps_other_users(self):
        owner = self.member()
        token = owner["access_token"]
        other = self.member("13900000813")
        uid = owner["user"]["id"]
        self.api("POST", "/me/providers", token, json={"preset_id": "longcat", "key": "cleanup-test-7755"})
        base = account_lifecycle.root(self.app)
        for name in ("files", "renders", "exports", "plugins"):
            path = base / name / uid
            path.mkdir(parents=True)
            (path / "synthetic.txt").write_text("synthetic")
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute("UPDATE users SET deletion_at=? WHERE id=?", ((utc_now() - timedelta(seconds=1)).isoformat(), uid))
        account_lifecycle.cleanup_users(self.app, utc_now())
        with self.app.state.db.transaction() as conn:
            for table in ("users", "provider_connections", "model_user_keys", "model_usage", "courses"):
                key = "id" if table == "users" else "user_id"
                self.assertEqual(conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {key}=?", (uid,)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM account_file_garbage WHERE user_id=?", (uid,)).fetchone()[0], 0)
        for name in ("files", "renders", "exports", "plugins"):
            self.assertFalse((base / name / uid).exists())
        self.api("GET", "/me", other["access_token"])

    def test_guest_expiry_and_reminder_deduplication(self):
        guest = self.api("POST", "/auth/guest", json={"device": DEVICE})
        uid = guest["user"]["id"]
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute("UPDATE users SET last_active=? WHERE id=?", ((utc_now() - timedelta(days=31)).isoformat(), uid))
        account_lifecycle.cleanup_users(self.app, utc_now())
        with self.app.state.db.transaction() as conn:
            self.assertIsNone(conn.execute("SELECT id FROM users WHERE id=?", (uid,)).fetchone())
        token = self.member()["access_token"]
        cid = self.api("GET", "/courses", token)[0]["id"]
        now = utc_now()
        local = now.astimezone(account_lifecycle.ZoneInfo("America/Los_Angeles"))
        on = local.date()
        self.api("PUT", "/me/reminders", token,
                 json={"daily": {"enabled": True, "time": "00:00"}, "exam_soon": True, "jobs": True})
        self.api("PATCH", f"/courses/{cid}", token, json={"exam_date": str(on + timedelta(days=3))})
        account_lifecycle.send_reminders(self.app, now)
        account_lifecycle.send_reminders(self.app, now)
        notifications = self.api("GET", "/notifications", token)["items"]
        self.assertEqual(sum(item["kind"] == "daily" for item in notifications), 1)
        self.assertEqual(sum(item["kind"] == "exam_soon" for item in notifications), 1)
        self.api("PUT", "/me/reminders", token,
                 json={"daily": {"enabled": False, "time": "00:00"}, "exam_soon": False, "jobs": False})
        count = len(notifications)
        account_lifecycle.send_reminders(self.app, now + timedelta(days=2))
        self.assertEqual(len(self.api("GET", "/notifications", token)["items"]), count)


if __name__ == "__main__":
    unittest.main()
