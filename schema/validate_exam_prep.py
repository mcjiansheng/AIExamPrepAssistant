#!/usr/bin/env python3
"""校验备考数据 v0.2：JSON Schema + 三级知识的跨对象规则 + 违规用例自测。"""
import copy
import json
import sys
from pathlib import Path


BASE = Path(__file__).resolve().parent
RANK = {"personal": 0, "campus": 1, "shared": 2}
NAMES = ["personal", "campus", "shared"]


class Index:
    def __init__(self, data):
        self.users = {x["id"]: x for x in data["users"]}
        self.offerings = {x["id"]: x for x in data["course_offerings"]}
        self.materials = {x["id"]: x for x in data["materials"]}
        self.points = {x["id"]: x for x in data["knowledge_points"]}
        self.links = {x["id"]: x for x in data["personal_links"]}
        self.signals = {x["id"]: x for x in data["signals"]}
        self.blueprints = {x["id"]: x for x in data["exam_blueprints"]}
        self.policies = data["sharing_policies"]
        self.enrollments = data["enrollments"]
        self.course_links = {
            frozenset((x["offering_a"], x["offering_b"]))
            for x in data["course_links"]
            if x["status"] == "confirmed"
        }

    def user_offerings(self, user_id, verified_only=True):
        return [
            self.offerings[e["offering_id"]]
            for e in self.enrollments
            if e["user_id"] == user_id
            and e["offering_id"] in self.offerings
            and (e["status"] == "verified" or not verified_only)
        ]

    def applicable_policies(self, material):
        offering = self.offerings[material["offering_id"]]
        owner = self.users[material["owner_user_id"]]
        matched = []
        for p in self.policies:
            if p["status"] == "revoked" or p["institution"] != offering["institution"]:
                continue
            if material["kind"] not in p["applies_to_kinds"]:
                continue
            kind, value = p["scope_type"], p.get("scope_value")
            if (
                kind == "institution"
                or (kind == "department" and offering.get("department") == value)
                or (kind == "major" and owner.get("major") == value)
                or (kind == "course" and offering["course_name"] == value)
                or (kind == "instructor" and offering.get("instructor") == value)
                or (kind == "offering" and offering["id"] == value)
            ):
                matched.append(p)
        return matched

    def limits(self, material):
        """返回该资料允许到达的 (信号上限, 文本上限)。"""
        sharing = material["sharing"]
        owner = self.users[material["owner_user_id"]]
        if owner["verification"]["status"] != "verified":
            return 0, 0
        if material["exam_status"] in ("current_term", "unknown"):
            return 0, 0
        if sharing["review_status"] != "approved" or "attestation" not in sharing:
            return 0, 0

        policies = self.applicable_policies(material)
        has_grant = any(p["status"] == "verified" for p in policies)
        basis = sharing["rights_basis"]
        if material["kind"] == "past_exam" and not has_grant:
            return 0, 0
        if basis == "own_work":
            signal, text = RANK["shared"], RANK["campus"]
        elif basis == "open_license":
            signal, text = RANK["shared"], RANK["shared"]
        elif basis == "instructor_permission" and has_grant:
            signal, text = RANK["shared"], RANK["shared"]
        else:
            return 0, 0

        # verified 与 pending 都能收紧，只有 verified 能放行。
        for p in policies:
            signal = min(signal, RANK[p["max_signal_tier"]])
            text = min(text, RANK[p["max_text_tier"]])
        return signal, text

    def eligible(self, user_id, audience, institution):
        user = self.users.get(user_id)
        if not user or user["verification"]["status"] != "verified" or user["institution"] != institution:
            return False
        scope, ref = audience["scope"], audience["ref"]
        if scope == "major":
            return user.get("major") == ref
        offerings = [o for o in self.user_offerings(user_id) if o["institution"] == institution]
        if scope == "offering":
            return any(o["id"] == ref for o in offerings)
        if scope == "course":
            return any(o["course_name"] == ref for o in offerings)
        return any(o.get("instructor") == ref for o in offerings)

    def can_read_text(self, user_id, material):
        if material["owner_user_id"] == user_id:
            return True
        sharing = material["sharing"]
        if sharing["form"] != "text" or RANK[sharing["tier"]] > self.limits(material)[1]:
            return False
        if sharing["tier"] == "campus":
            institution = self.offerings[material["offering_id"]]["institution"]
            return self.eligible(user_id, sharing["audience"], institution)
        if sharing["tier"] == "shared":
            return self.users[user_id]["verification"]["status"] == "verified"
        return False


def validate(data, schema):
    from jsonschema import Draft202012Validator

    errors = [
        f"schema: {'/'.join(map(str, e.absolute_path))}: {e.message}"
        for e in Draft202012Validator(schema).iter_errors(data)
    ]
    if errors:
        return errors

    ix = Index(data)

    for e in ix.enrollments:
        if e["user_id"] not in ix.users or e["offering_id"] not in ix.offerings:
            errors.append(f"选课记录引用了不存在的对象：{e['user_id']} / {e['offering_id']}")

    for m in ix.materials.values():
        if m["owner_user_id"] not in ix.users or m["offering_id"] not in ix.offerings:
            errors.append(f"{m['id']}: 上传者或课程不存在")
            continue
        sharing = m["sharing"]
        if sharing["tier"] == "personal":
            continue
        signal_limit, text_limit = ix.limits(m)
        limit = text_limit if sharing["form"] == "text" else signal_limit
        if RANK[sharing["tier"]] > limit:
            errors.append(f"{m['id']}: 申请范围 {sharing['tier']} 超出允许上限 {NAMES[limit]}")

    for s in ix.signals.values():
        if s["status"] != "active":
            continue
        tier_rank = RANK[s["tier"]]
        owners = set()
        for material_id in s["derived_from_material_ids"]:
            m = ix.materials.get(material_id)
            if m is None:
                errors.append(f"{s['id']}: 信号来源 {material_id} 不存在")
                continue
            owners.add(m["owner_user_id"])
            sharing = m["sharing"]
            if (
                sharing["form"] == "none"
                or RANK[sharing["tier"]] < tier_rank
                or ix.limits(m)[0] < tier_rank
            ):
                errors.append(f"{s['id']}: 信号来源 {material_id} 已不允许进入 {s['tier']} 级，需撤回或重算")
            if sharing["tier"] == "campus" and sharing.get("audience") != s.get("audience"):
                errors.append(f"{s['id']}: 信号范围与来源 {material_id} 的可见范围不一致")
            if m["offering_id"] not in s["offering_ids"]:
                errors.append(f"{s['id']}: 来源 {material_id} 不属于信号声明的课程")
        if len(owners) != s["contributor_count"]:
            errors.append(f"{s['id']}: 声明贡献者 {s['contributor_count']} 人，实际 {len(owners)} 人")
        if s["tier"] == "campus":
            institutions = {ix.offerings[o]["institution"] for o in s["offering_ids"] if o in ix.offerings}
            if len(institutions) != 1:
                errors.append(f"{s['id']}: 校内信号不能跨学校")

    for k in ix.points.values():
        for ref in k["source_refs"]:
            m = ix.materials.get(ref["material_id"])
            if m is None or not ix.can_read_text(k["owner_user_id"], m):
                errors.append(f"{k['id']}: 无权引用资料 {ref['material_id']}")

    for link in ix.links.values():
        a, b = ix.points.get(link["from_knowledge_point_id"]), ix.points.get(link["to_knowledge_point_id"])
        if not a or not b or a["owner_user_id"] != link["user_id"] or b["owner_user_id"] != link["user_id"]:
            errors.append(f"{link['id']}: 个人知识网络只能连接用户本人的知识点")
        elif a["offering_id"] == b["offering_id"]:
            errors.append(f"{link['id']}: 个人跨课程链接必须连接不同课程")

    for b in ix.blueprints.values():
        offering = ix.offerings.get(b["offering_id"])
        if offering is None:
            errors.append(f"{b['id']}: 课程不存在")
            continue
        if not any(o["id"] == b["offering_id"] for o in ix.user_offerings(b["user_id"], verified_only=False)):
            errors.append(f"{b['id']}: 用户未选这门课")
        for section in b["sections"]:
            for kp_id in section["knowledge_point_ids"]:
                k = ix.points.get(kp_id)
                if not k or k["owner_user_id"] != b["user_id"] or k["offering_id"] != b["offering_id"]:
                    errors.append(f"{b['id']}: 知识点 {kp_id} 超出本课程考试范围")
        for signal_id in b["signal_ids_used"]:
            s = ix.signals.get(signal_id)
            if s is None or s["status"] != "active":
                errors.append(f"{b['id']}: 信号 {signal_id} 不存在或已撤回")
            elif s["tier"] == "campus":
                institution = ix.offerings[s["offering_ids"][0]]["institution"]
                if not ix.eligible(b["user_id"], s["audience"], institution):
                    errors.append(f"{b['id']}: 用户不在校内信号 {signal_id} 的可见范围内")
            elif b["offering_id"] not in s["offering_ids"] and not any(
                frozenset((b["offering_id"], o)) in ix.course_links for o in s["offering_ids"]
            ):
                errors.append(f"{b['id']}: 共享信号 {signal_id} 与目标课程没有已确认的关联")

    for q in data["questions"]:
        b = ix.blueprints.get(q["blueprint_id"])
        if b is None:
            errors.append(f"{q['id']}: 试卷蓝图不存在")
            continue
        scope = {k for section in b["sections"] for k in section["knowledge_point_ids"]}
        if q["knowledge_point_id"] not in scope:
            errors.append(f"{q['id']}: 考点超出试卷范围")
        for ref in q["source_refs"]:
            m = ix.materials.get(ref["material_id"])
            if m is None or not ix.can_read_text(b["user_id"], m):
                errors.append(f"{q['id']}: 无权引用资料 {ref['material_id']}")
        note = q.get("cross_course_note")
        if note:
            link = ix.links.get(note["personal_link_id"])
            if (
                not link
                or link["user_id"] != b["user_id"]
                or link["status"] != "confirmed"
                or q["knowledge_point_id"] not in (link["from_knowledge_point_id"], link["to_knowledge_point_id"])
            ):
                errors.append(f"{q['id']}: 跨课程解析必须使用本人已确认且与本题相关的链接")

    return errors


def material(data, material_id):
    return next(x for x in data["materials"] if x["id"] == material_id)


def self_test(example, schema):
    deny_notes = {
        "id": "policy_deny_notes", "institution": "南京大学", "scope_type": "instructor", "scope_value": "教师甲",
        "applies_to_kinds": ["notes"], "max_signal_tier": "personal", "max_text_tier": "personal",
        "decided_by_role": "instructor", "status": "verified",
    }

    def edit_policy(d, **kw):
        d["sharing_policies"][0].update(kw)

    cases = [
        ("权利依据未知却共享", lambda d: material(d, "material_a_notes")["sharing"].update(rights_basis="unknown"), "schema"),
        ("未经用户确认却共享", lambda d: material(d, "material_a_notes")["sharing"].pop("attestation"), "schema"),
        ("本学期试卷参与共享", lambda d: material(d, "material_a_notes").update(kind="past_exam", exam_status="current_term"), "schema"),
        ("信号贡献者不足 3 人", lambda d: d["signals"][0].update(contributor_count=2), "schema"),
        ("信号携带原文", lambda d: d["signals"][0].update(text="资料原文"), "schema"),
        ("声明的贡献者数与来源不符", lambda d: d["signals"][0].update(contributor_count=4), "声明贡献者"),
        ("教师拒绝后信号仍生效", lambda d: d["sharing_policies"].append(deny_notes), "需撤回或重算"),
        ("待审核的拒绝先生效", lambda d: d["sharing_policies"].append({**deny_notes, "status": "pending"}), "需撤回或重算"),
        ("待审核的授权不能放行", lambda d: edit_policy(d, status="pending"), "超出允许上限"),
        ("学生声称有授权但无策略", lambda d: d["sharing_policies"].pop(0), "超出允许上限"),
        ("教师只允许校内却申请跨校文本", lambda d: material(d, "material_b_slides")["sharing"].update(tier="shared") or material(d, "material_b_slides")["sharing"].pop("audience"), "超出允许上限"),
        ("非可见范围用户引用校内文本", lambda d: d["enrollments"].remove({"user_id": "user_c", "offering_id": "offering_nju_math_cs", "status": "verified"}), "无权引用"),
        ("外校用户引用校内文本", lambda d: d["questions"][0]["source_refs"].__setitem__(0, {"material_id": "material_b_slides"}), "无权引用"),
        ("引用他人未授权资料", lambda d: d["questions"][0]["source_refs"].__setitem__(0, {"material_id": "material_a_notes"}), "无权引用"),
        ("外校用户使用校内信号", lambda d: d["exam_blueprints"][0]["signal_ids_used"].append("signal_taylor_campus"), "可见范围"),
        ("共享信号跨到未关联课程", lambda d: d["course_links"].clear(), "没有已确认的关联"),
        ("未验证用户共享", lambda d: d["users"][0]["verification"].update(status="pending"), "超出允许上限"),
        ("跨课程知识点混入考试范围", lambda d: d["exam_blueprints"][2]["sections"][0]["knowledge_point_ids"].append("kp_a_java_interface"), "超出本课程考试范围"),
        ("个人链接连接他人知识点", lambda d: d["personal_links"][0].update(to_knowledge_point_id="kp_d_taylor"), "用户本人"),
        ("未确认的链接用于解析", lambda d: d["personal_links"][0].update(status="candidate"), "已确认"),
    ]

    failed = []
    for name, fn, expected in cases:
        data = copy.deepcopy(example)
        fn(data)
        errors = validate(data, schema)
        ok = any(expected in e for e in errors)
        print(f"{'通过' if ok else '失败'}  应被拒绝：{name}")
        if not ok:
            failed.append(name)
            for error in errors or ["（没有报错）"]:
                print(f"      实际：{error}")
    print(f"违规用例：{len(cases) - len(failed)}/{len(cases)} 按预期原因被拒绝")
    return failed


def main():
    schema = json.loads((BASE / "exam-prep-schema.json").read_text(encoding="utf-8"))
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else BASE / "exam-prep-example.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    errors = validate(data, schema)
    for error in errors:
        print(error)
    print(f"示例数据：{'有效' if not errors else '无效'}")
    failed = self_test(data, schema) if not errors else []
    sys.exit(1 if errors or failed else 0)


if __name__ == "__main__":
    main()
