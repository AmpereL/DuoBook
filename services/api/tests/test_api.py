from __future__ import annotations

import io
import zipfile


def make_epub() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "mimetype",
            "application/epub+zip",
        )
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
            <container version="1.0"
              xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles>
                <rootfile full-path="OEBPS/content.opf"
                  media-type="application/oebps-package+xml"/>
              </rootfiles>
            </container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0" encoding="utf-8"?>
            <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
              <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:title>测试论述书</dc:title>
                <dc:creator>测试作者</dc:creator>
              </metadata>
              <manifest>
                <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
                <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
              </manifest>
              <spine>
                <itemref idref="ch1"/>
                <itemref idref="ch2"/>
              </spine>
            </package>""",
        )
        archive.writestr(
            "OEBPS/ch1.xhtml",
            """<html xmlns="http://www.w3.org/1999/xhtml"><body>
              <h1>第一章 提出问题</h1>
              <p>清晰的问题可以让阅读拥有方向。没有问题的阅读容易变成信息堆积。</p>
              <p>如果目标过于宽泛，就需要先缩小范围，再开始寻找证据。</p>
            </body></html>""",
        )
        archive.writestr(
            "OEBPS/ch2.xhtml",
            """<html xmlns="http://www.w3.org/1999/xhtml"><body>
              <h1>第二章 验证观点</h1>
              <p>观点必须由原文中的证据支持，而不是由共同关键词推断。</p>
              <p>当引用无法定位时，系统应该明确提示，而不是猜测相似段落。</p>
            </body></html>""",
        )
    return buffer.getvalue()


def test_health_and_demo_book(client):
    health = client.get("/api/v1/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    response = client.get("/api/v1/books")
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["title"] == "学习的方法"
    assert items[0]["chapter_count"] == 4
    assert items[0]["read_count"] == 11


def test_map_has_navigation_relations_and_valid_sources(client):
    response = client.get("/api/v1/books/book_learning/map")
    assert response.status_code == 200
    payload = response.json()
    assert payload["map_version"]["status"] == "ready"
    assert any(node["type"] == "question" for node in payload["nodes"])
    assert any(node["type"] == "condition" for node in payload["nodes"])
    assert payload["relations"]
    assert all(relation["origin"] in {"author", "inferred"} for relation in payload["relations"])

    for node in payload["nodes"]:
        if node["type"] == "claim":
            assert node["sources"], f"claim node {node['id']} should have a source"
            assert all(source["quote"] for source in node["sources"])


def test_reader_state_exploration_and_notes(client):
    reader = client.get("/api/v1/books/book_learning/paragraphs/p_recall_3")
    assert reader.status_code == 200
    assert reader.json()["paragraph"]["text"].startswith("合上材料")
    assert reader.json()["related_nodes"]

    unread = client.put(
        "/api/v1/books/book_learning/paragraphs/p_recall_3/read",
        json={"read": False},
    )
    assert unread.status_code == 200
    assert unread.json()["read"] is False

    marked = client.put(
        "/api/v1/books/book_learning/paragraphs/p_recall_3/read",
        json={"read": True},
    )
    assert marked.status_code == 200
    assert marked.json()["read"] is True

    explored = client.post("/api/v1/books/book_learning/explored/node_recall_claim")
    assert explored.status_code == 204

    state = client.put(
        "/api/v1/books/book_learning/reading-state",
        json={
            "map_version_id": "map_learning_v1",
            "node_id": "node_recall_claim",
            "paragraph_id": "p_recall_3",
            "path": ["node_root", "node_recall", "node_recall_claim"],
        },
    )
    assert state.status_code == 200
    assert state.json()["last_paragraph_id"] == "p_recall_3"

    created = client.post(
        "/api/v1/notes",
        json={
            "paragraph_id": "p_recall_3",
            "body": "这解释了主动提取为什么能暴露知识缺口。",
        },
    )
    assert created.status_code == 201
    note_id = created.json()["id"]

    updated = client.patch(
        f"/api/v1/notes/{note_id}",
        json={"body": "更新后的笔记内容。"},
    )
    assert updated.status_code == 200
    assert updated.json()["body"] == "更新后的笔记内容。"

    notes = client.get("/api/v1/notes?book_id=book_learning")
    assert notes.status_code == 200
    payload = notes.json()
    assert any(note["id"] == note_id for note in payload["items"])
    matched = next(note for note in payload["items"] if note["id"] == note_id)
    assert matched["kind"] == "paragraph_note"
    assert matched["body"] == "更新后的笔记内容。"
    assert payload["counts"]["paragraph_note"] >= 1

    deleted = client.delete(f"/api/v1/notes/{note_id}")
    assert deleted.status_code == 204


def test_annotation_requires_an_exact_original_text_anchor(client):
    paragraph_id = "p_recall_3"
    text = "合上材料尝试回忆"
    annotation = client.post(
        "/api/v1/annotations",
        json={
            "paragraph_id": paragraph_id,
            "start_offset": 0,
            "end_offset": len(text),
            "quote": text,
            "body": "这里把练习方式和发现知识缺口连起来。",
        },
    )
    assert annotation.status_code == 201, annotation.text
    assert annotation.json()["anchors"][0]["quote"] == text

    mismatched = client.post(
        "/api/v1/annotations",
        json={
            "paragraph_id": paragraph_id,
            "start_offset": 0,
            "end_offset": len(text),
            "quote": "不是原文",
            "body": "不能保存。",
        },
    )
    assert mismatched.status_code == 422
    assert mismatched.json()["error"]["code"] == "ANNOTATION_QUOTE_MISMATCH"

    reader = client.get(f"/api/v1/books/book_learning/paragraphs/{paragraph_id}")
    assert reader.status_code == 200
    assert reader.json()["annotations"][0]["body"].startswith("这里把练习")

    notes = client.get("/api/v1/notes?book_id=book_learning").json()
    annotation_items = [item for item in notes["items"] if item["kind"] == "annotation"]
    assert notes["counts"]["annotation"] >= 1
    assert annotation_items[0]["quote"] == text
    assert annotation_items[0]["body"].startswith("这里把练习")
    assert annotation_items[0]["link_path"].startswith("/books/book_learning/")
    assert annotation_items[0]["paragraph_text"]

    only_annotations = client.get("/api/v1/notes?book_id=book_learning&kind=annotation").json()
    assert only_annotations["items"]
    assert all(item["kind"] == "annotation" for item in only_annotations["items"])

    deleted = client.delete(f"/api/v1/annotations/{annotation.json()['id']}")
    assert deleted.status_code == 204
    after_delete = client.get("/api/v1/notes?book_id=book_learning&kind=annotation").json()
    assert all(item["id"] != annotation.json()["id"] for item in after_delete["items"])


def test_selected_text_can_be_saved_as_excerpt_without_note(client):
    quote = "合上材料尝试回忆"
    created = client.post(
        "/api/v1/annotations",
        json={
            "paragraph_id": "p_recall_3",
            "start_offset": 0,
            "end_offset": len(quote),
            "quote": quote,
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["body"] == ""
    assert created.json()["anchors"][0]["quote"] == quote

    notes = client.get("/api/v1/notes?book_id=book_learning&kind=annotation").json()
    excerpt = next(item for item in notes["items"] if item["id"] == created.json()["id"])
    assert excerpt["body"] == ""
    assert excerpt["quote"] == quote

    deleted = client.delete(f"/api/v1/annotations/{created.json()['id']}")
    assert deleted.status_code == 204


def test_unsplit_chapter_returns_saved_highlights_and_notes(client):
    chapter_path = "/api/v1/books/book_learning/chapters/chapter_goal"
    before = client.get(chapter_path)
    assert before.status_code == 200
    assert before.json()["chapter"]["status"] == "unprocessed"
    paragraph = before.json()["paragraphs"][0]
    quote = paragraph["text"][:4]

    created = client.post(
        "/api/v1/annotations",
        json={
            "paragraph_id": paragraph["id"],
            "start_offset": 0,
            "end_offset": len(quote),
            "quote": quote,
            "body": "未拆分前记录的理解。",
        },
    )
    assert created.status_code == 201, created.text

    after = client.get(chapter_path)
    assert after.status_code == 200
    saved = next(item for item in after.json()["annotations"] if item["id"] == created.json()["id"])
    assert saved["anchors"][0]["paragraph_id"] == paragraph["id"]
    assert saved["body"] == "未拆分前记录的理解。"

    notes = client.get("/api/v1/notes?book_id=book_learning&kind=annotation").json()
    item = next(item for item in notes["items"] if item["id"] == created.json()["id"])
    assert item["link_path"] == "/books/book_learning/chapters/chapter_goal"


def test_search_and_export(client):
    search = client.get("/api/v1/books/book_learning/search?q=反馈")
    assert search.status_code == 200
    assert search.json()["total"] >= 2

    export = client.get("/api/v1/books/book_learning/export")
    assert export.status_code == 200
    assert "attachment" in export.headers["content-disposition"]
    assert '"title": "学习的方法"' in export.text
    assert '"section_notes"' in export.text
    assert '"annotations"' in export.text
    assert '"paragraph_notes"' in export.text


def test_all_notes_export_in_markdown_and_json(client):
    paragraph = client.get("/api/v1/books/book_learning/chapters/chapter_goal").json()["paragraphs"][0]
    quote = paragraph["text"][:4]
    created = client.post(
        "/api/v1/annotations",
        json={"paragraph_id": paragraph["id"], "start_offset": 0, "end_offset": len(quote), "quote": quote, "body": "导出测试笔记"},
    )
    assert created.status_code == 201
    markdown = client.get("/api/v1/notes/export?format=markdown")
    assert markdown.status_code == 200
    assert "attachment" in markdown.headers["content-disposition"]
    assert "> " + quote in markdown.text
    assert "导出测试笔记" in markdown.text
    exported_json = client.get("/api/v1/notes/export?format=json")
    assert exported_json.status_code == 200
    assert any(item["id"] == created.json()["id"] for item in exported_json.json()["notes"])


def test_model_settings_keep_key_private_and_select_provider(client):
    initial = client.get("/api/v1/settings/model")
    assert initial.status_code == 200
    assert initial.json()["provider"] == "local"
    assert "api_key" not in initial.json()

    configured = client.put(
        "/api/v1/settings/model",
        json={
            "provider": "anthropic",
            "base_url": "https://api.anthropic.com/",
            "api_key": "test-secret",
            "model": "claude-test",
            "timeout": 45,
        },
    )
    assert configured.status_code == 200
    assert configured.json()["provider"] == "anthropic"
    assert configured.json()["has_api_key"] is True
    assert "test-secret" not in configured.text

    retained = client.put(
        "/api/v1/settings/model",
        json={
            "provider": "anthropic",
            "base_url": "",
            "model": "claude-next",
            "timeout": 60,
        },
    )
    assert retained.status_code == 200
    assert retained.json()["model"] == "claude-next"


def test_model_connection_test_accepts_local_generator(client):
    response = client.post(
        "/api/v1/settings/model/test",
        json={
            "provider": "local",
            "base_url": "",
            "model": "",
            "timeout": 60,
        },
    )
    assert response.status_code == 200
    assert response.json()["message"] == "连接成功，可以开始解析书籍。"


def test_epub_upload_structure_generation_and_delete(client):
    epub = make_epub()
    upload = client.post(
        "/api/v1/books/upload",
        files={"file": ("test-book.epub", epub, "application/epub+zip")},
    )
    assert upload.status_code == 201, upload.text
    payload = upload.json()
    book_id = payload["book"]["id"]
    assert payload["book"]["status"] == "awaiting_structure_confirmation"
    assert len(payload["structure"]["chapters"]) == 2

    duplicate = client.post(
        "/api/v1/books/upload",
        files={"file": ("test-book-copy.epub", epub, "application/epub+zip")},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "DUPLICATE_BOOK"

    chapters = payload["structure"]["chapters"]
    structure = client.patch(
        f"/api/v1/books/{book_id}/structure",
        json={
            "title": "修订后的测试书",
            "author": "测试作者",
            "chapters": [
                {
                    "id": chapters[0]["id"],
                    "title": "问题与方向",
                    "ordinal": 1,
                    "include": True,
                },
                {
                    "id": chapters[1]["id"],
                    "title": "观点与证据",
                    "ordinal": 2,
                    "include": True,
                },
            ],
        },
    )
    assert structure.status_code == 200
    assert structure.json()["book"]["title"] == "修订后的测试书"

    chapter_list = client.get(f"/api/v1/books/{book_id}/chapters")
    assert chapter_list.status_code == 200, chapter_list.text
    assert all(item["status"] == "unprocessed" for item in chapter_list.json()["chapters"])

    whole_book_generation = client.post(f"/api/v1/books/{book_id}/generation-runs")
    assert whole_book_generation.status_code == 422
    assert whole_book_generation.json()["error"]["code"] == "CHAPTER_REQUIRED"

    generation = client.post(
        f"/api/v1/books/{book_id}/chapters/{chapters[0]['id']}/split-runs"
    )
    assert generation.status_code == 202
    job_id = generation.json()["id"]
    job = client.get(f"/api/v1/jobs/{job_id}")
    assert job.status_code == 200
    assert job.json()["status"] in {"running", "completed"}

    chapter = client.get(f"/api/v1/books/{book_id}/chapters/{chapters[0]['id']}")
    assert chapter.status_code == 200, chapter.text
    chapter_payload = chapter.json()
    assert chapter_payload["chapter"]["status"] == "ready"
    assert len(chapter_payload["units"]) == 1
    assert chapter_payload["paragraphs"]
    untouched = client.get(f"/api/v1/books/{book_id}/chapters/{chapters[1]['id']}")
    assert untouched.json()["chapter"]["status"] == "unprocessed"
    unit = client.get(f"/api/v1/reading-units/{chapter_payload['units'][0]['id']}")
    assert unit.status_code == 200
    assert unit.json()["paragraphs"]
    assert unit.json()["sections"][0]["kind"] == "original"
    assert len(unit.json()["sections"]) == 9
    saved_section = client.patch(
        f"/api/v1/reading-units/{chapter_payload['units'][0]['id']}/sections/8",
        json={"body": "我还需要核对这一章的关键前提。"},
    )
    assert saved_section.status_code == 200
    assert saved_section.json()["body"] == "我还需要核对这一章的关键前提。"

    section_notes = client.get(f"/api/v1/notes?book_id={book_id}&kind=section").json()
    assert section_notes["counts"]["section"] >= 1
    section_item = next(
        item for item in section_notes["items"] if item["id"] == saved_section.json()["id"]
    )
    assert section_item["section_ordinal"] == 8
    assert section_item["reading_unit_id"] == chapter_payload["units"][0]["id"]
    assert section_item["link_path"].endswith(f"/units/{chapter_payload['units'][0]['id']}")
    original_locked = client.patch(
        f"/api/v1/reading-units/{chapter_payload['units'][0]['id']}/sections/1",
        json={"body": "不能改写原文"},
    )
    assert original_locked.status_code == 422
    old_unit_id = chapter_payload['units'][0]['id']
    repeated = client.post(f"/api/v1/books/{book_id}/chapters/{chapters[0]['id']}/split-runs")
    assert repeated.status_code == 202
    refreshed = client.get(f"/api/v1/books/{book_id}/chapters/{chapters[0]['id']}").json()
    assert refreshed['units'][0]['id'] != old_unit_id
    assert len(refreshed['history']) == 2
    previous = client.get(f"/api/v1/reading-units/{old_unit_id}").json()
    assert previous['sections'][7]['body'] == '我还需要核对这一章的关键前提。'
    assert previous['chapter']['units'][0]['id'] == old_unit_id

    search = client.get(f"/api/v1/books/{book_id}/search?q=证据")
    assert search.status_code == 200
    assert search.json()["total"] >= 1

    deleted = client.delete(f"/api/v1/books/{book_id}")
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/books/{book_id}").status_code == 404


def test_rejects_unsupported_and_empty_files(client):
    unsupported = client.post(
        "/api/v1/books/upload",
        files={"file": ("notes.md", b"# not supported", "text/markdown")},
    )
    assert unsupported.status_code == 422
    assert unsupported.json()["error"]["code"] == "UNSUPPORTED_FORMAT"

    empty = client.post(
        "/api/v1/books/upload",
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    assert empty.status_code == 400
    assert empty.json()["error"]["code"] == "EMPTY_FILE"
