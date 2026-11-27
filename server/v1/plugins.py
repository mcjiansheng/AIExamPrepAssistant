"""Per-user plugin catalog, package review and permission confirmation."""
import io
import json
import re
import stat
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, Request, Response
from pydantic import ConfigDict, Field, ValidationError

from . import courses
from .auth import Body, Principal, principal, require_member
from .db import dump, load, utc_now
from .errors import ApiError, conflict, not_found
from .events import changed
from .idempotency import run as idempotent
from .model_runtime import JobFailure

router = APIRouter()
User = Annotated[Principal, Depends(principal)]
PACKAGE_LIMIT = 50 * 1024 * 1024
FIXTURE = Path(__file__).with_name("seed") / "demo-content.json"
CATALOG = {item["id"]: item for item in load(FIXTURE.read_text(encoding="utf-8"))["plugins"]}
ID = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")]
NODE_TYPES = {"text", "title", "image", "table", "code", "formula", "list", "progress", "button", "columns"}


class Permissions(Body):
    read: list[str] = Field(default_factory=list)
    write: list[str] = Field(default_factory=list)
    network: list[str] = Field(default_factory=list)
    model: bool = False


class Command(Body):
    name: str
    description: str
    tool: str | None = None


class QuestionType(Body):
    id: ID
    name: str
    render: str | None = None
    grade: str | None = None


class MCP(Body):
    command: str
    args: list[str] = Field(default_factory=list)


class Manifest(Body):
    model_config = ConfigDict(extra="ignore", strict=True)
    id: ID
    name: Annotated[str, Field(min_length=1)]
    version: Annotated[str, Field(min_length=1)]
    description: str
    permissions: Permissions
    cost: str = "不调用模型"
    commands: list[Command] = Field(default_factory=list)
    question_types: list[QuestionType] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    cards: list[str] = Field(default_factory=list)
    mcp: MCP | None = None


class Patch(Body):
    enabled: bool | None = None
    scope: Literal["all", "courses"] | None = None
    course_ids: list[str] | None = None


class Link(Body):
    url: str


class PluginFailure(JobFailure):
    pass


def bad(message):
    return ApiError(400, "bad_request", message)


def ensure_catalog(conn, user):
    for pid, entry in CATALOG.items():
        manifest = {key: entry[key] for key in ("id", "name", "version", "description", "permissions", "cost", "commands", "question_types")}
        available = pid == "compute-first"
        readme = entry["readme"] if available else entry["readme"] + "\n\n即将支持。本版尚未提供此插件的运行能力。"
        conn.execute(
            """INSERT OR IGNORE INTO plugins
               (user_id,id,manifest,source,installed,enabled,granted,readme,updated_at)
               VALUES (?,?,?,'builtin',?,?,?,?,?)""",
            (user.id, pid, dump(manifest), available, available, available, readme, utc_now().isoformat()),
        )


def owned(conn, user, pid):
    row = conn.execute("SELECT * FROM plugins WHERE user_id=? AND id=?", (user.id, pid)).fetchone()
    if row is None:
        raise not_found("插件")
    return row


def view(conn, user, row, *, detail=False):
    manifest = load(row["manifest"])
    start = datetime.now(ZoneInfo(user.timezone)).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    tokens = conn.execute(
        "SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM model_usage WHERE user_id=? AND plugin_id=? AND created_at>=?",
        (user.id, row["id"], start.astimezone(ZoneInfo("UTC")).isoformat()),
    ).fetchone()[0]
    result = {key: manifest[key] for key in ("id", "name", "version", "description", "cost", "permissions")}
    result |= {
        "source": row["source"], "installed": bool(row["installed"]), "enabled": bool(row["enabled"]),
        "scope": row["scope"], "course_ids": load(row["course_ids"]), "granted": bool(row["granted"]),
        "commands": [{"name": c["name"], "description": c["description"]} for c in manifest["commands"]],
        "question_types": [{"id": t["id"], "name": t["name"]} for t in manifest["question_types"]],
        "usage_tokens": tokens,
    }
    if detail:
        result["readme"] = row["readme"]
    return result


def safe_path(value):
    path = PurePosixPath(value)
    if not value or "\\" in value or "\x00" in value or path.is_absolute() or ".." in path.parts or re.match(r"^[A-Za-z]:", value):
        raise bad("插件包包含越出目录的文件路径")
    return path.as_posix()


def validate_template(node, commands, depth=0):
    if depth > 30 or not isinstance(node, dict) or node.get("type") not in NODE_TYPES or not isinstance(node.get("props"), dict):
        raise bad("插件卡片的组件或属性格式不正确")
    if set(node) - {"type", "props", "children"}:
        raise bad("插件卡片包含不支持的字段")
    props = node["props"]
    if any(key.lower().startswith("on") or key.lower() in {"html", "dangerouslysetinnerhtml", "srcdoc"} for key in props):
        raise bad("插件卡片不能包含脚本或网页代码")
    if node["type"] == "button":
        href, tool = props.get("href"), props.get("tool")
        if href is not None and (not isinstance(href, str) or not href.startswith("/") or href.startswith("//")):
            raise bad("插件卡片按钮只能打开应用内页面")
        if tool is not None and tool not in commands:
            raise bad("插件卡片按钮只能调用本插件的工具")
    if node["type"] == "image":
        url = props.get("url", "")
        if not isinstance(url, str) or not (url.startswith("https://") or url.startswith("data:image/") or url.startswith("/") and not url.startswith("//")):
            raise bad("插件图片需要使用 HTTPS、应用内地址或图片数据")
    children = node.get("children", [])
    if not isinstance(children, list):
        raise bad("插件卡片 children 需要是数组")
    for child in children:
        validate_template(child, commands, depth + 1)
    return node


def read_package(content):
    if len(content) > PACKAGE_LIMIT:
        raise bad("插件包不能超过 50 MB")
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            files, total = {}, 0
            for entry in archive.infolist():
                name = safe_path(entry.filename)
                if entry.is_dir():
                    continue
                mode = entry.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise bad("插件包不能包含符号链接")
                total += entry.file_size
                if total > PACKAGE_LIMIT:
                    raise bad("插件包解压后不能超过 50 MB")
                if name in files:
                    raise bad("插件包里存在重复文件路径")
                files[name] = archive.read(entry)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise bad("无法读取插件 ZIP 文件") from None
    if "plugin.json" not in files:
        raise bad("插件包根目录需要有 plugin.json")
    try:
        manifest = Manifest.model_validate_json(files["plugin.json"])
    except (ValidationError, ValueError):
        raise bad("plugin.json 的清单格式不正确") from None
    data = manifest.model_dump(exclude_none=True)
    if manifest.id in CATALOG:
        raise conflict("第三方插件不能覆盖内置插件")
    skill_paths = manifest.skills or ["SKILL.md"]
    if not all(safe_path(path) in files for path in skill_paths):
        raise bad("插件包缺少清单里列出的 SKILL.md")
    for path in skill_paths:
        if PurePosixPath(path).name != "SKILL.md":
            raise bad("技能入口文件需要名为 SKILL.md")
    command_names = {c.name for c in manifest.commands} | {c.tool for c in manifest.commands if c.tool}
    if len({c.name for c in manifest.commands}) != len(manifest.commands):
        raise bad("插件命令名称不能重复")
    for path in [*manifest.cards, *(q.render for q in manifest.question_types if q.render)]:
        path = safe_path(path)
        if path not in files:
            raise bad("插件包缺少清单里列出的卡片模板")
        try:
            template = json.loads(files[path])
        except (ValueError, UnicodeError):
            raise bad("插件卡片模板需要是 JSON") from None
        validate_template(template, command_names)
    return data, files, "\n\n".join(files[path].decode("utf-8", errors="replace") for path in skill_paths)


def store_package(conn, user, content, source):
    manifest, _, readme = read_package(content)
    existing = conn.execute("SELECT * FROM plugins WHERE user_id=? AND id=?", (user.id, manifest["id"])).fetchone()
    approved = existing is not None and bool(existing["granted"]) and load(existing["manifest"])["permissions"] == manifest["permissions"]
    conn.execute(
        """INSERT INTO plugins(user_id,id,manifest,source,readme,package,updated_at) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(user_id,id) DO UPDATE SET manifest=excluded.manifest,source=excluded.source,readme=excluded.readme,
           package=excluded.package,updated_at=excluded.updated_at,installed=?,enabled=?,granted=?""",
        (user.id, manifest["id"], dump(manifest), source, readme, content, utc_now().isoformat(),
         bool(existing and existing["installed"] and approved), bool(existing and existing["enabled"] and approved), approved),
    )
    return view(conn, user, owned(conn, user, manifest["id"]))


async def download(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or not parsed.path.lower().endswith(".zip"):
        raise bad("链接安装只接受 HTTPS 的 ZIP 地址")
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            async with client.stream("GET", url) as response:
                if response.status_code != 200:
                    raise bad("插件下载没有成功，请检查 ZIP 地址")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > PACKAGE_LIMIT:
                        raise bad("插件包不能超过 50 MB")
                return bytes(body)
    except httpx.HTTPError:
        raise bad("插件下载失败，请稍后重试") from None


def changed_event(request, user):
    request.app.state.events.publish(user.id, changed(["plugins"]))


@router.get("/plugins")
def listing(request: Request, user: User):
    with request.app.state.db.transaction(write=True) as conn:
        ensure_catalog(conn, user)
        rows = conn.execute("SELECT * FROM plugins WHERE user_id=? ORDER BY rowid", (user.id,))
        return [view(conn, user, row) for row in rows]


@router.get("/plugins/{pid}")
def detail(pid: str, request: Request, user: User):
    with request.app.state.db.transaction(write=True) as conn:
        ensure_catalog(conn, user)
        return view(conn, user, owned(conn, user, pid), detail=True)


@router.post("/plugins")
async def upload(request: Request, user: User):
    require_member(user)
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        async with request.form() as form:
            file = form.get("file")
            if file is None or not hasattr(file, "read"):
                raise bad("请选择插件 ZIP 文件")
            content = await file.read(PACKAGE_LIMIT + 1)
        source = "file"
    else:
        try:
            link = Link.model_validate(await request.json())
        except (ValueError, ValidationError):
            raise bad("请填写插件 ZIP 地址") from None
        content = await download(link.url)
        source = "url"
    with request.app.state.db.transaction(write=True) as conn:
        _, result = idempotent(conn, request, user, lambda: (200, store_package(conn, user, content, source)))
    changed_event(request, user)
    return result


@router.post("/plugins/{pid}/install")
def install(pid: str, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        ensure_catalog(conn, user)
        row = owned(conn, user, pid)
        if row["source"] == "builtin" and pid != "compute-first":
            raise conflict("这个内置插件即将支持，运行能力接入后可安装")
        conn.execute("UPDATE plugins SET installed=1,enabled=1,granted=1 WHERE user_id=? AND id=?", (user.id, pid))
        result = view(conn, user, owned(conn, user, pid))
    changed_event(request, user)
    return result


@router.patch("/plugins/{pid}")
def patch(pid: str, body: Patch, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        ensure_catalog(conn, user)
        row = owned(conn, user, pid)
        if body.enabled and (not row["installed"] or not row["granted"]):
            raise conflict("请先确认插件权限并安装")
        scope = body.scope or row["scope"]
        ids = body.course_ids if body.course_ids is not None else load(row["course_ids"])
        for cid in ids:
            courses.course(conn, user.id, cid)
        enabled = body.enabled if body.enabled is not None else bool(row["enabled"])
        conn.execute("UPDATE plugins SET enabled=?,scope=?,course_ids=? WHERE user_id=? AND id=?",
                     (enabled, scope, dump(list(dict.fromkeys(ids))), user.id, pid))
        result = view(conn, user, owned(conn, user, pid))
    changed_event(request, user)
    return result


@router.delete("/plugins/{pid}", status_code=204)
def remove(pid: str, request: Request, user: User):
    require_member(user)
    with request.app.state.db.transaction(write=True) as conn:
        ensure_catalog(conn, user)
        row = owned(conn, user, pid)
        if row["source"] == "builtin":
            raise conflict("内置插件只能停用")
        conn.execute("DELETE FROM plugins WHERE user_id=? AND id=?", (user.id, pid))
    changed_event(request, user)
    return Response(status_code=204)


def permitted(conn, user, pid, course_id):
    ensure_catalog(conn, user)
    row = owned(conn, user, pid)
    if course_id:
        courses.course(conn, user.id, course_id)
    if row["scope"] == "courses" and course_id not in load(row["course_ids"]):
        raise not_found("当前课程的插件")
    if not row["installed"] or not row["granted"]:
        raise ApiError(403, "forbidden", "请先安装插件并确认权限")
    if not row["enabled"]:
        raise conflict("这个插件还没有启用")
    return row


def summaries(conn, user, course_id):
    ensure_catalog(conn, user)
    if course_id:
        courses.course(conn, user.id, course_id)
    rows = conn.execute("SELECT * FROM plugins WHERE user_id=? AND installed=1 AND enabled=1 AND granted=1", (user.id,))
    result = []
    for row in rows:
        if row["scope"] == "courses" and course_id not in load(row["course_ids"]):
            continue
        value = load(row["manifest"])
        result.append({"id": row["id"], "name": value["name"], "description": value["description"],
                       "commands": [{"name": c["name"], "description": c["description"]} for c in value["commands"]]})
    return result


def skill(conn, user, plugin_id, course_id=None):
    row = permitted(conn, user, plugin_id, course_id)
    return row["readme"]


def invoke(app, user, plugin_id, command, arguments, course_id=None, model=None):
    from .plugin_runtime import invoke as run_plugin
    with app.state.db.transaction(write=True) as conn:
        row = dict(permitted(conn, user, plugin_id, course_id))
    return run_plugin(app, user, row, command, arguments, course_id=course_id, model=model)
