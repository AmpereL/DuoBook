from __future__ import annotations

import hashlib
import io
import posixpath
import re
import zipfile
from urllib.parse import unquote, urlsplit
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from pypdf import PdfReader

from .db import new_id


MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_EXTRACTED_BYTES = 150 * 1024 * 1024
MAX_CHARACTERS = 300_000


class ParseError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class ParsedParagraph:
    text: str
    anchor: dict[str, Any]


@dataclass
class ParsedChapter:
    title: str
    paragraphs: list[ParsedParagraph]
    source_path: str | None = None
    page_start: int | None = None
    page_end: int | None = None


@dataclass
class ParseResult:
    title: str
    format: str
    file_hash: str
    char_count: int
    chapters: list[ParsedChapter]
    issues: list[dict[str, Any]]

    def as_structure(self) -> list[dict[str, Any]]:
        return [
            {
                "id": new_id("draft"),
                "title": chapter.title,
                "ordinal": index + 1,
                "paragraph_count": len(chapter.paragraphs),
            }
            for index, chapter in enumerate(self.chapters)
        ]


class _TextExtractor(HTMLParser):
    block_tags = {"p", "h1", "h2", "h3", "h4", "li", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[tuple[str, str]] = []
        self.anchors: dict[str, int] = {}
        self._tag: str | None = None
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.block_tags:
            self._flush()
            self._tag = tag
        attributes = dict(attrs)
        anchor = attributes.get('id') or (attributes.get('name') if tag == 'a' else None)
        if anchor:
            self.anchors.setdefault(anchor, len(self.blocks))

    def handle_endtag(self, tag: str) -> None:
        if tag == self._tag:
            self._flush()

    def handle_data(self, data: str) -> None:
        if self._tag:
            self._parts.append(data)

    def close(self) -> None:
        super().close()
        self._flush()

    def _flush(self) -> None:
        text = normalize_text(" ".join(self._parts))
        if self._tag and text:
            self.blocks.append((self._tag, text))
        self._tag = None
        self._parts = []


def normalize_text(text: str) -> str:
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s*\n\s*", " ", text)
    return text.strip()


def _safe_resolve(base: str, relative: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(urlsplit(relative).path)))


def _epub_toc(archive, opf, manifest, media_types):
    """Navigation anchors describe chapters; spine resources only define order."""
    entries = []
    for item in opf.findall('.//{*}manifest/{*}item'):
        item_id = item.attrib.get('id')
        is_nav = 'nav' in item.attrib.get('properties', '').split()
        is_ncx = media_types.get(item_id) == 'application/x-dtbncx+xml'
        if not (is_nav or is_ncx) or item_id not in manifest:
            continue
        path = manifest[item_id]
        try:
            root = ElementTree.fromstring(archive.read(path))
        except (KeyError, ElementTree.ParseError):
            continue
        pairs = []
        if is_ncx:
            for point in root.findall('.//{*}navPoint'):
                label = point.find('./{*}navLabel/{*}text')
                target = point.find('./{*}content')
                if label is not None and target is not None:
                    pairs.append((''.join(label.itertext()), target.attrib.get('src', '')))
        else:
            for nav in root.findall('.//{*}nav'):
                kind = nav.attrib.get('{http://www.idpf.org/2007/ops}type', '')
                if 'toc' not in kind.split():
                    continue
                pairs.extend((''.join(a.itertext()), a.attrib.get('href', '')) for a in nav.findall('.//{*}a'))
        for label, href in pairs:
            url = urlsplit(href)
            if not url.scheme and not url.netloc and href and normalize_text(label):
                entries.append((_safe_resolve(path, href), unquote(url.fragment), normalize_text(label)))
        if entries and is_nav:
            return entries
    return entries


def _epub_title(root: ElementTree.Element) -> str:
    namespaces = {
        "dc": "http://purl.org/dc/elements/1.1/",
        "opf": "http://www.idpf.org/2007/opf",
    }
    title = root.find(".//dc:title", namespaces)
    if title is not None and title.text:
        return title.text.strip()
    return "未命名书籍"


def _parse_epub(content: bytes, filename: str) -> ParseResult:
    file_hash = hashlib.sha256(content).hexdigest()
    issues: list[dict[str, Any]] = []
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise ParseError("INVALID_EPUB", "EPUB 文件结构损坏") from exc

    infos = archive.infolist()
    total_size = sum(info.file_size for info in infos)
    if total_size > MAX_EXTRACTED_BYTES:
        raise ParseError("EXPANDED_TOO_LARGE", "EPUB 解压后体积超过限制")
    for info in infos:
        normalized = posixpath.normpath(info.filename)
        if normalized.startswith("../") or normalized.startswith("/"):
            raise ParseError("UNSAFE_ARCHIVE", "EPUB 包含不安全路径")

    try:
        container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
        rootfile = container.find(
            ".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile"
        )
        if rootfile is None:
            raise ParseError("INVALID_EPUB", "EPUB 缺少 OPF 清单")
        opf_path = rootfile.attrib["full-path"]
        opf = ElementTree.fromstring(archive.read(opf_path))
    except KeyError as exc:
        raise ParseError("INVALID_EPUB", "EPUB 缺少必要文件") from exc

    title = _epub_title(opf)
    manifest: dict[str, str] = {}
    media_types: dict[str, str] = {}
    for item in opf.findall(".//{http://www.idpf.org/2007/opf}item"):
        item_id = item.attrib.get("id")
        href = item.attrib.get("href")
        if item_id and href:
            manifest[item_id] = _safe_resolve(opf_path, href)
            media_types[item_id] = item.attrib.get("media-type", "")

    spine_ids = [
        item.attrib.get("idref")
        for item in opf.findall(".//{http://www.idpf.org/2007/opf}itemref")
    ]
    toc = _epub_toc(archive, opf, manifest, media_types)
    boundaries = {}
    source_count = 0
    chapters: list[ParsedChapter] = []
    for chapter_ordinal, item_id in enumerate(spine_ids, start=1):
        if not item_id or item_id not in manifest:
            continue
        resource = manifest[item_id]
        if media_types.get(item_id) not in {
            "application/xhtml+xml",
            "text/html",
            "application/xml",
        }:
            continue
        try:
            raw = archive.read(resource).decode("utf-8", errors="replace")
        except KeyError:
            issues.append(
                {
                    "code": "MISSING_RESOURCE",
                    "message": f"章节资源缺失：{resource}",
                    "source_path": resource,
                }
            )
            continue
        extractor = _TextExtractor()
        extractor.feed(raw)
        extractor.close()
        blocks = [(tag, text) for tag, text in extractor.blocks if text]
        for target, fragment, label in toc:
            if target != resource:
                continue
            block_index = extractor.anchors.get(fragment) if fragment else 0
            if block_index is None:
                issues.append({'code': 'TOC_ANCHOR_MISSING', 'message': f'目录锚点缺失：{label}', 'source_path': resource})
                continue
            offset = source_count + sum(len(text) >= 2 for _, text in blocks[:block_index])
            boundaries.setdefault(offset, label)
        heading = next((text for tag, text in blocks if tag in {"h1", "h2", "h3"}), None)
        chapter_title = heading or f"第 {chapter_ordinal} 章"
        paragraphs: list[ParsedParagraph] = []
        for paragraph_ordinal, (_, text) in enumerate(blocks, start=1):
            if len(text) < 2:
                continue
            paragraphs.append(
                ParsedParagraph(
                    text=text,
                    anchor={
                        "format": "epub",
                        "resource": resource,
                        "block_path": f"/html/body/*[{paragraph_ordinal}]",
                        "char_start": 0,
                        "char_end": len(text),
                        "cfi": f"epubcfi(/6/{chapter_ordinal * 2}!/4/2/{paragraph_ordinal * 2})",
                    },
                )
            )
        chapters.append(
            ParsedChapter(
                title=chapter_title,
                paragraphs=paragraphs,
                source_path=resource,
            )
        )
        source_count += len(paragraphs)

    if boundaries:
        original = [p for chapter in chapters for p in chapter.paragraphs]
        valid = sorted((i, label) for i, label in boundaries.items() if i < len(original))
        if valid and valid[0][0] > 0:
            valid.insert(0, (0, '前置内容'))
        if valid:
            chapters = [
                ParsedChapter(title=label, paragraphs=original[start:valid[i + 1][0] if i + 1 < len(valid) else len(original)], source_path=original[start].anchor['resource'])
                for i, (start, label) in enumerate(valid)
            ]
            if [p for chapter in chapters for p in chapter.paragraphs] != original:
                raise ParseError('EPUB_COVERAGE_ERROR', '目录切分未完整覆盖已提取原文')

    if not chapters or not any(chapter.paragraphs for chapter in chapters):
        raise ParseError("NO_READABLE_TEXT", "EPUB 中没有可读取的正文")
    return _finalize_result(title, "epub", file_hash, chapters, issues, filename)


def _extract_pdf_outline(reader: PdfReader) -> list[tuple[str, int]]:
    outline: list[tuple[str, int]] = []

    def walk(items: list[Any]) -> None:
        for item in items:
            if isinstance(item, list):
                walk(item)
                continue
            title = getattr(item, "title", None)
            try:
                page_index = reader.get_destination_page_number(item)
            except Exception:
                page_index = 0
            if title:
                outline.append((normalize_text(str(title)), page_index))

    try:
        walk(reader.outline)
    except Exception:
        return []
    return outline


def _paragraphize_page(text: str) -> list[str]:
    lines = [normalize_text(line) for line in text.splitlines()]
    lines = [line for line in lines if len(line) > 1]
    if not lines:
        return []
    paragraphs: list[str] = []
    current: list[str] = []
    for line in lines:
        current.append(line)
        punctuation = line.endswith(("。", "！", "？", ".", "!", "?", "：", ":"))
        if punctuation and len(" ".join(current)) >= 48:
            paragraphs.append(" ".join(current))
            current = []
    if current:
        paragraphs.append(" ".join(current))
    return paragraphs


def _parse_pdf(content: bytes, filename: str) -> ParseResult:
    file_hash = hashlib.sha256(content).hexdigest()
    try:
        reader = PdfReader(io.BytesIO(content))
    except Exception as exc:
        raise ParseError("INVALID_PDF", "PDF 文件无法读取") from exc
    if reader.is_encrypted:
        try:
            unlocked = reader.decrypt("")
        except Exception:
            unlocked = 0
        if not unlocked:
            raise ParseError("ENCRYPTED_FILE", "暂不支持加密 PDF")

    metadata_title = ""
    if reader.metadata and reader.metadata.title:
        metadata_title = normalize_text(str(reader.metadata.title))
    title = metadata_title or Path(filename).stem
    page_texts: list[str] = []
    issues: list[dict[str, Any]] = []
    for page_index, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        page_texts.append(text)
        if len(normalize_text(text)) < 20:
            issues.append(
                {
                    "code": "LOW_TEXT_PAGE",
                    "message": f"第 {page_index + 1} 页可读文本较少",
                    "page_index": page_index,
                }
            )

    total_chars = sum(len(normalize_text(text)) for text in page_texts)
    if total_chars < 80:
        raise ParseError("NO_READABLE_TEXT", "未检测到足够的文字内容，可能是扫描件")

    outline = _extract_pdf_outline(reader)
    chapters: list[ParsedChapter] = []
    if outline:
        for index, (chapter_title, start_page) in enumerate(outline):
            end_page = outline[index + 1][1] - 1 if index + 1 < len(outline) else len(
                page_texts
            ) - 1
            if end_page < start_page:
                end_page = start_page
            paragraphs: list[ParsedParagraph] = []
            ordinal = 1
            for page_index in range(start_page, end_page + 1):
                for text in _paragraphize_page(page_texts[page_index]):
                    paragraphs.append(
                        ParsedParagraph(
                            text=text,
                            anchor={
                                "format": "pdf",
                                "page_index": page_index,
                                "block_index": ordinal - 1,
                                "char_start": 0,
                                "char_end": len(text),
                                "bbox": [72.0, 72.0, 523.0, 760.0],
                                "bbox_unit": "pdf_point",
                            },
                        )
                    )
                    ordinal += 1
            chapters.append(
                ParsedChapter(
                    title=chapter_title,
                    paragraphs=paragraphs,
                    page_start=start_page + 1,
                    page_end=end_page + 1,
                )
            )
    else:
        page_batch = max(1, min(12, len(page_texts)))
        for start_page in range(0, len(page_texts), page_batch):
            page_slice = page_texts[start_page : start_page + page_batch]
            paragraphs = []
            ordinal = 1
            for relative_page, text in enumerate(page_slice):
                for paragraph_text in _paragraphize_page(text):
                    paragraphs.append(
                        ParsedParagraph(
                            text=paragraph_text,
                            anchor={
                                "format": "pdf",
                                "page_index": start_page + relative_page,
                                "block_index": ordinal - 1,
                                "char_start": 0,
                                "char_end": len(paragraph_text),
                                "bbox": [72.0, 72.0, 523.0, 760.0],
                                "bbox_unit": "pdf_point",
                            },
                        )
                    )
                    ordinal += 1
            chapter_number = start_page // page_batch + 1
            chapters.append(
                ParsedChapter(
                    title=f"第 {chapter_number} 节",
                    paragraphs=paragraphs,
                    page_start=start_page + 1,
                    page_end=min(start_page + page_batch, len(page_texts)),
                )
            )
    return _finalize_result(title, "pdf", file_hash, chapters, issues, filename)


def _parse_txt(content: bytes, filename: str) -> ParseResult:
    file_hash = hashlib.sha256(content).hexdigest()
    text = content.decode("utf-8", errors="replace")
    if len(text) < 40:
        raise ParseError("NO_READABLE_TEXT", "文本内容过短")
    lines = text.splitlines()
    chapter_matches = [
        (index, line.strip())
        for index, line in enumerate(lines)
        if re.fullmatch(
            r"第[零〇一二两三四五六七八九十百千\d]+(?:章|节|部分|部)"
            r"(?:[ \t　]+[^。！？!?；;]{1,60})?",
            line.strip(),
        )
    ]
    chapters: list[ParsedChapter] = []
    if chapter_matches:
        for match_index, (line_index, title) in enumerate(chapter_matches):
            end = (
                chapter_matches[match_index + 1][0]
                if match_index + 1 < len(chapter_matches)
                else len(lines)
            )
            # Some TXT editions put the chapter number and name in separate
            # blocks. Only accept a short standalone next block as the name;
            # leave it in the source so title detection cannot lose prose.
            if re.fullmatch(r"第[零〇一二两三四五六七八九十百千\d]+(?:章|节|部分|部)", title):
                next_index = next((i for i in range(line_index + 1, end) if lines[i].strip()), None)
                if next_index is not None:
                    candidate = lines[next_index].strip()
                    if (len(candidate) <= 60
                        and not re.search(r"[。！？!?；;]", candidate)
                        and (next_index + 1 == end or not lines[next_index + 1].strip())):
                        title = f"{title} {candidate}"
            paragraphs = [
                normalize_text(paragraph)
                for paragraph in re.split(r"\n\s*\n", "\n".join(lines[line_index + 1 : end]))
                if len(normalize_text(paragraph)) > 1
            ]
            chapters.append(
                ParsedChapter(
                    title=title,
                    paragraphs=[
                        ParsedParagraph(
                            text=paragraph,
                            anchor={
                                "format": "txt",
                                "block_index": ordinal,
                                "char_start": 0,
                                "char_end": len(paragraph),
                            },
                        )
                        for ordinal, paragraph in enumerate(paragraphs, start=1)
                    ],
                )
            )
    else:
        paragraphs = [
            normalize_text(paragraph)
            for paragraph in re.split(r"\n\s*\n", text)
            if len(normalize_text(paragraph)) > 1
        ]
        chapters = [
            ParsedChapter(
                title="正文",
                paragraphs=[
                    ParsedParagraph(
                        text=paragraph,
                        anchor={
                            "format": "txt",
                            "block_index": ordinal,
                            "char_start": 0,
                            "char_end": len(paragraph),
                        },
                    )
                    for ordinal, paragraph in enumerate(paragraphs, start=1)
                ],
            )
        ]
    return _finalize_result(
        Path(filename).stem,
        "txt",
        file_hash,
        chapters,
        [],
        filename,
    )


def _finalize_result(
    title: str,
    format_name: str,
    file_hash: str,
    chapters: list[ParsedChapter],
    issues: list[dict[str, Any]],
    filename: str,
) -> ParseResult:
    char_count = sum(
        len(paragraph.text)
        for chapter in chapters
        for paragraph in chapter.paragraphs
    )
    if char_count > MAX_CHARACTERS:
        raise ParseError(
            "CHARACTER_LIMIT",
            f"解析后约 {char_count} 字符，超过首版 {MAX_CHARACTERS} 字符上限",
        )
    clean_chapters = [
        ParsedChapter(
            title=chapter.title.strip() or f"第 {index + 1} 章",
            paragraphs=chapter.paragraphs,
            source_path=chapter.source_path,
            page_start=chapter.page_start,
            page_end=chapter.page_end,
        )
        for index, chapter in enumerate(chapters)
        if chapter.paragraphs
    ]
    return ParseResult(
        title=title.strip() or Path(filename).stem,
        format=format_name,
        file_hash=file_hash,
        char_count=char_count,
        chapters=clean_chapters,
        issues=issues,
    )


def parse_file(content: bytes, filename: str) -> ParseResult:
    if not content:
        raise ParseError("EMPTY_FILE", "文件为空")
    if len(content) > MAX_FILE_BYTES:
        raise ParseError("FILE_TOO_LARGE", "文件超过 50 MB 上限")
    extension = Path(filename).suffix.lower()
    if extension == ".epub":
        return _parse_epub(content, filename)
    if extension == ".pdf":
        return _parse_pdf(content, filename)
    if extension == ".txt":
        return _parse_txt(content, filename)
    raise ParseError("UNSUPPORTED_FORMAT", "首版仅支持 EPUB、文字型 PDF 和测试用 TXT")
