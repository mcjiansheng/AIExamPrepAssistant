import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.tests.v1.test_stage1 import DEVICE
from server.v1 import plugins, plugin_runtime
from server.v1.app import create_app
from server.v1.auth import Principal
from server.v1.db import load

MCP_SERVER = '''import json,os,sys
for line in sys.stdin:
    request=json.loads(line)
    if "id" not in request:
        continue
    method=request["method"]
    if method=="initialize":
        result={"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1"}}
    elif method=="tools/list":
        result={"tools":[{"name":"ping","description":"ping","inputSchema":{"type":"object","properties":{}}}]}
    elif method=="tools/call":
        args=request.get("params",{}).get("arguments",{})
        ids=[item["course_id"] for item in args.get("fullgrid",{}).get("knowledge",[])]
        result={"content":[{"type":"text","text":json.dumps({"secret":os.environ.get("LONGCAT_API_KEY"),"ids":ids})}],"isError":False}
    else:
        result={}
    print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":result}),flush=True)
'''


def package(pid="plugin-test", *, permissions=None, mcp=False, extra=None, version="1.0"):
    manifest = {
        "id": pid, "name": "测试插件", "version": version, "description": "测试插件数据",
        "permissions": permissions or {"read": [], "write": [], "network": [], "model": False},
        "commands": [{"name": "ping", "description": "测试工具"}], "question_types": [],
    }
    if mcp:
        manifest["mcp"] = {"command": sys.executable, "args": ["server.py"]}
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("plugin.json", json.dumps(manifest))
        archive.writestr("SKILL.md", "# 测试技能\n处理当前课程。")
        if mcp:
            archive.writestr("server.py", MCP_SERVER)
        for name, value in (extra or {}).items():
            archive.writestr(name, value)
    return data.getvalue()


class PluginTest(unittest.TestCase):
    def setUp(self):
        path = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="fullgrid-plugin-test-")))
        self.app = create_app(data_dir=path, mock_model=True, sms_mode="dev", worker_enabled=False)
        self.client = self.enterContext(TestClient(self.app))
        self.token = self.login("13800000000")
        self.other = self.login("13900000188")
        user = self.api("GET", "/me", self.token)
        self.user = Principal(user["id"], "", user["timezone"], False)

    def api(self, method, path, token=None, status=200, **kwargs):
        response = self.client.request(method, "/api/v1" + path,
                                       headers={"Authorization": f"Bearer {token}"} if token else {}, **kwargs)
        self.assertEqual(response.status_code, status, response.text)
        return response.json() if response.content else None

    def login(self, phone):
        return self.api("POST", "/auth/huawei", json={"auth_code": f"dev-{phone}", "device": DEVICE})["access_token"]

    def upload(self, content, token=None, status=200):
        return self.api("POST", "/plugins", token or self.token, status,
                        files={"file": ("test.zip", content, "application/zip")})

    def test_builtin_catalog_has_one_working_plugin_and_supports_scope(self):
        rows = self.api("GET", "/plugins", self.token)
        self.assertEqual(len(rows), 5)
        self.assertEqual([row["id"] for row in rows if row["installed"]], ["compute-first"])
        self.assertIn("即将支持", self.api("GET", "/plugins/formula", self.token)["readme"])
        self.api("POST", "/plugins/formula/install", self.token, 409)
        cid = self.api("GET", "/courses", self.token)[0]["id"]
        self.api("PATCH", "/plugins/compute-first", self.token, json={"scope": "courses", "course_ids": [cid]})
        with self.app.state.db.transaction(write=True) as conn:
            self.assertEqual(plugins.summaries(conn, self.user, None), [])
            self.assertEqual(plugins.summaries(conn, self.user, cid)[0]["id"], "compute-first")
        result = plugins.invoke(self.app, self.user, "compute-first", "solve", {
            "code": "def solve():\n    return {'answer': 7*8, 'checks': {'product': 7*8}, 'tables': {}}",
        }, course_id=cid)
        self.assertEqual(result["text"], "56")
        self.api("DELETE", "/plugins/compute-first", self.token, 409)
        self.api("PATCH", "/plugins/compute-first", self.token, json={"enabled": False})
        with self.assertRaisesRegex(Exception, "还没有启用"):
            plugins.invoke(self.app, self.user, "compute-first", "solve", {}, course_id=cid)

    def test_upload_permission_upgrade_isolated_and_template_paths_checked(self):
        created = self.upload(package())
        self.assertFalse(created["installed"])
        self.assertFalse(created["granted"])
        self.api("GET", "/plugins/plugin-test", self.other, 404)
        self.api("POST", "/plugins/plugin-test/install", self.other, 404)
        self.api("PATCH", "/plugins/plugin-test", self.other, 404, json={"enabled": True})
        self.api("DELETE", "/plugins/plugin-test", self.other, 404)
        self.api("POST", "/plugins/plugin-test/install", self.token)
        upgraded = self.upload(package(permissions={"read": ["course.knowledge"], "write": [], "network": [], "model": False}, version="2"))
        self.assertFalse(upgraded["granted"])
        self.assertFalse(upgraded["enabled"])
        self.api("POST", "/plugins/plugin-test/install", self.token)
        self.api("DELETE", "/plugins/plugin-test", self.token, 204)
        self.api("GET", "/plugins/plugin-test", self.token, 404)
        self.upload(package(extra={"../../escaped.py": "bad"}), status=400)

    def test_mcp_receives_only_permitted_resources_and_no_inherited_key(self):
        cid = self.api("GET", "/courses", self.token)[0]["id"]
        self.upload(package(mcp=True, permissions={"read": ["course.knowledge"], "write": [], "network": [], "model": False}))
        self.api("POST", "/plugins/plugin-test/install", self.token)
        with patch.dict(os.environ, {"LONGCAT_API_KEY": "must-not-reach-plugin"}):
            response = plugins.invoke(self.app, self.user, "plugin-test", "ping", {}, course_id=cid)
        value = json.loads(response["text"])
        self.assertIsNone(value["secret"])
        self.assertTrue(value["ids"])
        self.assertEqual(set(value["ids"]), {cid})
        self.assertEqual(response["template"]["type"], "text")

    def test_mcp_timeout_is_retryable_and_process_failure_is_visible(self):
        content = package(mcp=True)
        memory = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(content)) as source, zipfile.ZipFile(memory, "w") as target:
            for entry in source.infolist():
                data = b"import time\ntime.sleep(5)\n" if entry.filename == "server.py" else source.read(entry)
                target.writestr(entry.filename, data)
        self.upload(memory.getvalue())
        self.api("POST", "/plugins/plugin-test/install", self.token)
        with patch.object(plugin_runtime, "CALL_TIMEOUT", 0.1):
            with self.assertRaises(plugins.PluginFailure) as failure:
                plugins.invoke(self.app, self.user, "plugin-test", "ping", {})
        self.assertTrue(failure.exception.retryable)
        self.assertIn("没有响应", str(failure.exception))
        self.assertEqual(list((self.app.state.data_dir / "v1" / "plugins" / self.user.id).iterdir()), [])

    def test_compute_draft_reuses_checkpoint_and_records_plugin_usage(self):
        from server.v1.generation import spec_for
        from server.v1.model_runtime import role_model
        cid = self.api("GET", "/courses", self.token)[0]["id"]
        with self.app.state.db.transaction() as conn:
            kid = conn.execute("SELECT id FROM active_knowledge_points WHERE course_id=? ORDER BY position LIMIT 1", (cid,)).fetchone()[0]
            spec = spec_for(conn, self.user, {"kp_id": kid, "type": "calc", "score": 10, "position": 0})
        model = role_model(self.app, self.user.id, "generate", "generate", cid)
        checkpoint, saves = {}, []
        result = plugins.invoke(self.app, self.user, "compute-first", "/计算题",
                                {"spec": spec, "checkpoint": checkpoint, "save": lambda: saves.append(True)},
                                course_id=cid, model=model)
        self.assertTrue(result["draft"]["answer"])
        self.assertIn("computed", checkpoint)
        self.assertTrue(saves)
        with self.app.state.db.transaction() as conn:
            steps = conn.execute("SELECT label,plugin_id FROM model_usage WHERE user_id=?", (self.user.id,)).fetchall()
        self.assertTrue(steps)
        self.assertTrue(all(step["plugin_id"] == "compute-first" for step in steps))

    def test_template_cannot_embed_html_or_external_action(self):
        for node in (
            {"type": "iframe", "props": {}},
            {"type": "text", "props": {"onClick": "alert(1)"}},
            {"type": "button", "props": {"href": "https://outside.invalid"}},
            {"type": "button", "props": {"tool": "another-plugin:delete"}},
        ):
            with self.subTest(node=node), self.assertRaises(Exception):
                plugins.validate_template(node, {"ping"})
        good = {"type": "columns", "props": {}, "children": [{"type": "button", "props": {"tool": "ping", "label": "再算一次"}}]}
        self.assertEqual(plugins.validate_template(good, {"ping"}), good)


if __name__ == "__main__":
    unittest.main()
