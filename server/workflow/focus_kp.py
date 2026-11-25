"""Recall-first topic matching and independent knowledge-point votes, adapted from the prototype."""
import re
from collections import Counter

from core import dump
from model import DATA_RULE, call_json, require
from workflow.llm import OutputError

MAPPING = DATA_RULE + """
只做第一步，优先召回。把有关的主题都列上，下一步再挑知识点。
terms 是原句中指称课程内容的核心词。找不到时可以给空数组。
输出 {"topic_ids":["候选主题ID"],"terms":["原句的核心词"]}。
"""
PICK = DATA_RULE + """
只选这句话实际指的知识点。一个主题里没被提到的知识点不要选。
找不到对应内容时返回空数组。输出 {"items":[知识点编号]}，编号只能来自候选。
"""


def squeeze(value):
    return re.sub(r"\s+", "", value).casefold()


def fragments(text):
    result = []
    for sentence in re.split(r"(?<=[。？！；?!;])|\n+", text):
        if not sentence.strip():
            continue
        clauses = re.split(r"(?<=[，,])", sentence)
        for clause in clauses:
            value = clause.strip()
            if not value:
                continue
            follows = re.match(r"(?:但|不过|这部分|这些|都|也|主要)?(?:不考|不作要求|不用背|要会|要理解|要掌握|一定考|了解即可|看一下|会考)", value)
            if follows and result and result[-1].endswith(("，", ",")):
                result[-1] += clause
            else:
                result.append(value)
    return result


def level(text):
    if re.search(r"不考|不作要求|不纳入考试|了解(?:一下)?(?:即可|就行)", text):
        return "excluded"
    if re.search(r"重点|必考|会考|大题|要会|要掌握|一定考", text) and not re.search(r"可能会考|不一定会考", text):
        return "emphasized"
    return "mentioned"


def map_topics(client, text, topics):
    by_id = {topic["id"]: topic for topic in topics}
    data = {"fragment": text, "topics": topics}

    def check(reply):
        ids, terms = reply["topic_ids"], reply["terms"]
        require(isinstance(ids, list) and all(isinstance(value, str) and value in by_id for value in ids),
                "topic_ids 只能用当前主题编号")
        require(isinstance(terms, list) and all(isinstance(t, str) and t.strip() and t in text for t in terms),
                "terms 应是重点原句里的词")

    reply = call_json(client, "focusmap", MAPPING, dump(data), check)
    ids = dict.fromkeys(reply["topic_ids"])
    for word in reply["terms"]:
        core = squeeze(word)
        hits = [topic["id"] for topic in topics if len(core) >= 2 and core in squeeze(topic["title"])]
        if len(hits) <= 3:
            ids.update(dict.fromkeys(hits))
    return list(ids)


def vote(client, text, candidates, number):
    options = [{"n": i, "title": kp["title"], "summary": kp["summary"]}
               for i, kp in enumerate(candidates, 1)]

    def check(reply):
        items = reply["items"]
        require(isinstance(items, list) and all(type(item) is int and 1 <= item <= len(options) for item in items),
                "items 必须为候选知识点编号数组")

    data = call_json(client, f"focuskp:{number}", PICK, dump({"fragment": text, "options": options, "vote": number}), check)
    return {candidates[i - 1]["id"] for i in data["items"]}


def analyse(client, text, topics, points):
    if not topics:
        return []
    try:
        chosen = map_topics(client, text, topics)
    except OutputError:
        # Retry against smaller topic sets before giving up on this fragment.
        chosen = [tid for start in range(0, len(topics), 8) for tid in map_topics(client, text, topics[start:start + 8])]
    selected = set(chosen)
    candidates = [kp for kp in points if kp["topic_id"] in selected]
    if not candidates:
        return []
    counts = Counter()
    for ballot in range(1, 4):
        try:
            counts.update(vote(client, text, candidates, ballot))
        except OutputError:
            for start in range(0, len(candidates), 8):
                counts.update(vote(client, text, candidates[start:start + 8], ballot))
    return [{"id": kp["id"], "title": kp["title"], "level": level(text),
             "certainty": "sure" if counts[kp["id"]] >= 2 else "maybe"}
            for kp in candidates if counts[kp["id"]]]
