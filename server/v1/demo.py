"""Import the shared, authored demonstration content into each user's own rows."""

import json
import math
import re
import secrets
from datetime import datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .auth import Principal
from .courses import create_course
from .db import dump, utc_now
from .focus import levels, seed_focus


FIXTURE = Path(__file__).with_name("seed") / "demo-content.json"


def identifier(prefix):
    return f"{prefix}_{secrets.token_hex(16)}"


def insert(conn, table, row):
    columns = ",".join(row)
    placeholders = ",".join("?" for _ in row)
    conn.execute(f"INSERT INTO {table}({columns}) VALUES({placeholders})", tuple(row.values()))


def text_block(value):
    return {"kind": "text", "text": value}


def sentences(value):
    return [part.strip() for part in re.split(r"(?<=[。；])", value) if part.strip()]


def first_clause(value):
    return re.split(r"[，；。]", value, maxsplit=1)[0].strip()


def seed_user(conn, user_id, kind):
    content = json.loads(FIXTURE.read_text(encoding="utf-8"))
    row = conn.execute("SELECT timezone,guest FROM users WHERE id=?", (user_id,)).fetchone()
    user = Principal(user_id, "", row["timezone"], bool(row["guest"]))
    now = utc_now()
    today = now.astimezone(ZoneInfo(user.timezone)).date()
    if kind != "demo":
        return [seed_course(conn, user, content["courses"]["os"], today + timedelta(days=12),
                            0, True, content["focus_words"], now)]

    courses = [seed_course(conn, user, content["courses"][key], today + timedelta(days=days),
                           color, False, content["focus_words"], now)
               for key, days, color in (("math", 3, 1), ("os", 6, 0), ("ds", 13, 3))]
    for course, mix in zip(courses, ((0.55, 0.15, 0.12, 2), (0.32, 0.14, 0.10, 3), (0.14, 0.10, 0.08, 0))):
        seed_history(conn, user, course, mix, now)
    seed_personal_data(conn, user, courses, now)
    return courses


def seed_course(conn, user, content, exam_date, color, sample, words, now):
    course = create_course(conn, user, content["name"], exam_date.isoformat(), color,
                           sample=sample, seed_key=content["key"], created_at=now.isoformat(),
                           exam_format={**content["format"], "basis": "teacher"})
    course_id = course["id"]
    materials = {}
    for source in content["materials"]:
        material = {
            "id": identifier("m"), "user_id": user.id, "course_id": course_id,
            "title": source["title"], "kind": source["kind"], "source": "file",
            "pages": source["pages"], "status": "ready", "stage": None, "progress": 1,
            "vision": "done", "superseded_by": None, "decision": None,
            "skipped_pages": dump([]), "error": None, "uploaded_at": now.isoformat(),
            "storage_extension": None,
        }
        insert(conn, "materials", material)
        materials[source["key"]] = material
    pages = {}
    cursor = {}
    kps = []
    topics = []
    for chapter_index, source_chapter in enumerate(content["chapters"]):
        chapter_id = identifier("ch")
        insert(conn, "chapters", {"id": chapter_id, "user_id": user.id, "course_id": course_id,
                                 "title": source_chapter["title"], "position": chapter_index})
        material = materials[source_chapter["material"]]
        for topic_index, source_topic in enumerate(source_chapter["topics"]):
            topic = {"id": identifier("tp"), "user_id": user.id, "course_id": course_id,
                     "chapter_id": chapter_id, "title": source_topic["title"], "position": topic_index,
                     "minutes": max(15, source_topic["pages"] * 2
                                    + sum("compute" in kp.get("modes", []) for kp in source_topic["kps"]) * 10),
                     "homework": int(source_topic.get("homework", False))}
            topics.append(topic)
            insert(conn, "topics", topic)
            start = cursor.get(material["id"], 3)
            cursor[material["id"]] = start + source_topic["pages"]
            pages[(material["id"], start)] = {
                "title": topic["title"],
                "lines": [f"{source_chapter['title']} · {topic['title']}"] + [kp["t"] for kp in source_topic["kps"]],
            }
            for index, source_kp in enumerate(source_topic["kps"]):
                page = start + 1 + math.floor(index * max(1, source_topic["pages"] - 1) / len(source_topic["kps"]))
                authored = content["explain"].get(source_kp["t"])
                siblings = [kp["t"] for kp in source_topic["kps"] if kp["t"] != source_kp["t"]]
                blocks = authored or [[text_block(source_kp["s"])]]
                if not authored and siblings:
                    blocks.append([text_block(f"它属于「{topic['title']}」，这一节还有：{'、'.join(siblings)}。")])
                kp = {"id": identifier("kp"), "user_id": user.id, "course_id": course_id,
                      "title": source_kp["t"], "chapter_id": chapter_id, "topic_id": topic["id"],
                      "position": len(kps), "summary": source_kp["s"],
                      "modes": dump(source_kp.get("modes", ["understand"])), "blocks": dump(blocks)}
                insert(conn, "knowledge_points", kp)
                insert(conn, "kp_progress", {"kp_id": kp["id"], "user_id": user.id})
                kp["refs"] = [{"material_id": material["id"], "material_title": material["title"],
                               "page": page, "quote": None}]
                kps.append(kp)
                if (material["id"], page) in pages:
                    pages[(material["id"], page)]["lines"] += [kp["title"], *sentences(kp["summary"])]
                else:
                    pages[(material["id"], page)] = {"title": kp["title"], "lines": sentences(kp["summary"])}

    for material in materials.values():
        if material["kind"] in ("homework", "review"):
            related = [kp for kp in kps if (any(mode in json.loads(kp["modes"]) for mode in ("major", "proof"))
                       if material["kind"] == "review" else next(topic for topic in topics if topic["id"] == kp["topic_id"])["homework"])]
            for index, kp in enumerate(related):
                page = index + 2
                pages[(material["id"], page)] = {"title": f"第 {index + 1} 题 · {kp['title']}",
                                                "lines": [f"结合课件完成：{kp['summary']}"]}
                kp["refs"].append({"material_id": material["id"], "material_title": material["title"], "page": page, "quote": None})
            cursor[material["id"]] = len(related) + 2
        total = max(material["pages"], cursor.get(material["id"], 3) - 1)
        conn.execute("UPDATE materials SET pages=? WHERE id=?", (total, material["id"]))
        material["pages"] = total
        chapter_titles = [chapter["title"] for chapter in content["chapters"]
                          if materials[chapter["material"]]["id"] == material["id"]]
        pages[(material["id"], 1)] = {"title": re.sub(r"\.\w+$", "", material["title"]),
                                     "lines": [content["name"], *chapter_titles]}
        if (material["id"], 2) not in pages:
            topic_titles = [topic["title"] for topic in topics
                            if any(mid == material["id"] and value["title"] == topic["title"] for (mid, _), value in pages.items())]
            pages[(material["id"], 2)] = {"title": "目录", "lines": topic_titles}
        for page in range(3, total + 1):
            pages.setdefault((material["id"], page), {"title": "小结与习题", "lines": ["回顾本节的要点，完成课后习题。"]})
    for (material_id, page), value in pages.items():
        insert(conn, "material_pages", {"material_id": material_id, "user_id": user.id, "page": page,
                                        "title": value["title"], "text": "\n".join([value["title"], *value["lines"]]),
                                        "image_path": None})
    for kp in kps:
        for position, ref in enumerate(kp["refs"]):
            insert(conn, "kp_refs", {"id": identifier("ref"), "user_id": user.id, "kp_id": kp["id"],
                                     "material_id": ref["material_id"], "page": ref["page"], "quote": None,
                                     "position": position})
    bank = seed_bank(conn, user, course_id, content, kps)
    seed_focus(conn, user.id, course_id, content["focus"], content["key"], words)
    return {"id": course_id, "key": content["key"], "name": content["name"], "kps": kps, "bank": bank}


def seed_bank(conn, user, course_id, content, kps):
    bank = []

    def add(kp, question, authored):
        refs = kp["refs"]
        rubric = [{"id": f"r{index + 1}", "point": point, "score": score}
                  for index, (point, score) in enumerate(question.get("rubric", []))] or None
        solution = {"answer": question["answer"], "steps": [
            {"n": index + 1, "blocks": blocks, "refs": refs} for index, blocks in enumerate(question["steps"])],
                    "rubric": rubric}
        row = {"id": identifier("q"), "user_id": user.id, "course_id": course_id, "kp_id": kp["id"],
               "type": question["type"], "score": question["score"], "stem": dump(question["stem"]),
               "options": dump([{"id": key, "text": value} for key, value in question["options"]]) if question.get("options") else None,
               "answer": question.get("key", question["answer"]), "solution": dump(solution),
               "hints": dump(question["hints"]), "refs": dump(refs), "authored": int(authored),
               "check_state": "passed", "check_note": None}
        insert(conn, "bank_questions", row)
        bank.append(row)

    for question in content["questions"]:
        kp = next(kp for kp in kps if kp["title"] == question["kp"])
        add(kp, question, True)
    for kp in kps:
        chapter_kps = [other for other in kps if other["chapter_id"] == kp["chapter_id"] and other["id"] != kp["id"]]
        siblings = [other for other in chapter_kps if other["topic_id"] == kp["topic_id"]]
        siblings += [other for other in chapter_kps if other["topic_id"] != kp["topic_id"]]
        if len(siblings) >= 3:
            letters = "ABCD"
            correct = kp["position"] % 4
            others = siblings[:3]
            options = [(letter, first_clause((kp if index == correct else others[index if index < correct else index - 1])["summary"]))
                       for index, letter in enumerate(letters)]
            add(kp, {"type": "single", "score": 2, "stem": [text_block(f"下列哪一项说的是“{kp['title']}”？")],
                     "options": options, "key": letters[correct], "answer": letters[correct],
                     "steps": [[text_block(f"“{kp['title']}”：{kp['summary']}")],
                               [text_block(f"其他选项分别说的是：{'、'.join('“' + other['title'] + '”' for other in others)}。")]],
                     "hints": [f"回想这一节里“{kp['title']}”是怎么定义的。", "逐个判断每个选项说的是哪个知识点，排除不相关的。"]}, False)
        parts = [part for part in kp["summary"].split("；") if part]
        points = (parts if len(parts) >= 2 else [part for part in kp["summary"].split("，") if part])[:3]
        each = math.floor(6 / len(points))
        add(kp, {"type": "short", "score": 6, "stem": [text_block(f"用自己的话说明“{kp['title']}”。")],
                 "answer": kp["summary"], "steps": [[text_block(kp["summary"])]],
                 "rubric": [(re.sub(r"。$", "", point), 6 - each * (len(points) - 1) if index == len(points) - 1 else each)
                            for index, point in enumerate(points)],
                 "hints": ["先说它是什么，再说它有什么特点或怎么用。", f"可以从课件里“{kp['title']}”这一页的第一句话入手。"]}, False)
    return bank


def seed_history(conn, user, course, mix, now):
    today = now.astimezone(ZoneInfo(user.timezone)).date()
    classifications = levels(conn, course["id"])
    kps = [kp for kp in course["kps"] if classifications.get(kp["id"], "none") != "excluded"]
    mastered_n, shaky_n, learned_n = [math.floor(len(kps) * ratio + 0.5) for ratio in mix[:3]]
    mastered = kps[:mastered_n]
    shaky = kps[mastered_n:mastered_n + shaky_n]
    learned = kps[mastered_n + shaky_n:mastered_n + shaky_n + learned_n]
    sessions = [{"days": days, "picks": []} for days in (12, 9, 6, 4, 2, 1)]

    def bank_for(kp):
        return sorted([question for question in course["bank"] if question["kp_id"] == kp["id"]],
                      key=lambda question: -question["authored"])

    for index, kp in enumerate(mastered):
        bank = bank_for(kp)
        sessions[index % 3]["picks"].append((bank[0], "correct"))
        sessions[3 + index % 3]["picks"].append((bank[1], "correct"))
        conn.execute("UPDATE kp_progress SET understood_at=? WHERE kp_id=?", ((now - timedelta(days=13 - index % 5)).isoformat(), kp["id"]))
    for index, kp in enumerate(shaky):
        sessions[2 + index % 4]["picks"].append((bank_for(kp)[0], "partial" if index % 3 == 0 else "wrong"))
    for kp in learned:
        conn.execute("UPDATE kp_progress SET understood_at=? WHERE kp_id=?", ((now - timedelta(days=3)).isoformat(), kp["id"]))
    for session in sessions:
        if not session["picks"]:
            continue
        days = session["days"]
        local = datetime.combine(today - timedelta(days=days), time(19, 10), tzinfo=ZoneInfo(user.timezone))
        session_id = identifier("s")
        kind = "mock" if days == 2 else "quick" if days % 2 else "kp"
        title = f"{course['name']} · {('模拟卷' if kind == 'mock' else '快练' if kind == 'quick' else '按知识点练')}"
        score = sum(question["score"] if outcome == "correct" else math.floor(question["score"] / 2 + 0.5)
                    if outcome == "partial" else 0 for question, outcome in session["picks"])
        insert(conn, "practice_sessions", {"id": session_id, "user_id": user.id, "course_id": course["id"], "title": title,
                                           "kind": kind, "status": "finished", "created_at": local.astimezone(now.tzinfo).isoformat(),
                                           "started_at": local.astimezone(now.tzinfo).isoformat(),
                                           "finished_at": (local + timedelta(minutes=18)).astimezone(now.tzinfo).isoformat(),
                                           "question_count": len(session["picks"]), "answered": len(session["picks"]),
                                           "score": score, "total": sum(question["score"] for question, _ in session["picks"])})
        for index, (question, outcome) in enumerate(session["picks"]):
            at = datetime.combine(today - timedelta(days=days), time(19 + (1 + index) % 3, 10 + (1 + index) * 3),
                                  tzinfo=ZoneInfo(user.timezone)).astimezone(now.tzinfo).isoformat()
            insert(conn, "learning_events", {"id": identifier("ev"), "user_id": user.id, "kp_id": question["kp_id"],
                                              "bank_id": question["id"], "session_id": session_id, "outcome": outcome,
                                              "counted": 1, "hinted": 0, "created_at": at})
            if outcome != "correct":
                reason = "自评：部分得分" if outcome == "partial" else "选了 A" if question["type"] == "single" else "自评：没有得分"
                insert(conn, "mistakes", {"user_id": user.id, "bank_id": question["id"], "course_id": course["id"],
                                          "wrong_count": 1, "correct_streak": 0, "last_wrong_at": at, "reason": reason,
                                          "question_id": None})
    for index, kp in enumerate(mastered):
        stability, due = (2.5, today) if index < mix[3] else (6, today + timedelta(days=3))
        conn.execute("UPDATE kp_progress SET stability=?,due_at=? WHERE kp_id=?", (stability, due.isoformat(), kp["id"]))
    for kp in shaky:
        conn.execute("UPDATE kp_progress SET stability=0.5,due_at=? WHERE kp_id=?", ((today + timedelta(days=1)).isoformat(), kp["id"]))


def seed_personal_data(conn, user, courses, now):
    math_course, os_course, ds_course = courses
    tablet_id = identifier("dv")
    for device_id, kind, name, hours in ((tablet_id, "tablet", "华为 MatePad", 2),
                                         (identifier("dv"), "phone", "华为 Mate 手机", 20)):
        insert(conn, "devices", {"id": device_id, "user_id": user.id, "kind": kind, "name": name,
                                 "last_seen": (now - timedelta(hours=hours)).isoformat(), "revoked_at": None})
    for text, source, days in (("晚上学习效率高", "user", 5), ("讲解要短，先看例子", "user", 4),
                                ("条件判断类的选择题容易错", "practice", 2)):
        insert(conn, "memory_items", {"id": identifier("mem"), "user_id": user.id, "text": text, "source": source,
                                      "created_at": (now - timedelta(days=days)).isoformat()})
    for kind, title, body, course, hours, read in (
        ("exam_soon", "高等数学还有 3 天考试", "今天的任务已经按它优先排好了", math_course, 1, False),
        ("job_done", "数据结构的资料整理完了", f"整理出 {len(ds_course['kps'])} 个知识点", ds_course, 26, True),
    ):
        stamp = (now - timedelta(hours=hours)).isoformat()
        insert(conn, "notifications", {"id": identifier("n"), "user_id": user.id, "kind": kind, "title": title,
                                       "body": body, "href": f"/c/{course['id']}", "created_at": stamp,
                                       "read_at": stamp if read else None})
