"""Page extraction adapted from the prototype kb/ingest.py and kb/upload.py."""
import json
import posixpath
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

SYMBOLS = dict(zip(
    [0x22, 0x24, 0x44, 0x46, 0x47, 0x4C, 0x4F, 0x50, 0x51, 0x53, 0x57, 0x58, 0x59,
     0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F,
     0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x77, 0x78, 0x79, 0x7A,
     0xA3, 0xA5, 0xAC, 0xAD, 0xAE, 0xAF, 0xB0, 0xB1, 0xB3, 0xB4, 0xB8, 0xB9, 0xBA, 0xBB, 0xBE,
     0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA,
     0xDB, 0xDC, 0xDE, 0xE0, 0xE5, 0xE9, 0xEB, 0xF2, 0xF9, 0xFB],
    "∀∃ΔΦΓΛOΠΘΣΩΞΨαβχδεφγηικλμνοπθρστυωξψζ"
    "≤∞←↑→↓°±≥×÷≠≡≈—∅∩∪⊃⊇⊄⊂⊆∈∉√⋅¬∧∨⇔⇐⇒→∑⌈⌊∫⌉⌋",
))
BULLETS = {0xF097, 0xF02A}


def restore_symbols(text):
    out = []
    for ch in text:
        code = ord(ch)
        if 0xE000 <= code <= 0xF8FF:
            if code in BULLETS:
                out.append("•")
            elif code - 0xF000 in SYMBOLS:
                out.append(SYMBOLS[code - 0xF000])
        else:
            out.append(ch)
    return "".join(out)


def clean(text):
    text = restore_symbols(text).replace("\x0b", "\n").replace("　", " ")
    lines = [re.sub(r"[ \t]+", " ", x).strip() for x in text.splitlines()]
    lines = [x for x in lines if x and x != "<number>"]
    if lines and lines[-1].isdigit():  # 页脚页码
        lines.pop()
    return "\n".join(lines)


def extract_pdf(path):
    out = subprocess.run(["pdftotext", "-enc", "UTF-8", str(path), "-"], capture_output=True, check=True, timeout=120).stdout
    pages = out.decode("utf-8", "replace").split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def filename_date(name):
    match = re.search(r"(20\d{2})(\d{2})(\d{2})(?!\d)", name)
    if match and 1 <= int(match.group(2)) <= 12 and 1 <= int(match.group(3)) <= 31:
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    return None


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    "dcterms": "http://purl.org/dc/terms/",
}


def _slide_number(name):
    return int(re.search(r"(\d+)\.xml$", name).group(1))


def pptx_pages_stdlib(path):
    """不依赖 python-pptx：按幻灯片顺序读取 ppt/slides/slideN.xml 中的文字，附上讲稿。"""
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        order = []
        try:
            pres = read_xml(z, "ppt/presentation.xml")
            rels = read_xml(z, "ppt/_rels/presentation.xml.rels")
            targets = {r.get("Id"): r.get("Target") for r in rels}
            rid = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
            for sld in pres.iter("{http://schemas.openxmlformats.org/presentationml/2006/main}sldId"):
                target = targets.get(sld.get(rid), "")
                if target:
                    order.append(posixpath.normpath(target.lstrip("/") if target.startswith("/") else "ppt/" + target))
        except KeyError:
            pass
        if not order:
            order = sorted((n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=_slide_number)
        pages = []
        for name in order:
            if name not in names:
                continue
            root = read_xml(z, name)
            lines = []
            for para in root.iter(f"{{{NS['a']}}}p"):
                text = "".join(t.text or "" for t in para.iter(f"{{{NS['a']}}}t")).strip()
                if text:
                    lines.append(text)
            notes = f"ppt/notesSlides/notesSlide{_slide_number(name)}.xml"
            if notes in names:
                body = [("".join(t.text or "" for t in p.iter(f"{{{NS['a']}}}t"))).strip()
                        for p in read_xml(z, notes).iter(f"{{{NS['a']}}}p")]
                body = [x for x in body if x and not x.isdigit()]
                if body:
                    lines.append("[讲稿] " + "\n".join(body))
            pages.append("\n".join(lines))
        return pages


def docx_lines_stdlib(path):
    with zipfile.ZipFile(path) as z:
        root = read_xml(z, "word/document.xml")
    body = root.find("w:body", NS)
    if body is None:
        raise ExtractionError("Word 文档没有正文，请确认文件内容后重新上传")
    lines = []
    for child in body:
        if child.tag == f"{{{NS['w']}}}p":
            lines.append("".join(t.text or "" for t in child.iter(f"{{{NS['w']}}}t")))
        elif child.tag == f"{{{NS['w']}}}tbl":
            for row in child.iter(f"{{{NS['w']}}}tr"):
                cells = ["".join(t.text or "" for t in cell.iter(f"{{{NS['w']}}}t")).strip() for cell in row.iter(f"{{{NS['w']}}}tc")]
                lines.append(" | ".join(cells))
    return lines


def chunk_by_question(lines):
    """作业没有稳定的页码，按题号切分（与 ingest.extract_docx 一致）。"""
    chunks, current = [], []
    for line in lines:
        if re.match(r"^\s*\d+\s*[、.．]", line) and current:
            chunks.append("\n".join(current))
            current = []
        current.append(line)
    chunks.append("\n".join(current))
    return chunks


def text_pages(text, size=1500):
    """纯文本按段落合并成约 size 字的“页”，有换页符时按换页符切分。"""
    if "\f" in text:
        return text.split("\f")
    pages, current = [], ""
    for para in re.split(r"\n\s*\n", text):
        if current and len(current) + len(para) > size:
            pages.append(current)
            current = ""
        current = f"{current}\n\n{para}" if current else para
    if current:
        pages.append(current)
    return pages


def office_date(path):
    """从 docProps/core.xml 读内嵌修改日期，不依赖第三方库。"""
    try:
        with zipfile.ZipFile(path) as z:
            root = read_xml(z, "docProps/core.xml")
    except (KeyError, zipfile.BadZipFile, ElementTree.ParseError):
        return None
    node = root.find("dcterms:modified", NS)
    if node is None or not (node.text or "").strip():
        return None
    return node.text.strip()[:10]


class ExtractionError(Exception):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


def read_xml(archive, entry):
    if archive.getinfo(entry).file_size > 32 * 1024 * 1024:
        raise ExtractionError("文档中的页面过大，请拆成较小的文件后重新上传")
    return ElementTree.fromstring(archive.read(entry))


def swift(path, workspace, *args):
    helper = Path(__file__).with_name("pdfkit_helper.swift")
    return subprocess.run(
        ["swift", "-module-cache-path", str(workspace / "swift-cache"), str(helper), args[0], str(path), *args[1:]],
        capture_output=True, check=True, timeout=120, cwd=workspace,
    ).stdout


def pdf(path, workspace):
    if shutil.which("pdftotext"):
        return extract_pdf(path), None
    if shutil.which("swift"):
        result = json.loads(swift(path, workspace, "text"))
        return result["pages"], result.get("modified")
    raise ExtractionError("本机无法读取 PDF，请另存为 PPTX、DOCX 或 TXT 后上传")


def convert(path, directory, fmt):
    if not shutil.which("soffice"):
        raise ExtractionError(f"本机无法转换 {path.suffix.upper()}，请另存为 {fmt.upper()} 后上传")
    subprocess.run(
        ["soffice", f"-env:UserInstallation={(directory / 'profile').as_uri()}", "--headless",
         "--convert-to", fmt, "--outdir", str(directory), str(path)],
        capture_output=True, check=True, timeout=120, cwd=directory,
    )
    output = directory / path.with_suffix(f".{fmt}").name
    if not output.is_file():
        raise ExtractionError("文档无法转换，可能已加密或损坏。请打开原件，另存后重新上传")
    return output


def extract(path, workspace):
    suffix = path.suffix.lower()
    try:
        if suffix == ".pdf":
            pages, modified = pdf(path, workspace)
        elif suffix in (".ppt", ".doc"):
            fmt = "pptx" if suffix == ".ppt" else "docx"
            with tempfile.TemporaryDirectory(dir=workspace) as temp:
                pages, _ = extract(convert(path, Path(temp), fmt), workspace)
            modified = None
        elif suffix == ".pptx":
            pages, modified = pptx_pages_stdlib(path), office_date(path)
        elif suffix == ".docx":
            pages, modified = chunk_by_question(docx_lines_stdlib(path)), office_date(path)
        else:
            pages = text_pages(path.read_text(encoding="utf-8-sig", errors="replace"))
            modified = None
    except subprocess.TimeoutExpired:
        raise ExtractionError("读取资料超时，可以重试或拆成较小的文件", retryable=True) from None
    except subprocess.CalledProcessError as exc:
        diagnostic = exc.stderr.lower() if exc.stderr else b""
        if b"password" in diagnostic or b"encrypt" in diagnostic:
            raise ExtractionError("文件已加密，请解除密码后重新上传") from None
        raise ExtractionError("读取失败，请确认文件能打开，再用原应用另存后重新上传") from None
    except RuntimeError as exc:
        if "password" not in str(exc).casefold() and "encrypted" not in str(exc).casefold():
            raise
        raise ExtractionError("文件已加密，请解除密码后重新上传") from None
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError):
        raise ExtractionError("文件结构损坏，请用原应用另存后重新上传") from None
    if not pages:
        raise ExtractionError("文件没有可读的页面，请确认文件内容后重新上传")
    return [clean(page) for page in pages], modified


def render(path, workspace):
    if path.suffix.lower() not in (".pdf", ".ppt", ".pptx"):
        return ()
    with tempfile.TemporaryDirectory(dir=workspace) as temp:
        directory = Path(temp)
        source = path if path.suffix.lower() == ".pdf" else convert(path, directory, "pdf")
        if shutil.which("pdftoppm"):
            subprocess.run(
                ["pdftoppm", "-r", "96", "-png", str(source), str(directory / "p")],
                capture_output=True, check=True, timeout=120, cwd=directory,
            )
        elif shutil.which("swift"):
            swift(source, workspace, "render", str(directory), "96")
        return [(int(page.stem.split("-")[1]), page.read_bytes()) for page in directory.glob("p-*.png")]
