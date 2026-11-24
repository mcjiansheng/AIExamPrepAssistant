"""LongCat transport and mock text helpers adapted from the prototype."""
import json
import re


def repair_quotes(text):
    """修复字符串中未转义的英文双引号，例如 "说明"面向主题"的含义"。

    在字符串内部遇到双引号时，只有后面紧跟 , : } ] 或结尾时才当作字符串结束，否则转义。
    """
    out, in_string, escaped = [], False, False
    for i, ch in enumerate(text):
        if not in_string:
            in_string = ch == '"'
            out.append(ch)
            continue
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == '"':
            rest = text[i + 1:].lstrip()
            if not rest or rest[0] in ",:}]":
                in_string = False
            else:
                out.append("\\")
        out.append(ch)
    return "".join(out)


def parse_json(text):
    """容忍模型在 JSON 外包裹代码块、多余文字或字符串中未转义的引号。"""
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fenced:
        text = fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    candidates = [text]
    if start >= 0 and end > start:
        candidates.append(text[start:end + 1])
    first_error = None
    for candidate in candidates + [repair_quotes(c) for c in candidates]:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as e:
            if first_error is None:
                around = candidate[max(0, e.pos - 40):e.pos + 40].replace("\n", " ")
                first_error = json.JSONDecodeError(f"{e.msg}（出错位置附近：{around}）", e.doc, e.pos)
    raise first_error


class OutputError(ValueError):
    """A reply failed validation after the format retries."""


class UnsupportedVision(Exception):
    pass
