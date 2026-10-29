from __future__ import annotations

import io
import zipfile

import pytest

from app.parsers import ParseError, parse_file
from tests.test_api import make_epub


def test_epub_parser_extracts_spine_and_paragraph_anchors():
    result = parse_file(make_epub(), "test-book.epub")
    assert result.title == "测试论述书"
    assert result.format == "epub"
    assert len(result.chapters) == 2
    assert result.chapters[0].title == "第一章 提出问题"
    assert result.chapters[0].paragraphs[0].anchor["format"] == "epub"
    assert result.chapters[0].paragraphs[0].anchor["resource"] == "OEBPS/ch1.xhtml"


def test_epub_ncx_anchors_split_multiple_chapters_within_one_spine_document():
    archive_bytes = io.BytesIO()
    with zipfile.ZipFile(archive_bytes, "w") as archive:
        archive.writestr("META-INF/container.xml", '''<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>''')
        archive.writestr("OPS/content.opf", '''<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>多章 EPUB</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="toc"><itemref idref="a"/><itemref idref="b"/></spine></package>''')
        archive.writestr("OPS/toc.ncx", '''<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>自序</text></navLabel><content src="a.xhtml#intro"/></navPoint><navPoint><navLabel><text>第一篇</text></navLabel><content src="a.xhtml#one"/></navPoint><navPoint><navLabel><text>第二篇</text></navLabel><content src="a.xhtml#two"/></navPoint><navPoint><navLabel><text>第三篇</text></navLabel><content src="b.xhtml"/></navPoint></navMap></ncx>''')
        archive.writestr("OPS/a.xhtml", '''<html><body><span id="intro"></span><p>序言的正文内容。</p><span id="one"></span><p>第一篇的正文内容。</p><span id="two"></span><p>第二篇的正文内容。</p></body></html>''')
        archive.writestr("OPS/b.xhtml", '''<html><body><p>第三篇的正文内容。</p></body></html>''')
    parsed = parse_file(archive_bytes.getvalue(), "multi.epub")
    assert [chapter.title for chapter in parsed.chapters] == ["自序", "第一篇", "第二篇", "第三篇"]
    assert [chapter.paragraphs[0].text for chapter in parsed.chapters] == [
        "序言的正文内容。", "第一篇的正文内容。", "第二篇的正文内容。", "第三篇的正文内容。"
    ]
    assert [chapter.paragraphs[0].anchor["resource"] for chapter in parsed.chapters] == [
        "OPS/a.xhtml", "OPS/a.xhtml", "OPS/a.xhtml", "OPS/b.xhtml"
    ]


def test_txt_parser_detects_chinese_chapters():
    content = """第一章 开始

第一段正文，用来测试章节识别和段落切分。

第二段正文，内容需要足够长以通过最短文本限制。

第二章 继续

这段内容中的文字也应该被完整保留。""".encode()
    result = parse_file(content, "sample.txt")
    assert result.format == "txt"
    assert len(result.chapters) == 2
    assert result.chapters[0].paragraphs


def test_parser_rejects_encrypted_or_invalid_pdf():
    with pytest.raises(ParseError) as error:
        parse_file(b"not-a-pdf", "broken.pdf")
    assert error.value.code == "INVALID_PDF"


def test_txt_split_titles_and_chapter_references_preserve_source_order():
    content = """第1章

学习第二层次思维

第一章的正文需要完整保留，不能因识别标题而消失。

第2章

理解市场有效性及局限性

第1章所描述的投资者认为预知未来是有可能的，因此他们构想未来。

这一段仍然属于第二章，不应该被前面的引用切开。

第3章 完整标题

最后一章的正文也需要完整保留。"""
    result = parse_file(content.encode(), "split-titles.txt")
    assert [c.title for c in result.chapters] == [
        "第1章 学习第二层次思维", "第2章 理解市场有效性及局限性", "第3章 完整标题",
    ]
    assert "第1章所描述的" in result.chapters[1].paragraphs[1].text
    assert result.chapters[0].paragraphs[0].text == "学习第二层次思维"
    assert [p.text for c in result.chapters for p in c.paragraphs] == [
        block for block in content.split("\n\n")
        if block not in {"第1章", "第2章", "第3章 完整标题"}
    ]
