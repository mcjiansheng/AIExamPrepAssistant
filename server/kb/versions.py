#!/usr/bin/env python3
"""重复资料和版本判定。先按内容分组，再按可解释的证据选最终版，模型不参与判断。

证据从强到弱：用户确认 > 文件内嵌修改日期 / 内容包含关系 > 文件名中的完整日期。
文件系统修改时间会被下载和同步改写，不作为证据。证据不足时标记 needs_confirmation，
暂用最可能的版本，但不会假装确定，也不会删除任何资料。
"""
import hashlib
import re

MIN_PAGE_CHARS = 15
PAGE_CONTAINED = 0.8
GROUP_COVERAGE = 0.6
SAME_CONTENT = 0.95


def bigrams(text):
    text = re.sub(r"\s+", "", text.lower())
    return {text[i:i + 2] for i in range(len(text) - 1)}


def coverage(a_pages, b_pages):
    """A 的页面有多少比例被 B 的某一页基本包含。"""
    usable = [p for p in a_pages if len(p) >= MIN_PAGE_CHARS]
    if not usable:
        return 0.0
    hit = 0
    for page in usable:
        if any(len(page & other) / len(page) >= PAGE_CONTAINED for other in b_pages):
            hit += 1
    return hit / len(usable)


def same_pages(a, b):
    """A 的页面中，有多少比例能在 B 中找到文字几乎相同的页。比 coverage 严格，用来区分格式副本和修订版。"""
    if not a:
        return 0.0
    hit = sum(any(len(x & y) / max(len(x | y), 1) >= 0.95 for y in b.values()) for x in a.values())
    return hit / len(a)


def analyse(con, course_id, overrides=None):
    overrides = overrides or {}
    docs = {r[0]: {"id": r[0], "title": r[1], "sha": r[2], "meta_date": r[3], "name_date": r[4], "ext": r[5], "course": r[6]}
            for r in con.execute("SELECT material_id,title,sha256,meta_date,filename_date,ext,course FROM documents WHERE course=?", (course_id,))}
    pages = {}
    for mid in docs:
        rows = con.execute("SELECT page,text FROM units WHERE material_id=? ORDER BY page", (mid,)).fetchall()
        pages[mid] = {p: bigrams(t) for p, t in rows if len(bigrams(t)) >= MIN_PAGE_CHARS}
    whole = {m: set().union(*p.values()) if p else set() for m, p in pages.items()}

    parent = {m: m for m in docs}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    cov = {}
    ids = sorted(docs)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if docs[a]["sha"] == docs[b]["sha"]:
                cov[a, b] = cov[b, a] = 1.0
                parent[find(a)] = find(b)
                continue
            small = min(len(whole[a]), len(whole[b])) or 1
            if len(whole[a] & whole[b]) / small < 0.4:
                continue
            cov[a, b] = coverage(list(pages[a].values()), list(pages[b].values()))
            cov[b, a] = coverage(list(pages[b].values()), list(pages[a].values()))
            if max(cov[a, b], cov[b, a]) >= GROUP_COVERAGE:
                parent[find(a)] = find(b)

    groups = {}
    for m in docs:
        groups.setdefault(find(m), []).append(m)

    result = []
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort()
        gid = "versiongroup_" + hashlib.sha1("|".join(members).encode()).hexdigest()[:10]
        result.append(decide(gid, members, docs, cov, pages, overrides.get(gid)))
    return result


def decide(gid, members, docs, cov, pages, override):
    score = {m: 0 for m in members}
    evidence = {m: [] for m in members}

    # 内嵌日期要两份都有才可比；文件名日期只要有一份写明具体日期，就是作者给出的版本信息。
    dated = {m: docs[m]["meta_date"] for m in members if docs[m]["meta_date"]}
    if len(dated) >= 2 and list(dated.values()).count(max(dated.values())) == 1:
        winner = max(dated, key=dated.get)
        score[winner] += 3
        evidence[winner].append(f"文件内嵌修改日期最新：{dated[winner]}")
    named = {m: docs[m]["name_date"] for m in members if docs[m]["name_date"]}
    if named and list(named.values()).count(max(named.values())) == 1:
        winner = max(named, key=named.get)
        score[winner] += 2
        evidence[winner].append(f"文件名日期最新：{named[winner]}")
    for m in members:
        others = [o for o in members if o != m]
        if all(cov.get((o, m), 0) >= 0.8 and cov.get((m, o), 1) <= 0.5 for o in others):
            score[m] += 3
            evidence[m].append("内容包含其他版本")

    identical = len({docs[m]["sha"] for m in members}) == 1
    same_content = all(same_pages(pages[a], pages[b]) >= SAME_CONTENT for a in members for b in members if a != b)
    ranked = sorted(members, key=lambda m: (-score[m], docs[m]["ext"] != ".pptx", docs[m]["title"], m))
    best = ranked[0]
    margin = score[best] - (score[ranked[1]] if len(ranked) > 1 else 0)

    if override in members:
        best, relation, confidence = override, "user_confirmed", "user_confirmed"
        evidence[best].append("用户确认")
    elif identical:
        relation, confidence = "identical_file", "high"
        evidence[best].append("文件完全相同，保留一份")
    elif same_content:
        relation, confidence = "same_content", "high"
        evidence[best].append("各页文字几乎相同，是格式副本")
    elif margin >= 3:
        relation, confidence = "revision", "high"
    else:
        relation, confidence = "revision", "needs_confirmation"

    records = []
    for m in members:
        unmatched = []
        if m != best:
            unmatched = [p for p, grams in sorted(pages[m].items())
                         if not any(len(grams & o) / len(grams) >= PAGE_CONTAINED for o in pages[best].values())]
        records.append({"material_id": m, "title": docs[m]["title"], "ext": docs[m]["ext"], "course": docs[m]["course"],
                        "status": "canonical" if m == best else "superseded",
                        "score": score[m], "evidence": evidence[m], "meta_date": docs[m]["meta_date"],
                        "filename_date": docs[m]["name_date"], "pages_not_in_canonical": unmatched})
    return {"group_id": gid, "relation": relation, "confidence": confidence, "canonical": best, "members": records}
