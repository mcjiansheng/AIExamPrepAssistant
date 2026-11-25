"""Calculation and explanation substitution adapted from compute_first.py."""
import re

from model import require

PLACEHOLDER = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
NUMBER = re.compile(r"(?<![A-Za-z_\d.])\d+(?:\.\d+)?")


def fmt(value):
    """执行结果转成解析里的写法。"""
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, float):
        return str(int(value)) if value == int(value) else f"{value:.4f}".rstrip("0").rstrip(".")
    if isinstance(value, (list, tuple)):
        return "、".join(fmt(v) for v in value)
    if isinstance(value, dict):
        return "；".join(f"{k}={fmt(v)}" for k, v in value.items())
    return str(value)


def cell(value):
    """表格单元格的写法：向量写成 (2, 3, 3)，小数保留 4 位，布尔量写成 是/否。"""
    if isinstance(value, (list, tuple)):
        return "(" + ", ".join(fmt(v) for v in value) + ")"
    return fmt(value)


CODE_TALK = re.compile(r"执行结果|占位符|代码|len\(|==|solve\(")


def check_result(result):
    """求解代码的返回值必须能直接用于填充解析。"""
    require(isinstance(result, dict) and "answer" in result, "solve() 必须返回包含 answer 的字典")
    require(str(result["answer"]).strip() not in ("", "None"), "answer 不能为空")
    checks, tables = result.get("checks") or {}, result.get("tables") or {}
    require(isinstance(checks, dict), "checks 必须是非空字典，列出解析会提到的中间结果")
    require(isinstance(tables, dict), "tables 必须是字典")
    for name, table in tables.items():
        require(isinstance(table, dict) and isinstance(table.get("rows"), list) and table["rows"], f"表 {name} 必须是 {{header, rows}} 且有数据行")
        width = len(table.get("header") or table["rows"][0])
        require(all(isinstance(r, list) and len(r) == width for r in table["rows"]), f"表 {name} 各行列数不一致")
    return checks, tables

def leaked_numbers(steps, stem):
    """解析中模型自己写的数值：不是占位符，也不在题干里。10 以下的整数多半是序号，不统计。"""
    given = set(NUMBER.findall(stem))
    found = []
    for step in steps:
        text = PLACEHOLDER.sub("", str(step.get("md") or ""))
        found += [n for n in NUMBER.findall(text) if n not in given and ("." in n or int(n) >= 10)]
    return found



def filled_steps(stem, computed, steps):
    checks, tables = check_result(computed)
    values = {key: fmt(value) for key, value in checks.items()}
    values["answer"] = fmt(computed["answer"])
    result = []
    for step in steps:
        text = PLACEHOLDER.sub(lambda match: values[match.group(1)], step["md"])
        blocks = [{"kind": "text", "text": text}]
        if step["table"] is not None:
            table = tables[step["table"]]
            blocks.append({"kind": "table", "header": [cell(value) for value in table["header"]],
                           "rows": [[cell(value) for value in row] for row in table["rows"]]})
        result.append({"blocks": blocks, "refs": step["refs"]})
    return result, leaked_numbers(steps, stem)
