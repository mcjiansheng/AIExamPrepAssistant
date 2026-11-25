"""Product verification routing and three-tier results."""
from core import dump
from model import DATA_RULE, call_json, require
from workflow import items
from workflow.llm import OutputError

PROMPTS = {
    "readback": "只比较题干条件和给出的求解代码是否按相同的输入条件计算，不评解析。返回 ok、reason。",
    "v4": "结合资料逐一核对所有步骤和题干中涉及的定义与说法。reason 给出具体冲突。返回 ok、reason。",
    "v5": "独立核对这份解析的完整性；证明题、设计算法题额外核对每一步推出下一步的依据。返回 ok、reason。",
    "v6": "独立尝试证明另一个单选选项也成立。确有歧义时返回 ok=false，reason 指明选项，同时给出资料中的逐字引文 quote 和 material_id、page；否则 ok=true。",
    "v3": "独立做题，不看标准答案和解析。输出 answer。",
}


def verify(client, kind, draft, pages, saved, save, code=None):
    """Separate checks never receive unrelated evidence or the checked answer."""
    hard, soft, hints = [], [], []
    for step in draft["steps"]:
        for ref in step["refs"]:
            page = next(p for p in pages if p["material_id"] == ref["material_id"] and p["page"] == ref["page"])
            if items.norm_text(ref["quote"]) not in items.norm_text(page["text"]):
                hints.append("部分出处来自图示转写，建议查看原页")

    def ask(key, task, data):
        if key not in saved:
            def check(reply):
                if task == "v3":
                    require(isinstance(reply["answer"], str) and reply["answer"].strip(), "answer 应为非空文字")
                else:
                    require(type(reply["ok"]) is bool and isinstance(reply["reason"], str), "应给出布尔值 ok 和文字 reason")
            saved[key] = call_json(client, task, DATA_RULE + PROMPTS[task], dump(data), check)
            save()
        return saved[key]

    public = {"stem": draft["stem"], "options": draft["options"], "pages": pages}
    try:
        if kind == "calc":
            result = ask("readback", "readback", {**public, "code": code})
            if not result["ok"]:
                hard.append("题干与求解过程的条件不一致")
        for n, step in enumerate(draft["steps"], 1):
            review = {**public, "step": step}
            first = ask(f"v4_{n}", "v4", review)
            if not first["ok"]:
                second = ask(f"v4b_{n}", "v4", review)
                target = soft if not second["ok"] else hints
                target.append(f"第 {n} 步与资料可能不一致")
        if kind in ("short", "proof", "design"):
            result = ask("v5", "v5", {**public, "steps": draft["steps"]})
            if not result["ok"]:
                soft.append("解析可能遗漏了步骤")
        if kind == "single":
            result = ask("v6", "v6", public)
            if not result["ok"]:
                quote = items.norm_text(result.get("quote", ""))
                supported = any(p["material_id"] == result.get("material_id") and p["page"] == result.get("page")
                                and quote and quote in items.norm_text(p["text"]) for p in pages)
                if supported:
                    soft.append("可能有多个选项可以成立")
        if kind != "calc":
            solves = [ask("v3_0", "v3", public)]
            standard = draft["answer"]
            compare = (lambda answer: items.choice_matches(answer, standard, draft["options"])) if kind == "single" else (
                lambda answer: items.same_quantity(answer, standard)
            )
            if not compare(solves[0]["answer"]):
                solves.extend(ask(f"v3_{i}", "v3", public) for i in (1, 2))
                agrees = sum(compare(row["answer"]) for row in solves)
                if agrees != len(solves):
                    hints.append("独立作答与参考答案有出入，建议核对解析")
    except OutputError:
        hints.append("有一项模型检查多次未完成，可查看出处核对")
        return hard, soft, hints, False
    return hard, soft, hints, True
