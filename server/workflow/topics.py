"""Topic grouping adapted from the prototype."""
from core import dump
from model import DATA_RULE, call_json, require

GROUP = DATA_RULE + """请将给出的知识点分成适合一起学习的主题。
返回 {"topics":[{"title":"主题", "summary":"一句说明或 null", "kp":[1,2],"requires":[1]}]}；
每个知识点编号恰好出现一次。requires 仅列确有依据的前置主题编号，从 1 开始；没有时填 []。"""


def target_count(points, size=8):
    return max(1, round(len(points) / size))


def group_once(client, key, points):
    """Use local numbering in the prompt and convert the result back to stable IDs."""
    listing = [{"n": i, "title": kp["title"], "summary": kp["summary"], "pages": kp["pages"]}
               for i, kp in enumerate(points, 1)]
    count = target_count(points)
    prompt = f"课程：{key[0]}\n课件：{key[1]}\n知识点：\n{dump(listing)}\n请分成 {count} 个主题。"

    def check(data):
        topics = data["topics"]
        require(isinstance(topics, list) and topics, "topics 应为非空数组")
        seen = []
        for n, topic in enumerate(topics, 1):
            require(isinstance(topic, dict), "每个主题应为对象")
            require(isinstance(topic["title"], str) and topic["title"].strip(), "每个主题都要有 title")
            require(topic["summary"] is None or isinstance(topic["summary"], str), "summary 要用文字或 null")
            members = topic["kp"]
            require(isinstance(members, list) and members and all(type(n) is int for n in members),
                    "主题须包含知识点编号数组 kp")
            seen.extend(members)
            requires = topic["requires"]
            require(isinstance(requires, list) and all(type(i) is int and 1 <= i <= len(topics) and i != n for i in requires)
                    and len(requires) == len(set(requires)), "requires 应为不重复的前置主题编号")
        require(sorted(seen) == list(range(1, len(points) + 1)), "每个知识点编号恰好出现一次")
        require(abs(len(topics) - count) <= 1, f"请分成约 {count} 个主题")

    data = call_json(client, "topics", GROUP, prompt, check)
    return [{"title": topic["title"], "summary": topic["summary"], "kp_ids": [points[n - 1]["id"] for n in topic["kp"]], "requires": topic["requires"]}
            for topic in data["topics"]]
