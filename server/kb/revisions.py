"""Reuse pages and recheck questions when a material's canonical revision changes."""
from collections import defaultdict, deque

from core import dump, load, uid
from workflow.items import norm_text


def mapping(db, old_id, new_id):
    current = defaultdict(deque)
    for page in db.execute("SELECT page,sha256 FROM units WHERE material_id=? ORDER BY page", (new_id,)):
        current[page["sha256"]].append(page["page"])
    return {page["page"]: current[page["sha256"]].popleft()
            for page in db.execute("SELECT page,sha256 FROM units WHERE material_id=? ORDER BY page", (old_id,))
            if current[page["sha256"]]}


def reuse_ready_pages(db, old_id, new_id, remap):
    """Move stable knowledge IDs with the canonical pages, keeping a readable old version."""
    if not remap or db.execute("SELECT 1 FROM points WHERE material_id=? LIMIT 1", (new_id,)).fetchone():
        return
    db.executemany("INSERT OR IGNORE INTO reused_pages VALUES (?,?)", [(new_id, page) for page in remap.values()])
    for topic in db.execute("SELECT * FROM topics WHERE material_id=? ORDER BY rowid", (old_id,)).fetchall():
        entries = [(point, load(point["value"])) for point in db.execute("SELECT * FROM points WHERE topic_id=?", (topic["id"],))]
        reusable = [(point, value) for point, value in entries if all(page in remap for page in value["pages"])]
        if not reusable:
            continue
        archive = uid("t")
        db.execute("INSERT INTO topics VALUES (?,?,?,?)", (archive, old_id, topic["title"], topic["summary"]))
        db.execute("UPDATE points SET topic_id=? WHERE topic_id=?", (archive, topic["id"]))
        db.execute("UPDATE topics SET material_id=? WHERE id=?", (new_id, topic["id"]))
        for point, value in reusable:
            db.execute("INSERT INTO points VALUES (?,?,?,?)", (uid("kp"), old_id, archive, point["value"]))
            value["pages"] = [remap[page] for page in value["pages"]]
            db.execute("UPDATE points SET material_id=?,topic_id=?,value=? WHERE id=?",
                       (new_id, topic["id"], dump(value), point["id"]))


def recheck_questions(db, old_id, new_id, title, remap):
    new_pages = {page["page"]: (norm_text(page["text"]), norm_text(page["vision"] or "")) for page in db.execute(
        "SELECT page,text,vision FROM units WHERE material_id=? ORDER BY page", (new_id,),
    )}
    title = str(title)
    for question in db.execute(
        """SELECT q.* FROM questions q JOIN points p ON p.id=q.kp_id
           WHERE p.material_id IN (?,?) AND q.draft IS NOT NULL AND q.status IN ('ready','disputed')""", (old_id, new_id),
    ).fetchall():
        draft = load(question["draft"])
        if not any(ref["material_id"] == old_id for ref in draft["refs"]):
            continue
        checked = []
        source_refs = draft.get("source_refs")
        if source_refs is None:
            source_refs = [[{**ref, "quote": ""} for ref in step["refs"]] for step in draft["solution"]["steps"]]
        for sources in source_refs:
            group = []
            for ref in sources:
                if ref["material_id"] != old_id:
                    group.append(ref)
                    continue
                n = remap.get(ref["page"])
                if n is None:
                    quote = norm_text(ref["quote"])
                    n = next((page for page, (body, vision) in new_pages.items() if quote and (quote in body or quote in vision)), None)
                group.append({**ref, "material_id": new_id, "material_title": title, "page": n})
            checked.append(group)
        if any(ref["page"] is None for group in checked for ref in group):
            hints = load(question["hints"])
            flag = "资料已更新，原出处待复查"
            if flag not in hints:
                hints.append(flag)
            db.execute("UPDATE questions SET status='disputed', checked=0, hints=? WHERE id=?", (dump(hints), question["id"]))
            continue
        refs = {}
        for step, group in zip(draft["solution"]["steps"], checked):
            view = []
            for ref in group:
                key = ref["material_id"], ref["page"]
                item = {"material_id": key[0], "page": key[1], "material_title": ref.get("material_title", title)}
                refs[key] = item
                view.append(item)
            step["refs"] = view
        draft.update(refs=list(refs.values()), source_refs=checked)
        db.execute("UPDATE questions SET draft=? WHERE id=?", (dump(draft), question["id"]))
