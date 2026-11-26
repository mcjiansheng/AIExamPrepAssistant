import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from server.tests.v1.test_stage1 import DEVICE, SAMPLES, assert_sample_structure
from server.v1.app import create_app


class CourseContractTest(unittest.TestCase):
    def setUp(self):
        temp = self.enterContext(tempfile.TemporaryDirectory(prefix="fullgrid-course-test-"))
        self.app = create_app(data_dir=Path(temp), mock_model=True, sms_mode="dev")
        self.client = self.enterContext(TestClient(self.app))

    def api(self, method, path, token=None, **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return self.client.request(method, f"/api/v1{path}", headers=headers, **kwargs)

    def login(self, phone="13900000001"):
        response = self.api("POST", "/auth/huawei", json={"auth_code": f"dev-{phone}", "device": DEVICE})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["access_token"]

    def sample(self, value, filename):
        sample = json.loads((SAMPLES / filename).read_text(encoding="utf-8"))
        assert_sample_structure(self, value, sample)

    def test_each_guest_gets_a_private_sample_with_pages_and_knowledge(self):
        guest = self.api("POST", "/auth/guest", json={"device": DEVICE}).json()
        token = guest["access_token"]
        response = self.api("GET", "/courses", token)
        self.assertEqual(response.status_code, 200, response.text)
        self.sample(response.json(), "GET-courses.json")
        sample, = response.json()
        cid = sample["id"]
        self.assertTrue(sample["sample"])
        self.assertGreater(sample["counts"]["kps"], 0)
        self.assertEqual(self.api("GET", f"/courses/{cid}", self.login()).status_code, 404)
        self.assertEqual(self.api("POST", "/courses", token, json={"name": "访客课程"}).status_code, 403)

        course_map = self.api("GET", f"/courses/{cid}/map", token).json()
        self.assertTrue(course_map["chapters"])
        knowledge = course_map["chapters"][0]["kps"][0]
        kp_response = self.api("GET", f"/kps/{knowledge['id']}", token)
        self.assertEqual(kp_response.status_code, 200, kp_response.text)
        kp = kp_response.json()
        self.assertEqual(kp["state"], "new")
        self.assertTrue(kp["sections"])
        ref = kp["pages"][0]
        page = self.api("GET", f"/materials/{ref['material_id']}/pages/{ref['page']}", token)
        self.assertEqual(page.status_code, 200, page.text)
        self.assertTrue(page.json()["text"])
        self.assertIn(knowledge["id"], [point["id"] for point in page.json()["kps"]])

    def test_demo_courses_are_relative_to_today_and_seed_only_once(self):
        token = self.login("13800000000")
        courses = self.api("GET", "/courses", token).json()
        self.assertEqual([course["name"] for course in courses], ["高等数学", "操作系统", "数据结构"])
        today = datetime.now(ZoneInfo(DEVICE["timezone"])).date()
        self.assertEqual([(date.fromisoformat(item["exam_date"]) - today).days for item in courses], [3, 6, 13])
        self.assertEqual([course["readiness"] for course in courses], [
            {"mastered": 0, "total": 5}, {"mastered": 2, "total": 7}, {"mastered": 0, "total": 11},
        ])
        cid = courses[1]["id"]
        home = self.api("GET", f"/courses/{cid}/home", token).json()
        self.assertEqual(home["course"], courses[1])
        self.assertIn("银行家算法", [point["title"] for chapter in home["map"]["chapters"] for point in chapter["kps"]])
        self.assertTrue(home["last_session"])
        token_again = self.login("13800000000")
        self.assertEqual(self.api("GET", "/courses", token_again).json(), courses)

    def test_course_creation_is_idempotent_owned_and_reversible(self):
        token = self.login()
        request = {"json": {"name": "测试课程"}, "headers": {"Idempotency-Key": "create-a-course"}}
        first = self.api("POST", "/courses", token, **request)
        later = self.api("POST", "/courses", token, **request)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), later.json())
        self.assertEqual(len(self.api("GET", "/courses", token).json()), 2)
        cid = first.json()["id"]
        other = self.login("13900000002")
        self.assertEqual(self.api("GET", f"/courses/{cid}/home", other).status_code, 404)
        response = self.api("PATCH", f"/courses/{cid}", token, json={"name": "已改名称", "daily_cap_min": 60})
        self.assertEqual(response.status_code, 200, response.text)
        change = response.json()
        self.assertEqual(change["result"]["name"], "已改名称")
        self.assertTrue(change["undo"])
        self.assertEqual(self.api("POST", f"/undo/{change['undo']['id']}", token).status_code, 200)
        self.assertEqual(self.api("GET", f"/courses/{cid}", token).json(), first.json())
        self.assertEqual(self.api("DELETE", f"/courses/{cid}", token).status_code, 204)
        self.assertEqual(self.api("GET", f"/courses/{cid}", token).status_code, 404)

    def test_course_format_material_kind_and_focus_changes_can_be_undone(self):
        token = self.login()
        course, = self.api("GET", "/courses", token).json()
        cid = course["id"]
        fmt_path = f"/courses/{cid}/exam-format"
        before = self.api("GET", fmt_path, token).json()
        self.sample(before, "GET-courses-id-exam-format.json")
        request = {key: value for key, value in before.items() if key != "basis"}
        request["open_book"] = not before["open_book"]
        change = self.api("PUT", fmt_path, token, json=request).json()
        self.assertEqual(change["result"]["basis"], "user")
        self.assertEqual(self.api("POST", f"/undo/{change['undo']['id']}", token).status_code, 200)
        self.assertEqual(self.api("GET", fmt_path, token).json(), before)

        materials = self.api("GET", f"/courses/{cid}/materials", token).json()
        self.sample(materials, "GET-courses-id-materials.json")
        mid = materials[0]["id"]
        change = self.api("PATCH", f"/materials/{mid}", token, json={"kind": "notes"}).json()
        self.assertEqual(change["result"]["kind"], "notes")
        self.assertEqual(self.api("POST", f"/undo/{change['undo']['id']}", token).status_code, 200)
        self.assertEqual(self.api("GET", f"/courses/{cid}/materials", token).json(), materials)

        response = self.api("POST", f"/courses/{cid}/focus/fragments", token, json={"text": "新的重点。"})
        self.assertEqual(response.status_code, 200, response.text)
        focus = response.json()
        self.assertEqual(focus["job"]["status"], "queued")
        fragment = next(item for item in focus["fragments"] if item["text"] == "新的重点。")
        change = self.api("DELETE", f"/focus/fragments/{fragment['id']}", token).json()
        self.assertEqual(self.api("POST", f"/undo/{change['undo']['id']}", token).status_code, 200)
        restored = self.api("GET", f"/courses/{cid}/focus", token).json()
        self.assertIn(fragment, restored["fragments"])
