"""Structured question generation and independent verification."""
import re

from core import dump
from model import DATA_RULE, call_json, require
from workflow import compute_first as cf, items, sandbox
from workflow.llm import OutputError

CALC = DATA_RULE + """只写计算题题干和求解代码。题干条件完整，围绕指定知识点，避免复用原题数字。
输出 {"stem":"题干","code":"def solve(): ..."}。solve() 返回
{"answer":结果,"checks":{"中间量":值},"tables":{"表名":{"header":["列"],"rows":[[值]]}}}。
使用基础 Python 数学运算和允许的数学标准库，不把最终答案写死。"""
EXPLAIN_CALC = DATA_RULE + """按题干和给出的求解结果写解析。输出 {"steps":[{"md":"步骤，可用 {{answer}} 或 {{量名}}",
"table":"可空的表名","refs":[{"material_id":"资料ID","page":1,"quote":"逐字摘抄"}]}],
"rubric":[{"point":"评分点","score":分值,"step":1}]}。
解析中的计算数字必须用 {{量名}} 占位符，表格引用代码已计算的表名。
评分点 2 到 6 条，总分必须是题目分值，step 从 1 开始。"""

DRAFT = DATA_RULE + """按指定题型、知识点和分值出一道有出处的问题。
输出 {"stem":[{"kind":"text","text":"题干"}],"options":null或["第一个选项的内容","第二个选项的内容"],"answer":"答案",
"steps":[{"blocks":[{"kind":"text","text":"解析"}],"refs":[{"material_id":"资料ID","page":1,"quote":"逐字摘抄"}]}],
"rubric":null或[{"point":"评分点","score":分值,"step":1}]}。
至少有一个真实资料引用。单选给 4 个不同选项和字母答案，选项只写内容，不要加“A.”之类的字母。填空只有一个明确答案。主观题给 2 到 6 个评分点且分值和等于满分，step 从 1 开始。
可用文本、公式、代码块和表格（{"kind":"table","header":[],"rows":[[]]}）。"""


class CalculationFailed(Exception):
    pass


def valid_text(value, key):
    require(isinstance(value, str) and value.strip(), f"{key} 应为非空文字")


def block_check(block):
    require(isinstance(block, dict), "每个块应为对象")
    kind = block["kind"]
    require(kind in ("text", "table", "code", "formula"), "未知的块类型")
    if kind == "table":
        header, rows = block["header"], block["rows"]
        require(isinstance(header, list) and all(isinstance(x, str) for x in header), "表头应为文字数组")
        require(isinstance(rows, list) and all(isinstance(row, list) and len(row) == len(header)
                                              and all(isinstance(x, str) for x in row) for row in rows), "表格各行应与表头同列数")
    else:
        valid_text(block["text"], "text")


def blocks_check(blocks):
    require(isinstance(blocks, list) and blocks, "需要至少一个内容块")
    for block in blocks:
        block_check(block)


def refs_check(refs, pages):
    require(isinstance(refs, list), "refs 应为数组")
    for ref in refs:
        require(isinstance(ref, dict) and type(ref["page"]) is int, "出处应为资料 ID、整数页码和引文")
        key = ref["material_id"], ref["page"]
        require(key in pages, f"引用了第 {ref['page']} 页，这道题只能引用这些页：{'、'.join(str(p) for _, p in sorted(pages))}")
        valid_text(ref["quote"], "引文")
        normalized = items.norm_text(ref["quote"])
        source = pages[key]
        require(normalized and (normalized in items.norm_text(source["text"])
                                or normalized in items.norm_text(source["vision"] or "")),
                f"引文“{ref['quote'][:40]}”没有逐字出现在第 {ref['page']} 页，引文要从该页原文里原样摘一句，不要改写")


def rubric_check(rubric, kind, score, steps):
    if kind in ("single", "fill"):
        require(rubric is None, "客观题的 rubric 应为 null")
        return
    require(isinstance(rubric, list) and 2 <= len(rubric) <= 6, "应有 2 到 6 个评分点")
    for row in rubric:
        valid_text(row["point"], "评分要点")
        require(type(row["score"]) in (int, float) and 0 <= row["score"] <= score,
                f"评分点“{row['point'][:20]}”的分值 {row['score']} 不对，应是 0 到 {score} 之间的数")
        require(type(row["step"]) is int and 1 <= row["step"] <= len(steps),
                f"评分点“{row['point'][:20]}”引用了第 {row['step']} 步，解析只有 {len(steps)} 步")
    total = sum(row["score"] for row in rubric)
    require(abs(total - score) < 1e-8, f"评分点分值之和是 {total:g}，要等于题目分值 {score:g}")


def draft(client, spec, comments, saved, save):
    kind, score = spec["type"], spec["score"]
    pages = {(p["material_id"], p["page"]): p for p in spec["pages"]}
    packet = {**spec, "review": comments}
    if kind == "calc":
        return calculation(client, packet, pages, saved, save)

    def check(data):
        blocks_check(data["stem"])
        valid_text(data["answer"], "答案")
        options = data["options"]
        if kind == "single":
            require(isinstance(options, list) and len(options) == 4 and all(isinstance(s, str) and s.strip() for s in options),
                    "单选题应有四个文字选项")
            # 模型有时仍给选项带上“A. ”，界面另有字母标记，去掉重复的前缀
            marks = [re.match(rf"\s*[(（]?{letter}[)）.、．:：]\s*", text) for letter, text in zip("ABCD", options)]
            if all(marks):
                options[:] = [text[mark.end():] for text, mark in zip(options, marks)]
            require(len(set(map(items.norm_text, options))) == 4, "单选选项内容不得重复")
            require(data["answer"] in items.letters(len(options)), "单选答案应为选项字母")
        else:
            require(options is None, "非单选题的 options 应为 null")
        steps = data["steps"]
        require(isinstance(steps, list) and steps, "解析应有步骤")
        for step in steps:
            blocks_check(step["blocks"])
            refs_check(step["refs"], pages)
        require(any(step["refs"] for step in steps), "解析至少要引用一段资料原文")
        rubric_check(data["rubric"], kind, score, steps)

    data = call_json(client, "question", DRAFT, dump(packet), check)
    return data, []


def calculation(client, spec, pages, saved, save):
    if "computed" not in saved:
        results = {}

        def check(data):
            valid_text(data["stem"], "计算题题干")
            try:
                code = sandbox.prepare(data["code"])
                answer = sandbox.run_code(code)
            except sandbox.SandboxError as error:
                raise ValueError(f"求解代码运行失败：{error}") from None
            cf.check_result(answer)
            results.update(stem=data["stem"], code=code, computed=answer)

        try:
            call_json(client, "cfproblem", CALC, dump(spec), check)
        except OutputError as error:
            if "求解代码" in str(error) or "solve()" in str(error):
                raise CalculationFailed(str(error)) from None
            raise
        saved.update(results)
        save()

    stem, computed = saved["stem"], saved["computed"]
    checks, tables = cf.check_result(computed)

    def check_explain(data):
        steps = data["steps"]
        require(isinstance(steps, list) and steps, "计算解析应有步骤")
        allowed = sorted(checks) + ["answer"]
        for step in steps:
            valid_text(step["md"], "解析步骤")
            unknown = sorted(set(cf.PLACEHOLDER.findall(step["md"])) - set(allowed))
            require(not unknown, f"解析里的 {'、'.join('{{' + name + '}}' for name in unknown)} 不是求解结果里的量，"
                                 f"占位符只能用：{'、'.join('{{' + name + '}}' for name in allowed)}")
            require(step["table"] is None or step["table"] in tables,
                    f"解析引用的表格 {step['table']} 不在求解结果里，"
                    + (f"可用的表格：{'、'.join(tables)}" if tables else "这道题没有表格，table 填 null"))
            refs_check(step["refs"], pages)
        require(any(step["refs"] for step in steps), "解析至少要引用一段资料原文")
        rubric_check(data["rubric"], "calc", spec["score"], steps)

    data = call_json(client, "cfexplain", EXPLAIN_CALC,
                     dump({**spec, "stem": stem, "code": saved["code"], "result": computed}), check_explain)
    steps, leaked = cf.filled_steps(stem, computed, data["steps"])
    warnings = ["解析有未从求解结果填入的数字，建议核对"] if leaked else []
    return {"stem": [{"kind": "text", "text": stem}], "answer": cf.fmt(computed["answer"]),
            "options": None, "steps": steps, "rubric": data["rubric"]}, warnings
