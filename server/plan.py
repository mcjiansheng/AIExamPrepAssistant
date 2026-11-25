"""Deterministic review planning from evidence and mastery."""
from collections import defaultdict
from datetime import date, timedelta

from core import bad_request, conflict, dump, fields, load, not_found, one_of, text, uid
from kb.store import KnowledgeBase

LEVEL_WEIGHT = {"excluded": 0, "none": 1, "mentioned": 2.5, "emphasized": 4, "conflict": 4}
MASTERY_WEIGHT = {"new": 1, "shaky": 1.2, "mastered": 0.3}
SCHEMA = """
CREATE TABLE IF NOT EXISTS plans (
    course TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    pins TEXT NOT NULL,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_items (
    id TEXT PRIMARY KEY,
    course TEXT NOT NULL REFERENCES plans(course) ON DELETE CASCADE,
    date TEXT NOT NULL,
    position INTEGER NOT NULL,
    value TEXT NOT NULL
);
"""


def existing(db, cid):
    return db.execute("SELECT * FROM plans WHERE course=?", (cid,)).fetchone()


def stale(db, cid):
    row = existing(db, cid)
    if row is not None:
        plan = load(row["value"])
        if not plan["stale"]:
            plan["stale"] = True
            db.execute("UPDATE plans SET value=? WHERE course=?", (dump(plan), cid))


def settings(body):
    fields(body, {"days", "hours_per_day", "start_date"})
    days, hours, start = body["days"], body["hours_per_day"], body["start_date"]
    if type(days) is not int or days < 1:
        raise bad_request("复习天数应为正整数")
    if type(hours) not in (int, float) or not 0 < hours <= 24:
        raise bad_request("每天复习时间应大于 0 小时且不超过 24 小时")
    try:
        start_day = date.fromisoformat(text(start, "开始日期"))
        if start_day.isoformat() != start:
            raise ValueError
        start_day + timedelta(days=days - 1)
    except (ValueError, OverflowError):
        raise bad_request("开始日期请用 YYYY-MM-DD，天数须在日历范围内") from None
    if days * hours * 60 < 1:
        raise bad_request("复习时间至少为一分钟")
    return {"days": days, "hours_per_day": hours, "start_date": start}


def ranked_topics(db, cid):
    kb = KnowledgeBase(db, cid)
    topics, points = kb.inventory()
    derived = kb.derived(points)
    by_topic = defaultdict(list)
    for kp in points:
        by_topic[kp["topic_id"]].append({**kp, **derived[kp["id"]]})
    output = []
    for topic in topics:
        tid = topic["id"]
        children = by_topic[tid]
        included = [kp for kp in children if kp["level"] != "excluded"]
        pages = {(kp["material_id"], page) for kp in included for page in kp["pages"]}
        compute = sum("compute" in kp["modes"] for kp in included)
        study = max(15, len(pages) * 2 + compute * 10) if included else 0
        base = sum(0.5 + (kp["importance"] - 1) / 8 for kp in children) / len(children)
        emphasis = sum(LEVEL_WEIGHT[kp["level"]] for kp in children) / len(children)
        mastery = sum(MASTERY_WEIGHT[kp["mastery"]] for kp in children) / len(children)
        homework = any(kp["basis"] == "homework" for kp in children)
        reasons = []
        if any(kp["level"] in ("emphasized", "conflict") for kp in children):
            reasons.append("老师强调")
        elif any(kp["level"] == "mentioned" for kp in children):
            reasons.append("老师提到过")
        if homework:
            reasons.append("作业考过")
        if any(kp["mastery"] == "shaky" for kp in children):
            reasons.append("还有知识点不熟")
        mastered = sum(kp["mastery"] == "mastered" for kp in children)
        if mastered == len(children):
            reasons.append("知识点已掌握")
        output.append({
            "topic_id": tid, "title": topic["title"], "chapter_title": topic["chapter_title"],
            "minutes": study, "pinned": None, "mastery": {"mastered": mastered, "total": len(children)},
            "focus_kps": [{k: kp[k] for k in ("id", "title", "level")} for kp in children if kp["level"] != "none"],
            "reasons": reasons, "practice": min(compute * 10, max(0, study - 1)),
            "weight": base * emphasis * mastery + (0.15 if homework else 0),
            "emphasized": any(kp["level"] in ("emphasized", "conflict") for kp in children),
            "excluded": not included,
        })
    limited = all(kp["basis"] in ("limited", "model") for kp in derived.values())
    return output, limited


def pick(topics, pins, requires, minutes, single_day):
    by_id = {item["topic_id"]: item for item in topics}
    ranked = sorted(topics, key=lambda item: -item["weight"] / max(1, item["minutes"]))
    must, maybe, drop = {}, [], []
    remaining = minutes
    for item in ranked:
        tid = item["topic_id"]
        item["pinned"] = pins.get(tid)
        if item["pinned"] == "must":
            item["minutes"] = max(15, item["minutes"])
            item["reasons"].insert(0, "你固定为必学")
            must[tid] = item
            remaining -= item["minutes"]

    def include(tid, path):
        nonlocal remaining
        if tid in path:
            return
        for required in requires[tid]:
            if required not in by_id:
                continue
            other = by_id[required]
            if other["pinned"] == "drop" or other["excluded"] or other["mastery"]["mastered"] == other["mastery"]["total"]:
                continue
            if required not in must and remaining > 0:
                if other["minutes"] > remaining:
                    other["minutes"] = min(remaining, 15)
                    other["practice"] = 0
                    other["reasons"].append("时间有限，先看核心内容")
                other["reasons"].insert(0, "是" + by_id[tid]["title"] + "的前置")
                remaining -= other["minutes"]
                must[required] = other
            if required in must:
                include(required, path | {tid})

    for tid in list(must):
        include(tid, set())
    overflow = 0
    for item in ranked:
        tid = item["topic_id"]
        if tid in must:
            continue
        if item["pinned"] == "drop":
            item["reasons"].insert(0, "你固定为本次放弃")
            drop.append(item)
        elif item["excluded"]:
            item["reasons"].insert(0, "老师说这些知识点不考")
            drop.append(item)
        elif single_day and not item["emphasized"]:
            item["reasons"].append("只剩一天，先复习强调的内容")
            drop.append(item)
        elif remaining > 0 and (item["minutes"] <= remaining or single_day and item["emphasized"]):
            if item["minutes"] > remaining:
                item["minutes"] = remaining
                item["practice"] = 0
                item["reasons"].append("时间有限，先看核心内容")
            remaining -= item["minutes"]
            if not item["reasons"]:
                item["reasons"].append(f"约需 {item['minutes']} 分钟，排在可用时间内")
            must[tid] = item
            include(tid, set())
        else:
            overflow += item["minutes"]
            if overflow <= minutes or not maybe:
                item["reasons"].append(f"还需约 {item['minutes']} 分钟，放在本次时间之外")
                maybe.append(item)
            else:
                item["reasons"].append(f"当前排得更靠后，还需约 {item['minutes']} 分钟")
                drop.append(item)

    ordered = []
    have = set()

    def visit(tid):
        if tid in have:
            return
        have.add(tid)
        for required in requires[tid]:
            if required in must:
                visit(required)
        ordered.append(must[tid])

    for item in topics:
        if item["topic_id"] in must:
            visit(item["topic_id"])
    return {"must": ordered, "maybe": maybe, "drop": drop}


def make_schedule(pid, config, total, reserve, must, checked):
    days = config["days"]
    start = date.fromisoformat(config["start_date"])
    schedule = [{"date": (start + timedelta(days=i)).isoformat(), "items": []} for i in range(days)]
    capacity = [total * (i + 1) // days - total * i // days for i in range(days)]
    counters = defaultdict(int)

    def make(topic_id, title, minutes, kind):
        key = (topic_id, kind)
        counters[key] += 1
        item_id = f"{pid}:{topic_id or 'reserve'}:{kind}:{counters[key]}"
        return {"id": item_id, "topic_id": topic_id, "title": title,
                "minutes": minutes, "kind": kind, "done": item_id in checked}

    mock = round(reserve * 0.6)
    review = reserve - mock
    tail = [[] for _ in schedule]
    for kind, title, length in (
        ("review", "复习错题和不稳的主题", review),
        ("mock", "短模拟题" if days == 1 else "模拟卷", mock),
    ):
        for i in reversed(range(days)):
            if length == 0:
                break
            amount = min(capacity[i], length)
            if amount:
                capacity[i] -= amount
                length -= amount
                tail[i].insert(0, make(None, title, amount, kind))
    day = 0
    for topic in must:
        tid, title = topic["topic_id"], topic["title"]
        practice = topic["practice"]
        for kind, label, minutes in (
            ("study", title, topic["minutes"] - practice), ("practice", "练习：" + title, practice),
        ):
            while minutes and day < days:
                if capacity[day] == 0:
                    day += 1
                    continue
                amount = min(capacity[day], minutes)
                schedule[day]["items"].append(make(tid, label, amount, kind))
                capacity[day] -= amount
                minutes -= amount
            if minutes:
                reminder = "可用时间排满，部分内容待安排"
                if reminder not in topic["reasons"]:
                    topic["reasons"].append(reminder)
    for i, day_items in enumerate(tail):
        schedule[i]["items"].extend(day_items)
    return schedule


class Plans:
    def __init__(self, app, api):
        self.app = app
        app.plans = self
        with app.db() as db:
            db.executescript(SCHEMA)
        api.add("GET", "/courses/([^/]+)/plan", self.get)
        api.add("POST", "/courses/([^/]+)/plan", self.make, "json")
        api.add("POST", "/courses/([^/]+)/plan/pins", self.pin, "json")
        api.add("POST", "/plan-items/([^/]+)", self.done, "json")

    def get(self, cid):
        with self.app.db() as db:
            self.app.course(db, cid)
            return {"plan": self.view(db, cid)}

    @staticmethod
    def view(db, cid):
        row = existing(db, cid)
        if row is None:
            return None
        plan = load(row["value"])
        items = defaultdict(list)
        for item in db.execute("SELECT date,value FROM plan_items WHERE course=? ORDER BY date,position", (cid,)):
            items[item["date"]].append(load(item["value"]))
        plan["schedule"] = [{"date": day, "items": items[day]} for day in plan["dates"]]
        del plan["dates"]
        return plan

    def make(self, cid, body):
        config = settings(body)
        with self.app.db(write=True) as db:
            self.app.course(db, cid)
            old = existing(db, cid)
            return self.rebuild(db, cid, config, load(old["pins"]) if old else {}, old)

    def pin(self, cid, body):
        fields(body, {"topic_id", "pin"})
        tid = text(body["topic_id"], "主题")
        pin = one_of(body["pin"], ("must", "drop", None), "固定选项")
        with self.app.db(write=True) as db:
            self.app.course(db, cid)
            old = existing(db, cid)
            if old is None:
                raise conflict("还没有计划")
            topics, _ = KnowledgeBase(db, cid).inventory()
            if not any(t["id"] == tid for t in topics):
                raise not_found("主题")
            pins = load(old["pins"])
            if pin is None:
                pins.pop(tid, None)
            else:
                pins[tid] = pin
            return self.rebuild(db, cid, load(old["settings"]), pins, old)

    def rebuild(self, db, cid, config, pins, old):
        topics, limited = ranked_topics(db, cid)
        if not topics:
            raise conflict("先上传资料，整理出知识点后才能排计划")
        pid = load(old["value"])["id"] if old else uid("p")
        checked = {row["id"] for row in db.execute("SELECT id,value FROM plan_items WHERE course=?", (cid,))
                   if load(row["value"])["done"]}
        requirements = defaultdict(list)
        for row in db.execute(
            """SELECT source,required FROM topic_requirements r
               JOIN topics t ON t.id=r.source JOIN documents d ON d.material_id=t.material_id WHERE d.course=?""", (cid,),
        ):
            requirements[row["source"]].append(row["required"])
        total = round(config["days"] * config["hours_per_day"] * 60)
        reserve = round(total * 0.2)
        buckets = pick(topics, pins, requirements, total - reserve, config["days"] == 1)
        schedule = make_schedule(pid, config, total, reserve, buckets["must"], checked)
        for group in buckets.values():
            for item in group:
                for key in ("practice", "weight", "emphasized", "excluded"):
                    del item[key]
        value = {"id": pid, **config, "total_min": total, "reserved_min": reserve, "limited_basis": limited,
                 "stale": False, "buckets": buckets, "dates": [day["date"] for day in schedule]}
        db.execute("INSERT INTO plans VALUES (?,?,?,?) ON CONFLICT(course) DO UPDATE SET settings=excluded.settings,pins=excluded.pins,value=excluded.value",
                   (cid, dump(config), dump(pins), dump(value)))
        db.execute("DELETE FROM plan_items WHERE course=?", (cid,))
        db.executemany("INSERT INTO plan_items VALUES (?,?,?,?,?)", [
            (item["id"], cid, day["date"], i, dump(item)) for day in schedule for i, item in enumerate(day["items"])
        ])
        del value["dates"]
        return {**value, "schedule": schedule}

    def done(self, item_id, body):
        fields(body, {"done"})
        if type(body["done"]) is not bool:
            raise bad_request("done 应为布尔值")
        with self.app.db(write=True) as db:
            row = db.execute("SELECT value FROM plan_items WHERE id=?", (item_id,)).fetchone()
            if row is None:
                raise not_found("计划项")
            item = load(row["value"])
            item["done"] = body["done"]
            db.execute("UPDATE plan_items SET value=? WHERE id=?", (dump(item), item_id))
            return item
