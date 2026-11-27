"""Assistant threads, streamed turns and explicit proposal decisions."""
import logging
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import Field, ValidationError
from starlette.responses import StreamingResponse

from . import assistant_tools, courses, jobs, materials, plugins, practice
from .auth import Body, Principal, new_id, principal, rate_limited, require_member
from .db import dump, load, local_iso, utc_now
from .errors import ApiError, conflict, not_found
from .events import changed
from .idempotency import run
from .model_runtime import JobFailure, Model, OutputError, ProviderFailure, RetryLater, TurnBudget, TurnLimit, binding

router = APIRouter()
User = Annotated[Principal, Depends(principal)]
logger = logging.getLogger("fullgrid.assistant")


class NewThread(Body):
    course_id: str | None = None
    title: str | None = None


class ThreadPatch(Body):
    title: str | None = None
    model: str | None = None


class Context(Body):
    route: str
    course_id: str | None = None
    kp_id: str | None = None
    session_id: str | None = None
    question_id: str | None = None
    material_id: str | None = None
    page: int | None = Field(default=None, ge=1)
    selection: str | None = None


class Send(Body):
    text: str
    context: Context
    command: str | None = None
    attachments: list[str] = Field(default_factory=list)


class Decision(Body):
    accept: bool


def thread_row(conn, user, tid):
    row = conn.execute("SELECT * FROM chat_threads WHERE user_id=? AND id=?", (user.id, tid)).fetchone()
    if row is None:
        raise not_found("对话")
    return row


def thread_view(row, user):
    result = {key: row[key] for key in ("id", "course_id", "title", "kind", "model", "preview")}
    return result | {"updated_at": local_iso(row["updated_at"], user.timezone)}


def owned_card(conn, user, cid):
    row = conn.execute(
        """SELECT c.* FROM chat_cards c JOIN chat_messages m ON m.id=c.message_id
           JOIN chat_threads t ON t.id=m.thread_id WHERE c.id=? AND t.user_id=?""",
        (cid, user.id),
    ).fetchone()
    if row is None:
        raise not_found("卡片")
    return row


def card_view(conn, user, row):
    value = load(row["value"])
    kind = value["kind"]
    if kind == "change" and value["undo_id"]:
        undo = conn.execute("SELECT state,expires_at FROM undos WHERE id=?", (value["undo_id"],)).fetchone()
        if undo and undo["state"] == "undone":
            value["state"] = "undone"
        elif not undo or undo["state"] != "active" or undo["expires_at"] <= utc_now().isoformat():
            value["state"] = "expired"
    elif kind == "question":
        try:
            question = practice.question_row(conn, user.id, value["question"]["id"])
        except ApiError as error:
            if error.status != 404:
                raise
        else:
            value["question"] = practice.question_view(conn, user, question)
    elif kind == "material":
        row = conn.execute("SELECT * FROM materials WHERE id=? AND user_id=?", (value["material"]["id"], user.id)).fetchone()
        if row is not None:
            value["material"] = materials.view(conn, row, user.timezone)
    elif kind == "task" and value["job_id"]:
        job = conn.execute("SELECT * FROM jobs WHERE id=? AND user_id=?", (value["job_id"], user.id)).fetchone()
        if job:
            value |= assistant_tools.task_state(job)
    return value


def messages(conn, user, tid, limit):
    rows = conn.execute(
        "SELECT * FROM chat_messages WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?", (tid, limit),
    ).fetchall()
    result = []
    for row in reversed(rows):
        cards = conn.execute("SELECT * FROM chat_cards WHERE message_id=? ORDER BY rowid", (row["id"],))
        result.append({
            "id": row["id"], "role": row["role"], "text": row["text"],
            "created_at": local_iso(row["created_at"], user.timezone),
            "tools": load(row["tools"]), "refs": load(row["refs"]), "memory": load(row["memory"]),
            "status": "done" if row["status"] == "running" else row["status"],
            "error": load(row["error"]), "cards": [card_view(conn, user, card) for card in cards],
        })
    return result


@router.get("/threads")
def threads(request: Request, user: User):
    with request.app.state.db.transaction() as conn:
        rows = conn.execute("SELECT * FROM chat_threads WHERE user_id=? ORDER BY updated_at DESC,rowid DESC", (user.id,))
        return [thread_view(row, user) for row in rows]


@router.post("/threads")
def new_thread(body: NewThread, request: Request, user: User):
    def create():
        if body.course_id:
            courses.course(conn, user.id, body.course_id)
        tid = new_id("th")
        conn.execute(
            "INSERT INTO chat_threads(id,user_id,course_id,title,kind,updated_at) VALUES (?,?,?,?,'custom',?)",
            (tid, user.id, body.course_id, body.title or "新对话", utc_now().isoformat()),
        )
        return 200, thread_view(thread_row(conn, user, tid), user)
    with request.app.state.db.transaction(write=True) as conn:
        _, result = run(conn, request, user, create)
    return result


@router.patch("/threads/{tid}")
def patch_thread(tid: str, body: ThreadPatch, request: Request, user: User):
    with request.app.state.db.transaction(write=True) as conn:
        before = thread_row(conn, user, tid)
        model = body.model if "model" in body.model_fields_set else before["model"]
        conn.execute("UPDATE chat_threads SET title=?,model=?,updated_at=? WHERE id=?",
                     (body.title or before["title"], model, utc_now().isoformat(), tid))
        return thread_view(thread_row(conn, user, tid), user)


@router.delete("/threads/{tid}", status_code=204)
def delete_thread(tid: str, request: Request, user: User):
    with request.app.state.db.transaction(write=True) as conn:
        row = thread_row(conn, user, tid)
        if row["kind"] != "custom":
            raise conflict("只能删除自己新建的对话")
        conn.execute("DELETE FROM chat_threads WHERE id=?", (tid,))
    return Response(status_code=204)


@router.get("/threads/{tid}")
def read_thread(tid: str, request: Request, user: User, limit: Annotated[int, Query(ge=0)] = 50):
    with request.app.state.db.transaction() as conn:
        return {"thread": thread_view(thread_row(conn, user, tid), user), "messages": messages(conn, user, tid, limit)}


def stop_turn(conn, tid):
    conn.execute("UPDATE chat_messages SET status='stopped' WHERE thread_id=? AND status='running'", (tid,))


@router.post("/threads/{tid}/stop", status_code=204)
def stop(tid: str, request: Request, user: User):
    with request.app.state.db.transaction(write=True) as conn:
        thread_row(conn, user, tid)
        stop_turn(conn, tid)
    return Response(status_code=204)


def targets(conn, user, row, body):
    context = body.context
    question = practice.question_row(conn, user.id, context.question_id) if context.question_id else None
    session = practice.session_row(conn, user.id, context.session_id) if context.session_id else None
    point = courses.kp(conn, user.id, context.kp_id) if context.kp_id else None
    material = materials.owned(conn, user.id, context.material_id) if context.material_id else None
    attached = [materials.owned(conn, user.id, mid) for mid in body.attachments]
    if question and session and question["session_id"] != session["id"]:
        raise not_found("题目")
    cid = context.course_id or row["course_id"]
    if cid:
        courses.course(conn, user.id, cid)
    for resource in (point, question, session, material, *attached):
        if resource is not None and resource["course_id"]:
            if cid and cid != resource["course_id"]:
                raise not_found("当前课程的资源")
            cid = resource["course_id"]
    return cid


class TurnStopped(Exception):
    pass


def active(conn, reply):
    row = conn.execute("SELECT status FROM chat_messages WHERE id=?", (reply,)).fetchone()
    if not row or row["status"] != "running":
        raise TurnStopped


def save_card(conn, reply, value, operation=None):
    conn.execute("INSERT INTO chat_cards(id,message_id,value,operation) VALUES (?,?,?,?)",
                 (value["id"], reply, dump(value), dump(operation) if operation else None))


def save_result(conn, reply, result):
    if result.card:
        save_card(conn, reply, result.card, result.operation)
    if result.answer:
        conn.execute("UPDATE chat_messages SET text=text||? WHERE id=?", (result.answer, reply))
    for column, values in (("refs", result.refs), ("memory", [result.memory] if result.memory else [])):
        if values:
            current = load(conn.execute(f"SELECT {column} FROM chat_messages WHERE id=?", (reply,)).fetchone()[0])
            conn.execute(f"UPDATE chat_messages SET {column}=? WHERE id=?", (dump(current + values), reply))


def turn_payload(result):
    if result.answer:
        for pos in range(0, len(result.answer), 12):
            yield {"type": "text", "delta": result.answer[pos:pos + 12]}
    if result.card:
        yield {"type": "card", "card": result.card}
    if result.refs:
        yield {"type": "refs", "refs": result.refs}
    if result.memory:
        yield {"type": "memory", "item": result.memory}



def stream(app, user, body, target, ids, model_row):
    db = app.state.db
    tid, incoming, reply = ids

    def append(event):
        with db.transaction(write=True) as conn:
            active(conn, reply)
            if event["type"] == "card":
                save_card(conn, reply, event["card"])
            elif event["type"] == "text":
                conn.execute("UPDATE chat_messages SET text=text||? WHERE id=?", (event["delta"], reply))
            elif event["type"] == "tool" and event["status"] == "running":
                row = conn.execute("SELECT tools FROM chat_messages WHERE id=?", (reply,)).fetchone()
                conn.execute("UPDATE chat_messages SET tools=? WHERE id=?",
                             (dump(load(row["tools"]) + [{"label": event["label"]}]), reply))
        return dump(event) + "\n"

    def finish(error=None):
        with db.transaction(write=True) as conn:
            finished = conn.execute("UPDATE chat_messages SET status=?,error=? WHERE id=? AND status='running'",
                                    ("error" if error else "done", dump({"code": error["code"], "message": error["message"]}) if error else None, reply)).rowcount
        if finished:
            app.state.events.publish(user.id, changed(["threads"], target))
        return dump(error or {"type": "done"}) + "\n"

    def failure(code, message, retryable=True):
        return {"type": "error", "code": code, "message": message, "retryable": retryable}

    try:
        if model_row is None:
            event = assistant_tools.card(user, "connect", reason="连接 AI 模型后，助手就能回答和操作")
            yield append({"type": "card", "card": event})
            yield finish()
            return
        raw_model, override = model_row
        model = Model(app, raw_model, override or raw_model["model"], "chat", target, turn_budget=TurnBudget())
        yield append({"type": "start", "message_id": reply, "user_message_id": incoming})
        with db.transaction() as conn:
            if jobs.reached_daily_limit(conn, user):
                raise JobFailure("今天的 AI 用量已到上限，明天可以继续", False)
            packet = assistant_tools.context_packet(conn, user, tid, reply, body, target)
        if body.command and body.command.startswith("plugin:") and not body.context.question_id:
            yield from stream_plugin(app, user, body, target, reply, model, append, finish)
            return
        intents = assistant_tools.plan(model, packet, body)
        multi = len(intents) > 1
        if multi and any(tool in {"focus", "practice", "organize"} for tool, _ in intents):
            with db.transaction(write=True) as conn:
                active(conn, reply)
                payload = {"steps": [{"label": assistant_tools.label(tool), "status": "pending", "tool": tool, "params": params}
                                      for tool, params in intents], "body": body.model_dump(), "reply": reply, "index": 0}
                job = jobs.new_job(conn, user, "agent", reply, course_id=target, stage="等待开始", payload=payload)
                task = assistant_tools.card(user, "task", title="正在处理你的请求", job_id=job["id"], href=None,
                                            **assistant_tools.task_state(jobs.owned_job(conn, user.id, job["id"])))
                save_card(conn, reply, task)
            yield dump({"type": "card", "card": task}) + "\n"
            yield finish()
            return
        if multi:
            task = assistant_tools.card(user, "task", title="正在处理你的请求", job_id=None,
                                        steps=[{"label": assistant_tools.label(tool), "status": "pending"} for tool, _ in intents],
                                        state="running", href=None)
            yield append({"type": "card", "card": task})
        for index, (tool, params) in enumerate(intents):
            tag = {"type": "tool", "id": new_id("tool"), "label": assistant_tools.label(tool)}
            yield append(tag | {"status": "running"})
            try:
                if tool == "hint" and model.mock is None:
                    suggestion = assistant_tools.live_hint(app, user, body, model)
                else:
                    suggestion = None
                with db.transaction(write=True) as conn:
                    active(conn, reply)
                    if tool in {"hint", "answer"}:
                        result = assistant_tools.question_help(conn, user, body, tool, suggestion)
                    else:
                        result = assistant_tools.execute(conn, app, user, body, target, tool, params)
                    save_result(conn, reply, result)
                for event in turn_payload(result):
                    yield dump(event) + "\n"
                if result.affects:
                    app.state.events.publish(user.id, changed(result.affects, target))
                yield append(tag | {"status": "done"})
            except (ApiError, ValidationError) as error:
                yield append(tag | {"status": "failed"})
                message = error.body["error"]["message"] if isinstance(error, ApiError) else "这一步的参数有误，请说清要改哪一项"
                if multi:
                    update_task(db, task, index, "failed")
                yield finish(failure("tool_failed", message))
                return
            if multi:
                update_task(db, task, index, "done")
        yield finish()
    except TurnStopped:
        yield finish()
    except ProviderFailure as error:
        if error.status in {"invalid", "limited"}:
            event = assistant_tools.card(user, "connect", reason=str(error))
            yield append({"type": "card", "card": event})
        yield finish(failure("provider_error", str(error), error.retryable))
    except TurnLimit as error:
        yield append({"type": "text", "delta": str(error)})
        yield finish()
    except (JobFailure, OutputError, RetryLater) as error:
        yield finish(failure("provider_error", str(error), getattr(error, "retryable", True)))
    except Exception as error:
        from .app import exception_chain
        logger.error(dump({"event": "assistant_internal", "errors": exception_chain(error)}))
        yield finish(failure("internal", "这一轮没有完成，可以重试"))
    finally:
        with db.transaction(write=True) as conn:
            conn.execute("UPDATE chat_messages SET status='stopped' WHERE id=? AND status='running'", (reply,))


def stream_plugin(app, user, body, target, reply, model, append, finish):
    _, _, spec = body.command.partition(":")
    pid, _, command = spec.partition(":")
    tag = {"type": "tool", "id": new_id("tool"), "label": command or "调用插件"}
    yield append(tag | {"status": "running"})
    try:
        result = assistant_tools.plugin_result(app, user, body, target, pid, command, model)
    except (ApiError, plugins.PluginFailure) as error:
        yield append(tag | {"status": "failed"})
        yield finish({"type": "error", "code": "tool_failed", "message": str(error),
                      "retryable": getattr(error, "retryable", False)})
        return
    with app.state.db.transaction(write=True) as conn:
        active(conn, reply)
        save_result(conn, reply, result)
    for event in turn_payload(result):
        yield dump(event) + "\n"
    yield append(tag | {"status": "done"})
    yield finish()


def update_task(db, task, index, status):
    task["steps"][index]["status"] = status
    if status == "failed":
        task["state"] = "failed"
    elif index == len(task["steps"]) - 1:
        task["state"] = "done"
    with db.transaction(write=True) as conn:
        conn.execute("UPDATE chat_cards SET value=? WHERE id=?", (dump(task), task["id"]))


@router.post("/threads/{tid}/messages")
def send(tid: str, body: Send, request: Request, user: User):
    app = request.app
    with app.state.db.transaction(write=True) as conn:
        row = thread_row(conn, user, tid)
        target = targets(conn, user, row, body)
        if not body.text.strip() and not body.command and not body.attachments:
            raise ApiError(400, "bad_request", "请输入消息")
        now = utc_now()
        sent = conn.execute(
            """SELECT m.created_at FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id
               WHERE t.user_id=? AND m.role='user' AND m.created_at>? ORDER BY m.created_at""",
            (user.id, (now - timedelta(minutes=1)).isoformat()),
        ).fetchall()
        if len(sent) >= 20:
            seconds = (datetime.fromisoformat(sent[0]["created_at"]) + timedelta(minutes=1) - now).total_seconds()
            raise rate_limited("消息发得太快，请稍后再试", seconds)
        stop_turn(conn, tid)
        incoming, reply = new_id("msg"), new_id("msg")
        conn.executemany("INSERT INTO chat_messages(id,thread_id,role,text,created_at,status) VALUES (?,?,?,?,?,?)",
                         [(incoming, tid, "user", body.text, now.isoformat(), "done"),
                          (reply, tid, "assistant", "", now.isoformat(), "running")])
        conn.execute("UPDATE chat_threads SET preview=?,updated_at=? WHERE id=?", (body.text[:120], now.isoformat(), tid))
        model = binding(conn, user.id, "chat", app.state.mock_model)
        model_row = (model, row["model"]) if model is not None else None
    return StreamingResponse(stream(app, user, body, target, (tid, incoming, reply), model_row),
                             media_type="application/x-ndjson", headers={"X-Accel-Buffering": "no"})


@router.post("/proposals/{card_id}")
def decide(card_id: str, body: Decision, request: Request, user: User):
    app = request.app
    with app.state.db.transaction(write=True) as conn:
        row = owned_card(conn, user, card_id)
        value = load(row["value"])
        if value["kind"] != "proposal":
            raise not_found("提议")
        affects = []
        if value["state"] == "pending":
            if body.accept:
                require_member(user)
                affects = assistant_tools.accept(conn, app, user, load(row["operation"]))
            value["state"] = "accepted" if body.accept else "declined"
            conn.execute("UPDATE chat_cards SET value=? WHERE id=?", (dump(value), card_id))
    if affects:
        app.state.events.publish(user.id, changed(affects))
    return {"card": value, "affects": affects}


class BackgroundWait(Exception):
    pass


def run_agent(app, user, job, payload):
    from .pipeline import Removed, job_event, set_job
    db = app.state.db
    jid = job["id"]
    body = Send(**payload["body"])
    steps = payload["steps"]
    index = payload["index"]
    with db.transaction(write=True) as conn:
        if jobs.owned_job(conn, user.id, jid)["status"] != "running":
            raise Removed
        if not conn.execute("SELECT 1 FROM chat_messages WHERE id=?", (payload["reply"],)).fetchone():
            raise JobFailure("原对话已删除", False)
        step = steps[index]
        child = jobs.owned_job(conn, user.id, step["wait_for"]) if step.get("wait_for") else None
        affects = []
        raise_failure = None
        if child and child["status"] in {"queued", "running", "needs_input"}:
            step["status"] = "running"
            again = (utc_now() + timedelta(seconds=1)).isoformat()
            set_job(conn, jid, payload, child["stage"] or step["label"], status="queued", progress=index / len(steps))
            conn.execute("UPDATE jobs SET run_after=? WHERE id=?", (again, jid))
            waiting = True
        elif child and child["status"] == "failed":
            step["status"] = "failed"
            conn.execute("UPDATE jobs SET payload=? WHERE id=?", (dump(payload), jid))
            failure = load(child["error"])
            raise_failure = JobFailure(failure["message"], failure["retryable"])
            waiting = False
        else:
            raise_failure = None
            waiting = False
            if child is None:
                try:
                    result = assistant_tools.execute(conn, app, user, body, job["course_id"], step["tool"], step["params"])
                except (ApiError, ValidationError) as error:
                    step["status"] = "failed"
                    conn.execute("UPDATE jobs SET payload=? WHERE id=?", (dump(payload), jid))
                    raise_failure = JobFailure(str(error) if isinstance(error, ApiError) else "这一步的参数有误", True)
                else:
                    save_result(conn, payload["reply"], result)
                    affects = result.affects
                    if result.wait_for:
                        step["wait_for"] = result.wait_for
                        step["status"] = "running"
                        waiting = True
            if raise_failure is None and not waiting:
                step["status"] = "done"
                payload["index"] += 1
            if raise_failure is None:
                state = "queued" if payload["index"] < len(steps) else "running"
                set_job(conn, jid, payload, step["label"], status=state, progress=payload["index"] / len(steps))
    if affects:
        app.state.events.publish(user.id, changed(affects, job["course_id"]))
    app.state.events.publish(user.id, changed(["threads"], job["course_id"]))
    if raise_failure:
        raise raise_failure
    if waiting or payload["index"] < len(steps):
        job_event(app, user, jid)
        raise BackgroundWait


@router.post("/agent-tasks/{job_id}/stop", status_code=204)
def stop_job(job_id: str, request: Request, user: User):
    app = request.app
    with app.state.db.transaction(write=True) as conn:
        job = jobs.owned_job(conn, user.id, job_id)
        if job["kind"] != "agent":
            raise not_found("助手任务")
        if job["status"] in {"queued", "running", "needs_input"}:
            payload = load(job["payload"]) | {"stopped": True}
            conn.execute("UPDATE jobs SET status='failed',stage='已停止',error=?,payload=? WHERE id=?",
                         (dump({"message": "任务已停止", "retryable": False}), dump(payload), job_id))
    from .pipeline import job_event
    job_event(app, user, job_id)
    app.state.events.publish(user.id, changed(["threads"], job["course_id"]))
    return Response(status_code=204)
