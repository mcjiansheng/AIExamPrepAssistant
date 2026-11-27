"""Run the one authorized LongCat acceptance pass against an isolated local database."""
import json
import os
import re
import tempfile
import time
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

from fastapi.testclient import TestClient

from . import pipeline
from .app import ROOT, create_app
from .model_runtime import JobFailure, legacy_model, token_ceiling

LIMIT = 300_000
ZONE = "America/Los_Angeles"
DEVICE = {"kind": "browser", "name": "LongCat 冒烟", "timezone": ZONE}


class StopSmoke(JobFailure):
    def __init__(self, message):
        super().__init__(message, False)


class Budget:
    def __init__(self, limit=LIMIT):
        self.limit = limit
        self.spent = 0
        self.failures = 0
        self.reason = None

    def reserve(self, data):
        if self.reason:
            raise StopSmoke(self.reason)
        # Reserve the full request and the maximum response before asking LongCat.
        reserve = token_ceiling(data)
        if self.spent + reserve > self.limit:
            self.reason = "下一次请求可能超过 30 万 token，已停在调用前"
            raise StopSmoke(self.reason)
        return reserve

    def record(self, reserve, counts, ok, rejected_auth):
        if counts:
            self.spent += counts.get("prompt_tokens", counts.get("input_tokens", 0)) or 0
            self.spent += counts.get("completion_tokens", counts.get("output_tokens", 0)) or 0
        elif not rejected_auth:
            # Timeout or incomplete metering leaves the actual charge unknown.
            self.spent += reserve
        self.failures = 0 if ok else self.failures + 1
        if rejected_auth:
            self.reason = "LongCat 返回鉴权错误，已停止"
        elif self.failures >= 5:
            self.reason = "LongCat 请求连续 5 次失败，已停止"


def prepare_excerpt(local=None):
    """Keep a 12-slide copy of the nominated local 25-slide deck for the smoke run."""
    local = Path(local or ROOT / "local").resolve()
    source_folder = local / "课件资料"
    evidence = local / "证据"
    if (evidence / "server-v1-LongCat-smoke.json").exists():
        raise StopSmoke("本地已有 LongCat 冒烟记录，未生成新的课件副本")
    result = source_folder / "server-v1-LongCat-12页.pptx"
    if result.exists():
        if pipeline.page_count(result, ".pptx") == 12:
            return result
        raise StopSmoke("冒烟课件路径已存在，页数不是 12")
    sources = [path for path in local.rglob("*.pptx") if path.is_file()
               and path.resolve().is_relative_to(local) and pipeline.page_count(path, ".pptx") == 25]
    if len(sources) != 1:
        raise StopSmoke("无法唯一确定已确认的 25 页本地课件")
    source_folder.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=".smoke-", dir=source_folder) as part:
        trim_pptx(sources[0], part, 12)
        part.flush()
        os.link(part.name, result)
    return result


def trim_pptx(source, target, limit):
    slide_tag = "{http://schemas.openxmlformats.org/presentationml/2006/main}sldIdLst"
    rel_attr = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    presentation = "ppt/presentation.xml"
    relationships = "ppt/_rels/presentation.xml.rels"
    types = "[Content_Types].xml"
    with zipfile.ZipFile(source) as original:
        manifest = ElementTree.fromstring(original.read(presentation))
        links = ElementTree.fromstring(original.read(relationships))
        contents = ElementTree.fromstring(original.read(types))
        slides = manifest.find(slide_tag)
        if slides is None or len(slides) < limit:
            raise StopSmoke("这份 PPTX 的幻灯片目录无法截取前 12 页")
        discarded = {node.attrib[rel_attr] for node in list(slides)[limit:]}
        for node in list(slides)[limit:]:
            slides.remove(node)
        exclusions = set()
        for link in list(links):
            if link.get("Id") in discarded:
                path = PurePosixPath("ppt") / link.attrib["Target"]
                exclusions.add(path.as_posix().lstrip("/"))
                exclusions.add((path.parent / "_rels" / (path.name + ".rels")).as_posix().lstrip("/"))
                links.remove(link)
        for item in list(contents):
            if item.get("PartName", "").lstrip("/") in exclusions:
                contents.remove(item)
        actual = sum(bool(re.fullmatch(r"ppt/slides/slide\d+\.xml", name)) and name not in exclusions
                     for name in original.namelist())
        if actual != limit:
            raise StopSmoke("PPTX 目录和实际页面数不一致")
        replacements = {presentation: manifest, relationships: links, types: contents}
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for entry in original.namelist():
                if entry not in exclusions:
                    content = ElementTree.tostring(replacements[entry], encoding="utf-8") if entry in replacements else original.read(entry)
                    archive.writestr(entry, content)


def choose_material(local, selected=None):
    folder = (local / "课件资料").resolve()
    if selected:
        candidates = [Path(selected).expanduser().resolve()]
    else:
        candidates = sorted({path.resolve() for path in folder.rglob("*")
                             if path.suffix.lower() in {".pdf", ".pptx", ".docx"}},
                            key=lambda path: (path.suffix.lower() != ".pdf", str(path)))
    for path in candidates:
        if path.is_file() and path.is_relative_to(folder) and path.stat().st_size <= pipeline.UPLOAD_LIMIT:
            pages = pipeline.page_count(path, path.suffix.lower())
            if pages is not None and 10 <= pages <= 15:
                return path, pages
    raise StopSmoke("local/课件资料/ 下没有找到能确认是 10–15 页的课件")


def summary(app, report, budget):
    with app.state.db.transaction() as conn:
        usage = conn.execute(
            """SELECT COUNT(*) AS calls,COALESCE(SUM(input_tokens),0) AS input_tokens,
                      COALESCE(SUM(output_tokens),0) AS output_tokens,
                      COALESCE(SUM(ok),0) AS successful_calls FROM model_usage""",
        ).fetchone()
        breakdown = conn.execute(
            """SELECT feature,COUNT(*) AS calls,SUM(input_tokens+output_tokens) AS tokens
               FROM model_usage GROUP BY feature ORDER BY feature""",
        ).fetchall()
    report.update(dict(usage))
    report["tokens"] = report["input_tokens"] + report["output_tokens"]
    report["budget_debited"] = budget.spent
    report["by_feature"] = [dict(row) for row in breakdown]
    return report


def run(local=None, *, material=None, preflight=False):
    local = Path(local or ROOT / "local").resolve()
    path, pages = choose_material(local, material)
    key = legacy_model.LongCatClient(local / "data").key()
    if preflight:
        return {"status": "ready", "pages": pages}
    evidence = local / "证据"
    evidence.mkdir(parents=True, exist_ok=True)
    marker = evidence / "server-v1-LongCat-smoke.json"
    report = {"status": "running", "pages": pages, "stage": "能力检测", "checks": {}}
    try:
        with marker.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False)
    except FileExistsError:
        raise StopSmoke("本地已有这次 LongCat 冒烟记录，需要重新授权才能再跑") from None

    base = Path(tempfile.mkdtemp(prefix="v1-longcat-smoke-", dir=local))
    work = base / "tmp"
    work.mkdir()
    old_tmp = tempfile.tempdir
    old_environment = {name: os.environ.get(name) for name in ("TMPDIR", "TMP", "TEMP")}
    for name in old_environment:
        os.environ[name] = str(work)
    tempfile.tempdir = str(work)
    app = create_app(data_dir=base, mock_model=False, sms_mode="dev")
    budget = app.state.smoke_budget = Budget()

    try:
        with TestClient(app) as client:
            execute(client, path, key, report, budget)
        report["status"] = "passed"
    except StopSmoke as error:
        report.update(status="stopped", reason=budget.reason or str(error))
    except Exception as error:
        report.update(status="failed", reason=budget.reason or f"冒烟在{report['stage']}阶段结束（{type(error).__name__}）")
    finally:
        tempfile.tempdir = old_tmp
        for name, original in old_environment.items():
            if original is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = original
        summary(app, report, budget)
        marker.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def execute(client, path, key, report, budget):
    token = None

    def request(method, route, *, allow=(200,), **kwargs):
        if budget.reason:
            raise StopSmoke(budget.reason)
        headers = {"Authorization": "Bearer " + token} if token else {}
        result = client.request(method, "/api/v1" + route, headers=headers, **kwargs)
        if budget.reason:
            raise StopSmoke(budget.reason)
        if result.status_code not in allow:
            raise StopSmoke(f"{report['stage']}收到 HTTP {result.status_code}")
        return result

    def api(method, route, **kwargs):
        return request(method, route, **kwargs).json()

    def wait_job(job, *, on_poll=None):
        if job["status"] == "needs_input" and job["estimate"]:
            api("POST", f"/jobs/{job['id']}/continue")
        until = time.monotonic() + 1800
        while time.monotonic() < until:
            job = api("GET", f"/jobs/{job['id']}")
            if on_poll:
                on_poll()
            if job["status"] == "done":
                return
            if job["status"] == "failed":
                raise StopSmoke(f"{report['stage']}任务失败")
            if job["status"] == "needs_input":
                raise StopSmoke(f"{report['stage']}任务再次暂停，需确认")
            time.sleep(0.25)
        raise StopSmoke(f"{report['stage']}等待任务超时")

    token = api("POST", "/auth/huawei", json={"auth_code": "dev-13900000987", "device": DEVICE})["access_token"]
    connection = api("POST", "/me/providers", json={"preset_id": "longcat", "key": key})
    connection = api("POST", f"/me/providers/{connection['id']}/check")
    report["checks"]["capabilities"] = {step["id"]: step["ok"] for step in connection["steps"]}
    if connection["connection"]["status"] != "ok":
        raise StopSmoke("LongCat 能力检测未接通")
    cid = api("POST", "/courses", json={"name": "LongCat 冒烟课程"})["id"]

    report["stage"] = "整理资料"
    with path.open("rb") as stream:
        received = api("POST", f"/courses/{cid}/materials", data={"source": "file"},
                       files=[("files", ("smoke" + path.suffix.lower(), stream, "application/octet-stream"))])
    if not received["job"]:
        raise StopSmoke("上传后未启动整理任务")
    report["checks"]["ingest_confirmation"] = received["job"]["status"] == "needs_input"
    wait_job(received["job"])
    graph = api("GET", f"/courses/{cid}/map")
    points = [point for chapter in graph["chapters"] for point in chapter["kps"]]
    report["checks"]["knowledge_points"] = len(points)
    if len(points) < 2:
        raise StopSmoke("整理后没有足够知识点供重点分析")

    report["stage"] = "老师重点"
    first, second = points[:2]
    api("POST", f"/courses/{cid}/focus/fragments",
        json={"text": f"老师强调{first['title']}。老师建议复习{second['title']}。", "source": "text"})
    with client.app.state.db.transaction() as conn:
        job_id = conn.execute("SELECT id FROM jobs WHERE course_id=? AND kind='focus'", (cid,)).fetchone()[0]
    wait_job(api("GET", f"/jobs/{job_id}"))
    focus = api("GET", f"/courses/{cid}/focus")
    report["checks"]["focus_fragments"] = len(focus["fragments"])

    report["stage"] = "快练 5 题"
    started = time.monotonic()
    session = api("POST", "/sessions", json={"kind": "quick", "course_id": cid, "count": 5, "confirm": True})
    sid = session["id"]
    if not session["job"]:
        raise StopSmoke("快练没有进入新题生成流程")

    def record_first_question():
        if "first_question_seconds" not in report["checks"]:
            current = api("GET", f"/sessions/{sid}")
            if any(question["status"] == "ready" for question in current["questions"]):
                report["checks"]["first_question_seconds"] = round(time.monotonic() - started, 2)

    wait_job(session["job"], on_poll=record_first_question)
    questions = api("GET", f"/sessions/{sid}")["questions"]
    report["checks"]["question_checks"] = dict(Counter(q["check"] for q in questions))
    report["checks"]["questions_ready"] = sum(q["status"] == "ready" for q in questions)
    if report["checks"]["questions_ready"] != 5:
        raise StopSmoke("快练没有生成 5 道可答题")

    report["stage"] = "助手三轮"
    tid = next(t["id"] for t in api("GET", "/threads") if t["course_id"] == cid)

    def chat(text, **context):
        data = {"text": text, "context": {"route": "/", "course_id": cid, **context}}
        response = request("POST", f"/threads/{tid}/messages", json=data)
        events = [json.loads(line) for line in response.text.splitlines()]
        if not events or events[-1]["type"] != "done":
            raise StopSmoke("助手回复以错误结束")
        return events

    explain = chat(f"讲讲{first['title']}，尽量用课件里的例子。", kp_id=first["id"])
    report["checks"]["explanation"] = any(e["type"] == "text" or e.get("card", {}).get("kind") == "explain" for e in explain)
    before = api("GET", "/today")["minutes_available"]
    change = chat("今天只有 1 小时，请把今天可用时间改成 60 分钟。")
    card = next((e["card"] for e in change if e.get("card", {}).get("kind") == "change"), None)
    if not card or not card["undo_id"] or api("GET", "/today")["minutes_available"] != 60:
        raise StopSmoke("助手未保存可撤销的时间改动")
    api("POST", f"/undo/{card['undo_id']}")
    report["checks"]["undo"] = api("GET", "/today")["minutes_available"] == before
    hint = chat("给我一个提示。", session_id=sid, question_id=questions[0]["id"])
    q = next(q for q in api("GET", f"/sessions/{sid}")["questions"] if q["id"] == questions[0]["id"])
    report["checks"]["hint_protected"] = any(e["type"] == "text" for e in hint) and bool(q["hints"]) and not q["peeked"] and q["solution"] is None
    if not all(report["checks"][key] for key in ("explanation", "undo", "hint_protected")):
        raise StopSmoke("助手三轮有项目未通过")
