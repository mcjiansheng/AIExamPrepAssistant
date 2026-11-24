"""运行模型生成的验算代码。

代码来自模型，必须当作不可信输入：
1. 执行前做语法树检查：只允许少数标准库，禁止文件、反射和动态执行。
2. 在独立子进程中执行：隔离模式、空环境变量、临时目录、超时和资源上限。
3. 运行时再限制一次 import 和内置函数，防止绕过静态检查。

原型在本机子进程中运行；产品阶段应放进无网络的容器。
"""
import ast
import json
import re
import subprocess
import sys
import tempfile

MODULE_EXPORTS = {
    "math": ("ceil", "comb", "copysign", "cos", "e", "exp", "fabs", "factorial", "floor", "fmod",
             "fsum", "gcd", "hypot", "inf", "isclose", "isfinite", "isqrt", "lcm", "log", "log10",
             "log2", "perm", "pi", "pow", "prod", "radians", "sin", "sqrt", "tan", "tau", "trunc"),
    "fractions": ("Fraction",),
    "decimal": ("Decimal", "localcontext", "ROUND_HALF_UP", "ROUND_HALF_EVEN"),
    "itertools": ("accumulate", "chain", "combinations", "combinations_with_replacement", "count",
                  "cycle", "groupby", "islice", "permutations", "product", "repeat", "zip_longest"),
    "functools": ("cache", "lru_cache", "reduce"),
    "collections": ("Counter", "deque", "defaultdict"),
    "heapq": ("heapify", "heappop", "heappush", "heappushpop", "heapreplace", "merge", "nlargest", "nsmallest"),
    "bisect": ("bisect", "bisect_left", "bisect_right", "insort", "insort_left", "insort_right"),
    "statistics": ("mean", "median", "mode", "pstdev", "pvariance", "stdev", "variance"),
    "string": ("ascii_letters", "ascii_lowercase", "ascii_uppercase", "digits", "hexdigits"),
}
ALLOWED_MODULES = set(MODULE_EXPORTS)
FORBIDDEN_NAMES = {
    "open", "eval", "exec", "compile", "__import__", "input", "globals", "locals", "vars", "getattr", "setattr", "delattr",
    "breakpoint", "exit", "quit", "help", "memoryview", "dir", "print", "type", "object", "super", "classmethod", "staticmethod", "property",
}
TIMEOUT_SECONDS = 10


class SandboxError(Exception):
    pass


def check_code(code):
    """静态检查。不通过时抛出 SandboxError，说明原因，便于让模型改写。"""
    if not isinstance(code, str) or not code.strip():
        raise SandboxError("验算代码为空")
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise SandboxError(f"语法错误：第 {e.lineno} 行 {e.msg}") from None
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in ALLOWED_MODULES or (alias.asname and alias.asname.startswith("_")):
                    raise SandboxError(f"不允许导入 {alias.name}，只能用 {sorted(ALLOWED_MODULES)}")
        elif isinstance(node, ast.ImportFrom):
            if node.module not in MODULE_EXPORTS or node.level:
                raise SandboxError(f"不允许导入 {node.module}，只能用 {sorted(ALLOWED_MODULES)}")
            for alias in node.names:
                if alias.name not in MODULE_EXPORTS[node.module] or (alias.asname and alias.asname.startswith("_")):
                    raise SandboxError(f"不允许从 {node.module} 导入 {alias.name}")
        elif isinstance(node, ast.Name) and (node.id in FORBIDDEN_NAMES or node.id.startswith("_") and node.id != "_"):
            raise SandboxError(f"不允许使用 {node.id}")
        elif isinstance(node, ast.Attribute) and (node.attr.startswith("_") or node.attr in ("format", "format_map")):
            raise SandboxError(f"不允许访问属性 {node.attr}")
        elif isinstance(node, (ast.Global, ast.Nonlocal, ast.AsyncFunctionDef, ast.Await)):
            raise SandboxError("不允许 global、nonlocal 或异步代码")
    if not any(isinstance(n, ast.FunctionDef) and n.name == "solve" for n in tree.body):
        raise SandboxError("必须在顶层定义 solve() 函数")



def escape_newlines_in_strings(code):
    """把单行字符串里的真实换行改回 \\n。

    模型在 JSON 里写 print("a\\nb") 这类代码时，JSON 解码会把 \\n 变成真实换行，代码就出现“未结束的字符串”。
    单引号、双引号字符串里本不该有真实换行，所以可以确定地改回来；三引号字符串和注释保持不变。
    """
    out, i, n, quote = [], 0, len(code), None
    while i < n:
        ch = code[i]
        if quote is None:
            if ch == "#":
                j = code.find("\n", i)
                j = n if j < 0 else j
                out.append(code[i:j])
                i = j
                continue
            if ch in "\"'":
                if code[i:i + 3] == ch * 3:
                    j = code.find(ch * 3, i + 3)
                    j = n if j < 0 else j + 3
                    out.append(code[i:j])
                    i = j
                    continue
                quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            out.append(code[i:i + 2])
            i += 2
            continue
        if ch == "\n":
            out.append("\\n")
        else:
            if ch == quote:
                quote = None
            out.append(ch)
        i += 1
    return "".join(out)


FENCE = re.compile(r"^\s*```[A-Za-z0-9_+-]*\s*\n(.*?)\n?\s*```\s*$", re.S)


def prepare(code):
    """静态检查代码；去掉模型误加的 Markdown 代码块标记；只因字符串里的真实换行出现语法错误时，修复后再查。返回可运行的代码。"""
    if not isinstance(code, str):
        raise SandboxError("求解代码应为字符串")
    fenced = FENCE.match(code)
    if fenced:
        code = fenced.group(1)
    try:
        check_code(code)
        return code
    except SandboxError as e:
        if not str(e).startswith("语法错误"):
            raise
        fixed = escape_newlines_in_strings(code)
        if fixed == code:
            raise
        try:
            check_code(fixed)
        except SandboxError:
            raise e from None
        return fixed

RUNNER = r'''
import json, sys
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    for name in ("RLIMIT_AS", "RLIMIT_DATA"):
        try:
            limit = getattr(resource, name)
            resource.setrlimit(limit, (512 * 1024 * 1024, 512 * 1024 * 1024))
        except (AttributeError, ValueError, OSError):
            pass
    resource.setrlimit(resource.RLIMIT_NOFILE, (16, 16))
except ImportError:
    pass

EXPORTS = json.loads(sys.argv[1])
FORBIDDEN = set(sys.argv[2].split(","))
import builtins
from types import SimpleNamespace
real_import = builtins.__import__

def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name not in EXPORTS or any(item not in EXPORTS[name] for item in (fromlist or ())):
        raise ImportError("不允许导入 " + name)
    module = real_import(name)
    return SimpleNamespace(**{attr: getattr(module, attr) for attr in EXPORTS[name]})

safe = {k: v for k, v in vars(builtins).items() if k not in FORBIDDEN}
safe["__import__"] = guarded_import
safe["__build_class__"] = builtins.__build_class__
code = sys.stdin.read()
namespace = {"__builtins__": safe, "__name__": "verify"}
try:
    exec(compile(code, "<verify>", "exec"), namespace)
    result = namespace["solve"]()
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, default=str))
except BaseException as e:  # noqa: BLE001
    print(json.dumps({"ok": False, "error": type(e).__name__ + ": " + str(e)[:300]}, ensure_ascii=False))
'''


def run_code(code, timeout=TIMEOUT_SECONDS):
    """执行 solve() 并返回其结果。失败时抛出 SandboxError。"""
    check_code(code)
    with tempfile.TemporaryDirectory() as tmp:
        try:
            done = subprocess.run(
                [sys.executable, "-I", "-S", "-c", RUNNER, json.dumps(MODULE_EXPORTS), ",".join(sorted(FORBIDDEN_NAMES))],
                input=code, capture_output=True, text=True, timeout=timeout, cwd=tmp, env={},
            )
        except subprocess.TimeoutExpired:
            raise SandboxError(f"运行超过 {timeout} 秒") from None
    lines = [x for x in done.stdout.splitlines() if x.startswith("{")]
    if not lines:
        raise SandboxError(f"没有输出结果。{done.stderr[-300:]}")
    data = json.loads(lines[-1])
    if not data["ok"]:
        raise SandboxError(f"运行出错：{data['error']}")
    return data["result"]
