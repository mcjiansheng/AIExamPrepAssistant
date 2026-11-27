import base64
import json
import logging
import time
from urllib.parse import urlsplit

import httpx

from .auth import new_id
from .db import dump, utc_now
from .legacy import module

legacy_model = module("model")
legacy_core = module("core")
MockClient = legacy_model.MockClient
RetryLater = legacy_core.RetryLater
JobFailure = legacy_core.JobFailure
OutputError = module("workflow.llm").OutputError
ROLES = ("chat", "organize", "generate", "vision")

logging.getLogger("httpx").setLevel(logging.WARNING)


class LegacyModelLog(logging.Filter):
    def filter(self, record):
        if record.msg == "%s 输出未通过校验：%s":
            step, _ = record.args
            record.msg = "%s 输出未通过校验"
            record.args = (step,)
        return True


logging.getLogger().addFilter(LegacyModelLog())


def question_reply(raw, prompt):
    try:
        value = legacy_model.parse_json(raw)
    except ValueError:
        return raw
    if not isinstance(value, dict):
        return raw
    if legacy_model.data_from(prompt)["type"] != "single" and value.get("options") == []:
        value["options"] = None
    steps, rubric = value.get("steps"), value.get("rubric")
    if isinstance(steps, list) and len(steps) == 1 and isinstance(rubric, list):
        # The sole solution step is the only possible target for a rubric reference.
        for point in rubric:
            if isinstance(point, dict) and type(point.get("step")) is int:
                point["step"] = 1
    return dump(value)


class ProviderFailure(JobFailure):
    def __init__(self, message, status):
        super().__init__(message, True)
        self.status = status


class TurnLimit(JobFailure):
    def __init__(self):
        super().__init__("这轮对话已达到用量上限，已完成的操作会保留", False)


def token_ceiling(data):
    if data is None:
        return 0
    reserve = len(dump(data).encode()) + data.get("max_tokens", 0) + 512
    if "data:image/" in str(data):
        reserve = max(reserve, 16_000)
    return reserve


class TurnBudget:
    def __init__(self):
        self.in_use = 0

    def reserve(self, data):
        size = token_ceiling(data)
        if self.in_use + size > 30_000:
            raise TurnLimit
        self.in_use += size
        return size

    def record(self, reserved, counts):
        if counts:
            incoming = counts.get("prompt_tokens", counts.get("input_tokens", 0)) or 0
            outgoing = counts.get("completion_tokens", counts.get("output_tokens", 0)) or 0
            self.in_use += incoming + outgoing - reserved


def binding(conn, user_id, role, mock_model):
    return conn.execute(
        """SELECT c.*,r.model FROM model_roles r JOIN provider_connections c
           ON c.user_id=r.user_id AND c.id=r.connection_id
           WHERE r.user_id=? AND r.role=? AND c.status='ok' AND (c.mock_only=0 OR ?)""",
        (user_id, role, mock_model),
    ).fetchone()


def cost_of(presets, row, model, incoming, outgoing):
    preset = presets.get(row["preset_id"])
    price = next((item["price"] for item in preset["models"] if item["id"] == model), None) if preset else None
    if price is None:
        return None
    return round((incoming * price["input"] + outgoing * price["output"]) / 1_000_000, 8)


class Model:
    def __init__(self, app, connection, model, feature, course_id=None, job_id=None, plugin_id=None, turn_budget=None):
        self.app = app
        self.row = connection
        self.model = model
        self.feature = feature
        self.course_id = course_id
        self.job_id = job_id
        self.plugin_id = plugin_id
        self.turn_budget = turn_budget
        self.mock = MockClient() if app.state.mock_model else None

    def key(self):
        with self.app.state.db.transaction() as conn:
            row = conn.execute("SELECT * FROM provider_connections WHERE id=? AND user_id=?",
                               (self.row["id"], self.row["user_id"])).fetchone()
            if row is None or row["key_ciphertext"] != self.row["key_ciphertext"]:
                raise JobFailure("模型连接已更改，请连接后重试", True)
            return self.app.state.vault.decrypt(conn, row)

    def usage(self, step, started, counts, ok):
        incoming = counts.get("prompt_tokens", counts.get("input_tokens", 0)) or 0
        outgoing = counts.get("completion_tokens", counts.get("output_tokens", 0)) or 0
        feature = "verify" if step.split(":", 1)[0] in {"v3", "v4", "v6", "readback"} else self.feature
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute(
                """INSERT INTO model_usage
                   (id,user_id,course_id,feature,plugin_id,provider,model,input_tokens,output_tokens,ok,latency_ms,created_at,label,cost,job_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (new_id("us"), self.row["user_id"], self.course_id, feature, self.plugin_id, self.row["id"], self.model,
                 incoming, outgoing, int(ok), round((time.monotonic() - started) * 1000), utc_now().isoformat(), step,
                 cost_of(self.app.state.presets, self.row, self.model, incoming, outgoing), self.job_id),
            )
            if ok and self.job_id is not None:
                conn.execute("UPDATE jobs SET failure_count=0 WHERE id=?", (self.job_id,))

    def disabled(self, failure):
        with self.app.state.db.transaction(write=True) as conn:
            conn.execute(
                "UPDATE provider_connections SET status=?,status_message=?,checked_at=? WHERE id=? AND key_ciphertext=?",
                (failure.status, str(failure), utc_now().isoformat(), self.row["id"], self.row["key_ciphertext"]),
            )
        self.app.state.events.publish(self.row["user_id"], {"type": "changed", "areas": ["providers"], "course_id": None})

    def url(self, endpoint):
        base = self.row["base_url"]
        if base.endswith("#"):
            if endpoint == "models":
                return None
            return base[:-1]
        parts = urlsplit(base)
        suffix = parts.path.rstrip("/")
        if self.row["protocol"] in {"openai", "anthropic"} and not suffix:
            suffix = "/v1"
        return parts._replace(path=f"{suffix}/{endpoint}").geturl()

    def request(self, step, endpoint, data=None, *, optional=False):
        url = self.url(endpoint)
        if url is None:
            return None
        budget = getattr(self.app.state, "smoke_budget", None)
        reserve = budget.reserve(data) if budget else 0
        turn_reserve = self.turn_budget.reserve(data) if self.turn_budget else 0
        started = time.monotonic()
        counts = {}
        ok = False
        rejected_auth = False
        try:
            key = self.key()
            if self.row["protocol"] == "anthropic":
                headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
            else:
                headers = {"Authorization": f"Bearer {key}"}
            with httpx.Client(timeout=100) as client:
                response = client.get(url, headers=headers) if data is None else client.post(url, headers=headers, json=data)
            status = response.status_code
            diagnostic = response.text.casefold()[:4000] if status >= 400 else ""
            if status in (401, 403):
                rejected_auth = True
                raise ProviderFailure("密钥无效或没有权限，请更新密钥", "invalid")
            if status == 402 or any(word in diagnostic for word in ("insufficient_quota", "insufficient balance")):
                raise ProviderFailure("服务商余额不足，请充值或换一个服务商", "limited")
            if status in (404, 405, 501) and optional:
                ok = True
                return None
            if status == 429 or status >= 500:
                raise RetryLater("服务商限流，请稍后重试" if status == 429 else "服务商暂时异常，请稍后重试")
            if status == 404:
                raise ProviderFailure("模型不可用，请从列表里换一个", "invalid")
            if status >= 400:
                if any(word in diagnostic for word in ("model_not_found", "invalid_model", "model not found")):
                    raise ProviderFailure("模型不可用，请从列表里换一个", "invalid")
                raise JobFailure("服务商拒绝处理这次请求，请检查模型和资料", False)
            try:
                reply = response.json()
            except ValueError:
                raise RetryLater("服务商返回了无法读取的回复") from None
            if not isinstance(reply, dict):
                raise RetryLater("服务商返回了无法读取的回复")
            counts = reply.get("usage") or {}
            if reply.get("status") == "failed":
                raise RetryLater("服务商没有完成这次响应")
            ok = True
            return reply
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
            raise RetryLater("服务商暂时未响应，请稍后重试") from None
        except ProviderFailure as failure:
            self.disabled(failure)
            raise
        finally:
            if budget:
                budget.record(reserve, counts, ok, rejected_auth)
            if self.turn_budget:
                self.turn_budget.record(turn_reserve, counts)
            self.usage(step, started, counts, ok)

    def payload(self, system, message, limit, images):
        content = message
        if images:
            content = [{"type": "text", "text": message}]
            for image in images:
                encoded = base64.b64encode(image).decode("ascii")
                if self.row["protocol"] == "anthropic":
                    content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": encoded}})
                else:
                    content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + encoded}})
        result = {"model": self.model, "max_tokens": limit}
        if self.row["protocol"] == "anthropic":
            return "messages", {**result, "system": system, "messages": [{"role": "user", "content": content}]}
        result["messages"] = [{"role": "system", "content": system}, {"role": "user", "content": content}]
        if self.row["protocol"] == "longcat":
            result["thinking"] = {"type": "disabled"}
        return "chat/completions", result

    def complete(self, step, system, user, images=None):
        if self.mock is not None:
            started = time.monotonic()
            if step == "grade":
                from server.workflow.items import norm_text
                packet = legacy_model.data_from(user)
                response = norm_text(packet["response"])
                reply = dump({"marks": {point["id"]: "full" if norm_text(point["point"]) in response else "none"
                                         for point in packet["rubric"]}})
            else:
                reply = self.mock.complete(step, system, user, images)
            self.usage(step, started, {"input_tokens": len(system + user) // 3, "output_tokens": len(reply) // 3}, True)
            return question_reply(reply, user) if step == "question" else reply
        task = step.partition(":")[0]
        limit = 1800 if task in {"extract", "topics", "question", "cfproblem", "cfexplain", "chat"} else 800
        endpoint, data = self.payload(system, user, limit, images)
        reply = self.request(step, endpoint, data)
        try:
            if self.row["protocol"] == "anthropic":
                text = "".join(part["text"] for part in reply["content"] if part["type"] == "text")
            else:
                text = reply["choices"][0]["message"].get("content") or ""
        except (IndexError, KeyError, TypeError):
            raise RetryLater("服务商返回了无法读取的回复") from None
        return question_reply(text, user) if step == "question" else text

    def tool_intent(self, system, packet, tools):
        endpoint, data = self.payload(system, dump(packet), 1000, None)
        if self.row["protocol"] == "anthropic":
            data["tools"] = [{"name": tool["name"], "description": tool["description"], "input_schema": tool["parameters"]}
                             for tool in tools]
            reply = self.request("chat_tools", endpoint, data)
            calls = [part for part in reply["content"] if part["type"] == "tool_use"]
            if len(calls) == 1:
                return {"tool": calls[0]["name"], "params": calls[0]["input"]}
        else:
            data["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                                 "parameters": t["parameters"]}} for t in tools]
            reply = self.request("chat_tools", endpoint, data)
            calls = reply["choices"][0]["message"].get("tool_calls") or []
            if len(calls) == 1:
                function = calls[0]["function"]
                try:
                    return {"tool": function["name"], "params": json.loads(function["arguments"])}
                except ValueError as error:
                    raise OutputError("工具参数不是 JSON 对象") from error
        raise OutputError("模型没有返回一个可执行的工具")


def role_model(app, user_id, role, feature, course_id=None, job_id=None):
    with app.state.db.transaction() as conn:
        row = binding(conn, user_id, role, app.state.mock_model)
    if row is None:
        raise JobFailure("还没有连接 AI 模型", True)
    return Model(app, row, row["model"], feature, course_id, job_id)
