"""结构化题目（ItemDraft）：格式校验、规范化、风险分级和比较工具。只依赖标准库。"""
import ast
import math
import re
from fractions import Fraction


ITEM_FORMAT = 2
TYPES = ("single_choice", "short_answer", "calculation")
OPTION_PREFIX = re.compile(r"^\s*[(（]?[A-Ha-h][)）.、．:：]\s*")
PROOF_WORDS = re.compile(r"证明|推导|为什么|由来|说明理由|请论证")
NUMBER = re.compile(r"-?\d+(?:\.\d+)?(?:/\d+)?%?")
PUNCT = re.compile(r"[\s，。、；：:,.;！!？?“”\"'‘’（）()\[\]【】《》<>{}·…—\-_*`$\\|/→⇒➝←↔「」『』〈〉•●▪◦]+")


def letters(n):
    return [chr(65 + i) for i in range(n)]


def norm_text(text):
    return PUNCT.sub("", str(text)).lower()


def numbers_in(text):
    return NUMBER.findall(str(text))


def to_number(value):
    """把 3、"3"、"1/3"、"0.5"、"50%" 转成 Fraction；不是数字时返回 None。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return Fraction(value).limit_denominator(10 ** 6)
    text = str(value).strip().replace("，", ",")
    percent = text.endswith("%")
    text = text.rstrip("%").strip()
    if not re.fullmatch(r"-?\d+(?:\.\d+)?(?:/\d+)?", text):
        return None
    try:
        number = Fraction(text).limit_denominator(10 ** 6)
    except (ValueError, ZeroDivisionError):
        return None
    return number / 100 if percent else number


def same_value(a, b, tolerance=Fraction(1, 100)):
    """数值按相对误差 1% 比较；列表逐项比较；其他按去掉标点后的文字比较。"""
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(same_value(x, y, tolerance) for x, y in zip(a, b))
    x, y = to_number(a), to_number(b)
    if x is not None and y is not None:
        return abs(x - y) <= tolerance * max(abs(x), abs(y), Fraction(1, 100))
    return norm_text(a) == norm_text(b)


def answer_letter(answer, options):
    """把选择题答案统一成字母。可识别字母、带序号的选项、选项原文。识别不了返回 None。"""
    text = str(answer).strip()
    match = re.fullmatch(r"[(（]?([A-Ha-h])[)）.、．:：]?", text)
    if match and ord(match.group(1).upper()) - 65 < len(options):
        return match.group(1).upper()
    body = norm_text(OPTION_PREFIX.sub("", text))
    for letter, option in zip(letters(len(options)), options):
        if body and body == norm_text(option):
            return letter
    match = re.match(r"\s*[(（]?([A-Ha-h])[)）.、．:：\s]", text + " ")
    if match and ord(match.group(1).upper()) - 65 < len(options):
        return match.group(1).upper()
    return None


def choice_matches(value, letter, options):
    """代码或考生给出的选择题答案是否对应标准选项：可以是字母、选项原文，或与选项数值相等。"""
    found = answer_letter(value, options)
    if found:
        return found == letter
    option = options[ord(letter) - 65]
    if to_number(value) is not None and to_number(option) is not None:
        return same_value(value, option)
    return False


def number_sequence(value):
    """取出值中的全部数值，按出现顺序：[5, 9]、"f(5),e(9)"、"5 和 9" 都得到 [5, 9]。字典只取值。"""
    if isinstance(value, dict):
        return [n for v in value.values() for n in number_sequence(v)]
    if isinstance(value, (list, tuple)):
        return [n for v in value for n in number_sequence(v)]
    x = to_number(value)
    if x is not None:
        return [x]
    return [n for n in (to_number(t) for t in numbers_in(value)) if n is not None]


SUPERSCRIPT = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789")
SUBSCRIPT = str.maketrans("₀₁₂₃₄₅₆₇₈₉", "0123456789")
BOUND = re.compile(r"^\s*([ΘOΩθΟ]|Theta|Omega)\s*\((.*)\)\s*$")


def to_python_expr(text):
    """把 n(2n−1)、2*n^2 - n、log₂n、lg n、n² 这类单变量表达式改写成 Python 表达式。"""
    s = str(text).strip().replace("−", "-").replace("×", "*").replace("·", "*").replace("÷", "/").replace(" ", "")
    s = re.sub(r"([²³⁰¹⁴⁵⁶⁷⁸⁹]+)", lambda m: "^" + m.group(1).translate(SUPERSCRIPT), s)
    s = s.translate(SUBSCRIPT)
    s = re.sub(r"lg\(?n\)?|log_?2\(?n\)?|log\(?n\)?", "L", s)  # lg n、log₂n、log2(n)、log n 都按以 2 为底
    s = re.sub(r"ln\(?n\)?", "E", s)
    s = s.replace("^", "**")
    s = re.sub(r"(\d|\))(?=[nLE(])", r"\1*", s)  # 2n → 2*n，)( → )*(
    s = re.sub(r"([nLE])(?=[\d(nLE])", r"\1*", s)
    return s


def eval_expr(text, n):
    tree = ast.parse(to_python_expr(text), mode="eval")
    values = {"n": n, "L": math.log2(n), "E": math.log(n)}

    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.Name) and node.id in values:
            return values[node.id]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            return -ev(node.operand) if isinstance(node.op, ast.USub) else ev(node.operand)
        if isinstance(node, ast.BinOp):
            a, b = ev(node.left), ev(node.right)
            op = node.op
            if isinstance(op, ast.Add):
                return a + b
            if isinstance(op, ast.Sub):
                return a - b
            if isinstance(op, ast.Mult):
                return a * b
            if isinstance(op, ast.Div):
                return a / b
            if isinstance(op, ast.Pow) and abs(b) <= 10:
                return a ** b
        raise ValueError("不支持的表达式")
    return ev(tree)


def same_expression(a, b):
    """比较含 n 的表达式：去掉两边相同的 Θ/O/Ω 记号后，在几个 n 上取值比较。不是表达式时返回 False。"""
    a, b = str(a), str(b)
    ma, mb = BOUND.match(a), BOUND.match(b)
    if ma and mb and ma.group(1).lower().replace("theta", "θ") != mb.group(1).lower().replace("theta", "θ"):
        return False  # O 与 Θ 含义不同
    if ma:  # 只有一边写了 O(…)/Θ(…) 时，比较括号里的表达式
        a = ma.group(2)
    if mb:
        b = mb.group(2)
    if "n" not in to_python_expr(a) + to_python_expr(b) and "L" not in to_python_expr(a) + to_python_expr(b):
        return False
    try:
        for n in (8, 64, 1024):
            x, y = eval_expr(a, n), eval_expr(b, n)
            if not (math.isfinite(x) and math.isfinite(y)) or abs(x - y) > 1e-9 * max(1, abs(x), abs(y)):
                return False
        return True
    except (SyntaxError, ValueError, TypeError, ZeroDivisionError, OverflowError, RecursionError):
        return False


OPERATOR = re.compile(r"[\^*/+−×·²³√]|(?<=[\w)])-(?=[\w(])")


def is_symbolic(value):
    """含变量 n 的表达式，如 lg(n)、n² × lg n。"""
    if not isinstance(value, str) or to_number(value) is not None:
        return False
    expr = to_python_expr(BOUND.sub(lambda m: m.group(2), value))
    return bool(re.search(r"[nLE]", expr)) and not re.search(r"[A-DF-KM-Za-mo-z一-鿿]", expr)


def same_quantity(computed, written):
    """代码算出的量与解析中写的量是否相同。

    - 解析写成百分数时，代码给 25.33 或 0.2533 都算相同；
    - 写法不同但数值序列相同也算相同，例如代码返回 "f(5),e(9)"，解析写 [5, 9]；
    - 含 n 的表达式按取值比较，例如 n(2n−1) 与 2*n^2 - n、Θ(n²) 与 Θ(n^2)、log₂n 与 log2(n)。
    """
    if same_value(computed, written):
        return True
    if isinstance(computed, str) and isinstance(written, str) and same_expression(computed, written):
        return True
    text = str(written).strip()
    x, y = to_number(computed), to_number(text)
    if x is not None and y is not None:
        return text.endswith("%") and same_value(x, y * 100)
    if any(OPERATOR.search(str(v)) for v in (computed, written)):  # 表达式不能只比数字，2^n 和 n^2 的数字相同
        return False
    a, b = number_sequence(computed), number_sequence(written)
    return bool(a) and len(a) == len(b) and all(same_value(p, q) for p, q in zip(a, b))
