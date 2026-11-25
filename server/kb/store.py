"""Course-scoped reads and evidence derivation, adapted from the prototype KB."""
import math
import re
from collections import Counter, defaultdict

from core import load, not_found
from kb.evidence_db import derive, rule_classify, split_note

TOKEN = re.compile(r"[a-z0-9_+#.]{2,}|[一-鿿]+")
STOP = {"的", "了", "和", "与", "是", "在", "请", "什么", "怎么", "如何", "the", "of", "and", "to", "in", "is", "a"}
BASIS = {"teacher": "teacher", "assignment": "homework", "past_paper": "past_paper",
         "note": "note", "user": "user", "model": "model"}


def tokens(value):
    result = []
    for piece in TOKEN.findall(value.casefold()):
        if piece not in STOP:
            if len(piece) > 1 and "一" <= piece[0] <= "鿿":
                result.extend(piece[i:i + 2] for i in range(len(piece) - 1))
            else:
                result.append(piece)
    return result


def evidence(id_, source, kp_ids, level=None, modes=(), placement="direct", quote=None):
    return {"id": id_, "source_kind": source, "kp_ids": kp_ids, "level": level, "modes": list(modes),
            "placement": placement, "quote": quote, "status": "active"}


class KnowledgeBase:
    def __init__(self, db, course):
        self.db = db
        self.course = course

    def inventory(self):
        from materials import Materials
        return Materials.inventory(self.db, self.course)

    def points(self):
        return self.inventory()[1]

    def documents(self, include_superseded=False):
        return {row["material_id"]: row for row in self.db.execute(
            "SELECT * FROM documents WHERE course=? AND (? OR superseded_by IS NULL) AND pages IS NOT NULL",
            (self.course, include_superseded),
        )}

    def pages(self, material_id, numbers=None):
        # Check course membership before any page text is read.
        doc = self.db.execute("SELECT title FROM documents WHERE material_id=? AND course=?", (material_id, self.course)).fetchone()
        if doc is None:
            raise not_found("这门课的资料")
        return [{"material_id": material_id, "material_title": doc["title"], **dict(row)}
                for row in self.db.execute("SELECT page,text,vision FROM units WHERE material_id=? ORDER BY page", (material_id,))
                if numbers is None or row["page"] in numbers]

    def search(self, query, limit=5):
        """BM25 over this course's allowed pages with knowledge-point synonyms."""
        terms = Counter(tokens(query))
        if not terms:
            return []
        docs = self.documents()
        expansion = defaultdict(list)
        for kp in self.points():
            for page in kp["pages"]:
                expansion[kp["material_id"], page].extend([kp["title"], kp["summary"], *kp["terms"]])
        units = []
        for mid, doc in docs.items():
            for unit in self.pages(mid):
                extra = " ".join(expansion[mid, unit["page"]])
                units.append((unit, Counter(tokens(f"{unit['text']} {doc['title']} {extra}"))))
        count = len(units)
        if not count:
            return []
        average = sum(sum(tf.values()) for _, tf in units) / count
        df = Counter(term for _, tf in units for term in terms if term in tf)
        hits = []
        for unit, tf in units:
            score = 0.0
            for term, qf in terms.items():
                if term in tf:
                    idf = math.log1p((count - df[term] + 0.5) / (df[term] + 0.5))
                    score += qf * idf * tf[term] * 2.2 / (tf[term] + 1.2 * (0.25 + 0.75 * sum(tf.values()) / average))
            if docs[unit["material_id"]]["kind"] == "homework":
                score *= 0.6
            if score > 0:
                hits.append((score, unit))
        return [unit for _, unit in sorted(hits, key=lambda hit: -hit[0])[:limit]]

    def evidence(self, points):
        by_material = defaultdict(list)
        for point in points:
            by_material[point["material_id"]].append(point)
        rows = []
        scoped = set()
        for mid, doc in self.documents().items():
            bucket = by_material[mid]
            ids = [point["id"] for point in bucket]
            if doc["kind"] == "review":
                rows.append(evidence(mid, "teacher", ids, "emphasized"))
                scoped.add(mid)
            elif doc["kind"] in ("homework", "past_paper"):
                rows.append(evidence(mid, "assignment" if doc["kind"] == "homework" else "past_paper", ids))
            for page in self.pages(mid):
                _, note = split_note(page["text"])
                if not note:
                    continue
                kind, level, modes = rule_classify(note)
                if kind != "judgment" or not bucket:
                    continue
                scoped.add(mid)
                n = page["page"]
                targets = [point["id"] for point in bucket if n in point["pages"]]
                placement = "direct"
                if not targets:
                    if n == 1:
                        targets = ids
                        placement = "document"
                    else:
                        distances = [(min(abs(n - m) for m in point["pages"]), point["id"]) for point in bucket]
                        best = min(distance for distance, _ in distances)
                        targets = [kid for distance, kid in distances if distance == best]
                        placement = "nearby"
                rows.append(evidence(f"{mid}:{n}", "note", targets, level, modes, placement, note))
        for row in self.db.execute(
            """SELECT f.id, f.text, m.kp_id, m.level, c.include FROM focus_matches m
               JOIN focus_fragments f ON f.id=m.fragment_id
               LEFT JOIN focus_choices c ON c.kp_id=m.kp_id
               WHERE f.course=? AND (c.include=1 OR (c.include IS NULL AND m.certainty='sure'))""",
            (self.course,),
        ):
            rows.append(evidence(row["id"] + ":" + row["kp_id"], "user" if row["include"] else "teacher",
                                 [row["kp_id"]], row["level"], quote=row["text"]))
        for row in self.db.execute("SELECT id, value, choice FROM suggestions WHERE course=? AND kind='focus_conflict' AND choice IS NOT NULL",
                                   (self.course,)):
            rows.append(evidence(row["id"], "user", load(row["value"])["kp_ids"], row["choice"]))
        return rows, scoped

    def derived(self, points):
        from exams import mastery
        states = mastery(self.db, self.course)
        rows, scoped = self.evidence(points)
        by_id = {row["id"]: row for row in rows}
        raw = derive(points, rows, scoped)
        priority = ("user", "teacher", "note", "homework", "past_paper", "model")
        result = {}
        for kp in points:
            item = raw[kp["id"]]
            source_ids = item["decided_by"] or item["evidence"]
            sources = {BASIS[by_id[key]["source_kind"]] for key in source_ids}
            basis = next((kind for kind in priority if kind in sources), "limited")
            modes = sorted(set(kp["modes"]) | set(item["modes"]))
            level = item["level"] or "none"
            result[kp["id"]] = {"id": kp["id"], "title": kp["title"], "basis": basis, "level": level,
                                "modes": modes, "mastery": states.get(kp["id"], "new")}
        return result

    def topics(self):
        topics, points = self.inventory()
        items = self.derived(points)
        by_topic = defaultdict(list)
        for point in points:
            by_topic[point["topic_id"]].append(point)
        chapters = {}
        for topic in topics:
            children = by_topic[topic["id"]]
            if not children:
                continue
            label = topic["material_id"]
            chapter = chapters.setdefault(label, {"id": label, "title": topic["chapter_title"], "topics": []})
            kps = [items[kp["id"]] for kp in children]
            page_count = len({page for kp in children for page in kp["pages"]})
            compute_count = sum("compute" in kp["modes"] for kp in kps)
            chapter["topics"].append({
                "id": topic["id"], "title": topic["title"], "summary": topic["summary"], "kps": kps,
                "minutes": max(15, page_count * 2 + compute_count * 10),
                "mastery": {"mastered": sum(k["mastery"] == "mastered" for k in kps),
                            "shaky": sum(k["mastery"] == "shaky" for k in kps), "total": len(kps)},
            })
        return {"chapters": list(chapters.values()),
                "limited_basis": all(kp["basis"] in ("limited", "model") for kp in items.values())}
