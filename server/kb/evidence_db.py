"""个人知识库的笔记、证据和知识点关系（设计修订 v2 第 2.8 节）。只依赖标准库，不调用模型。

一、课件备注栏（讲稿）单独保存，并分成三类。

原型导入时把备注栏标成“[讲稿]”接在页面文字后面。实际上备注栏里混着三种内容：
- judgment 判断：对重要度和考法的评价，例如“一道大题”“不会单独考察”“不需要记忆但要理解”。多是学生自己记的。
- explanation 讲解：对内容的补充说明，例如证明思路。多是课件原作者留的。
- other 其他：模板文字，例如“欢迎辞”。

这里先用规则分类（origin = rule），之后可由模型重新分类（workflow/evidence.py notes --model，origin = model）。
页面正文（units.text）保持不变，仍然包含备注栏：去掉它会改变内容哈希，已有的知识点和题目引用会全部失效。
判断类备注另外转成“证据”（workflow/evidence.py），讲解类本来就在正文里，相当于已经并入内容。
"""
import re

NOTE = re.compile(r"\[讲稿\]\s*(.+)", re.S)

MODES = {"memory": "记忆", "understand": "理解", "compute": "计算与模拟", "design": "设计", "proof": "证明",
         "linked": "联动", "major": "大题"}
TYPES = {"judgment": "判断", "explanation": "讲解", "other": "其他"}

# 学生笔记里常见的说法 → 级别和考法。只是基线规则，覆盖不了说法的变化，正式做法由模型归类。
# 级别为 None 表示这句话只说了“怎么考”，没说“重不重要”：例如“不会单独考察”的知识点级别不降，只是会和别的知识点一起考。
PHRASES = [
    (r"大题", "emphasized", ["major"]),
    (r"不会单独\s*考", None, ["linked"]),
    (r"不需要记忆.*理解|不用背|不需要背", None, ["understand"]),
    (r"重点理解", "emphasized", ["understand"]),
    (r"不能\s*写错|要背|背下来|默写", "emphasized", ["memory"]),
    (r"不考|不作要求", "excluded", []),
    (r"重点|重要|必考", "emphasized", []),
]


def split_note(text):
    """把一页文字分成 (正文, 备注)。没有备注时备注为空字符串。"""
    found = NOTE.search(text)
    if not found:
        return text, ""
    return text[:found.start()].rstrip(), found.group(1).strip()


def rule_classify(note):
    """返回 (类型, 级别, 考法)。判断类必须短，且命中某个说法。"""
    matched, level, modes = False, None, []
    for pattern, lv, md in PHRASES:
        if re.search(pattern, note):
            matched, level, modes = True, lv, md
            break
    if matched and len(note) <= 30:
        return "judgment", level, modes
    if len(note) <= 6:
        return "other", None, []
    return "explanation", None, []


LEVEL_RANK = {"mentioned": 1, "emphasized": 2}
SOURCE_RANK = {"user": 0, "teacher": 1, "note": 2, "assignment": 3, "past_paper": 3, "model": 4}
PLACEMENT_RANK = {"direct": 0, "nearby": 1, "document": 2}
ACTIVE = {"active"}


def merge_levels(levels):
    """只有不考就取不考；不考与强调同时出现时标为冲突，交给用户确认；否则取最高。"""
    found = set(levels)
    if not found:
        return None
    if found == {"excluded"}:
        return "excluded"
    if "excluded" in found and "emphasized" in found:
        return "conflict"
    return max(found - {"excluded"}, key=LEVEL_RANK.get)


def derive(points, evidence, scoped_materials):
    """按 2.8 节的规则，从证据算出每个知识点的级别、考法和依据。

    points：知识点列表；evidence：证据列表（字典，kp_ids、level、modes 已解析）；
    依据分五种：有证据（给出了级别）、只有考法、作业考过、范围内未提及、依据有限。
    scoped_materials：有判断类笔记的资料。证据只在覆盖范围内起作用：这些资料里没被提到的知识点是“范围内未提及”，
    其余没有证据的知识点是“依据有限”，不当作“老师没强调”。
    """
    by_kp = {}
    for e in evidence:
        if e["status"] in ACTIVE:
            for k in e["kp_ids"]:
                by_kp.setdefault(k, []).append(e)
    out = {}
    for k in points:
        mine = by_kp.get(k["id"], [])
        with_level = [e for e in mine if e["level"]]
        level, decided_by = None, []
        if with_level:
            best = min((SOURCE_RANK[e["source_kind"]], PLACEMENT_RANK[e["placement"]]) for e in with_level)
            decided_by = [e for e in with_level if (SOURCE_RANK[e["source_kind"]], PLACEMENT_RANK[e["placement"]]) == best]
            level = merge_levels(e["level"] for e in decided_by)
        # 整份资料上的考法（例如标题页的“一道大题”）说的是这一章会出一道大题，不是每个知识点都是大题，单独记。
        modes = sorted({m for e in mine if e["placement"] != "document" for m in e["modes"]})
        document_modes = sorted({m for e in mine if e["placement"] == "document" for m in e["modes"]})
        if level:
            basis = "有证据"
        elif modes:
            basis = "只有考法"
        elif mine:  # 例如作业考过，但没说重不重要、怎么考
            basis = "作业考过" if any(e["source_kind"] == "assignment" for e in mine) else "有弱证据"
        elif k["material_id"] in scoped_materials:
            basis = "范围内未提及"
        else:
            basis = "依据有限"
        out[k["id"]] = {"level": level, "modes": modes, "document_modes": document_modes, "basis": basis, "sources": sorted({e["source_kind"] for e in mine}),
                        "decided_by": [e["id"] for e in decided_by], "evidence": [e["id"] for e in mine]}
    return out
