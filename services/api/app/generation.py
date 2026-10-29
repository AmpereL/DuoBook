from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from .db import Database, new_id, utc_now
from .providers import ChapterProvider, ProviderError, get_chapter_provider
from .reading_units import ReadingUnitDraft, persist_unit_set, unit_drafts_from_plan


ProgressCallback = Callable[[int, int, str], None]

# Remote models can reliably compare a focused excerpt, but feeding an entire
# book section (often tens of thousands of characters) makes its JSON response
# more likely to be cut off. Keep source IDs intact while splitting long parts.
MAX_MODEL_BATCH_CHARS = 24_000
MAX_MODEL_BATCH_PARAGRAPHS = 180


def _clip(text: str, limit: int) -> str:
    clean = re.sub(r"\s+", " ", text.strip())
    return clean if len(clean) <= limit else f"{clean[:limit].rstrip('，。；; ')}…"


def _paragraph_batches(
    paragraphs: list[dict[str, Any]],
    max_chars: int = MAX_MODEL_BATCH_CHARS,
    max_paragraphs: int = MAX_MODEL_BATCH_PARAGRAPHS,
) -> list[list[dict[str, Any]]]:
    """Split long chapters without cutting a paragraph or changing source IDs."""
    batches: list[list[dict[str, Any]]] = []
    batch: list[dict[str, Any]] = []
    size = 0
    for paragraph in paragraphs:
        text_size = len(str(paragraph.get("text", "")))
        if batch and (size + text_size > max_chars or len(batch) >= max_paragraphs):
            batches.append(batch)
            batch = []
            size = 0
        batch.append(paragraph)
        size += text_size
    if batch:
        batches.append(batch)
    return batches


def _balanced_claims(claim_batches: list[list[Any]], limit: int = 8) -> list[Any]:
    """Keep a chapter map compact while retaining coverage across each excerpt."""
    selected: list[Any] = []
    max_depth = max((len(claims) for claims in claim_batches), default=0)
    for depth in range(max_depth):
        for claims in claim_batches:
            if depth < len(claims):
                selected.append(claims[depth])
                if len(selected) >= limit:
                    return selected
    return selected


def _extract_claim_batches(
    provider: ChapterProvider,
    book_title: str,
    chapter_title: str,
    paragraphs: list[dict[str, Any]],
    retries_remaining: int = 4,
) -> list[list[Any]]:
    """Retry a problematic excerpt as two smaller, source-preserving excerpts."""
    try:
        return [provider.extract_claims(book_title, chapter_title, paragraphs)]
    except ProviderError as exc:
        recoverable = (
            "timed out" in str(exc).lower()
            or "JSON" in str(exc)
            or "未返回可解析" in str(exc)
        )
        if not recoverable or retries_remaining <= 0 or len(paragraphs) < 2:
            raise
        midpoint = len(paragraphs) // 2
        return _extract_claim_batches(
            provider,
            book_title,
            chapter_title,
            paragraphs[:midpoint],
            retries_remaining - 1,
        ) + _extract_claim_batches(
            provider,
            book_title,
            chapter_title,
            paragraphs[midpoint:],
            retries_remaining - 1,
        )


def _insert_node(
    connection: Any,
    map_version_id: str,
    parent_id: str | None,
    node_type: str,
    title: str,
    statement: str,
    summary: str,
    conditions: list[str],
    ordinal: int,
    origin: str = "author",
    confidence: float = 0.96,
) -> str:
    node_id = new_id("node")
    connection.execute(
        """
        INSERT INTO nodes (
            id, map_version_id, parent_id, type, title, statement, summary,
            conditions_json, origin, confidence, ordinal, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')
        """,
        (
            node_id,
            map_version_id,
            parent_id,
            node_type,
            title,
            statement,
            summary,
            Database.dumps(conditions),
            origin,
            confidence,
            ordinal,
        ),
    )
    return node_id


def _insert_source(
    connection: Any,
    node_id: str,
    paragraph: dict[str, Any],
    quote: str | None = None,
) -> None:
    text = quote or paragraph["text"]
    connection.execute(
        """
        INSERT INTO node_sources (
            id, node_id, paragraph_id, start_offset, end_offset, quote
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            new_id("src"),
            node_id,
            paragraph["id"],
            0,
            min(len(paragraph["text"]), len(text)),
            text,
        ),
    )


def create_structure_map(database: Database, book_id: str, version_id: str) -> str:
    """Publish a chapter-only map after import; no model call happens here."""
    book = database.one("SELECT * FROM books WHERE id = ?", (book_id,))
    if not book:
        raise ValueError("书籍不存在")
    map_version_id = new_id("map")
    chapters = database.query(
        "SELECT * FROM chapters WHERE version_id = ? ORDER BY ordinal", (version_id,)
    )
    with database.transaction() as connection:
        connection.execute(
            """
            INSERT INTO map_versions (id, book_version_id, status, prompt_version, model_route, created_at, published_at)
            VALUES (?, ?, 'ready', 'chapter-split-manual-1.0', 'no-model', ?, ?)
            """,
            (map_version_id, version_id, utc_now(), utc_now()),
        )
        root_id = _insert_node(
            connection, map_version_id, None, "question", f"《{book['title']}》从哪里开始读？",
            "先选择一个章节，再按内容理解拆成阅读单元。", "导入阶段只保留目录和原文，不自动调用模型。", [], 0,
            origin="author", confidence=1.0,
        )
        for ordinal, chapter in enumerate(chapters, start=1):
            node_id = _insert_node(
                connection, map_version_id, root_id, "theme", chapter["title"],
                "本章尚未拆分为阅读单元。", "选择本章后，系统才会完整阅读本章原文并提出语义单元。",
                [], ordinal, origin="author", confidence=1.0,
            )
            connection.execute(
                "INSERT INTO node_chapters (node_id, chapter_id) VALUES (?, ?)",
                (node_id, chapter["id"]),
            )
    return map_version_id


def _latest_unit_drafts(
    database: Database,
    chapter: dict[str, Any],
) -> list[ReadingUnitDraft]:
    unit_set = database.one(
        """
        SELECT id FROM unit_sets WHERE chapter_id = ? AND status = 'published'
        ORDER BY published_at DESC, created_at DESC LIMIT 1
        """,
        (chapter["id"],),
    )
    if not unit_set:
        return []
    rows = database.query(
        """
        SELECT ru.*, rup.paragraph_id
        FROM reading_units ru
        JOIN reading_unit_paragraphs rup ON rup.reading_unit_id = ru.id
        WHERE ru.unit_set_id = ? AND ru.status = 'published'
        ORDER BY ru.ordinal, rup.ordinal
        """,
        (unit_set["id"],),
    )
    grouped: dict[str, ReadingUnitDraft] = {}
    for row in rows:
        draft = grouped.get(row["id"])
        if not draft:
            draft = ReadingUnitDraft(
                title=row["title"], statement=row["statement"], summary=row["summary"], source_ids=[]
            )
            grouped[row["id"]] = draft
        draft.source_ids.append(row["paragraph_id"])
    return list(grouped.values())


def split_chapter(
    database: Database,
    book_id: str,
    version_id: str,
    chapter_id: str,
    on_progress: ProgressCallback | None = None,
    provider: ChapterProvider | None = None,
) -> dict[str, Any]:
    """Run chapter-split only for the chapter explicitly selected by the reader."""
    book = database.one("SELECT * FROM books WHERE id = ?", (book_id,))
    chapter = database.one(
        "SELECT * FROM chapters WHERE id = ? AND version_id = ?", (chapter_id, version_id)
    )
    if not book or not chapter:
        raise ValueError("书籍或章节不存在")
    paragraphs = database.query(
        "SELECT * FROM paragraphs WHERE chapter_id = ? AND status = 'ready' ORDER BY ordinal",
        (chapter_id,),
    )
    if not paragraphs:
        raise ValueError("本章没有可用原文")
    chapter_provider = provider or get_chapter_provider()
    if on_progress:
        on_progress(0, 1, "正在通读本章原文")

    plan = chapter_provider.plan_reading_units(book["title"], chapter["title"], paragraphs)
    drafts = unit_drafts_from_plan(chapter["title"], paragraphs, plan)
    if on_progress:
        on_progress(0, 1, "正在进行独立冷读")
    review_input = [
        {
            "title": draft.title,
            "start_paragraph_id": draft.source_ids[0],
            "paragraphs": [
                {"paragraph_id": paragraph["id"], "text": paragraph["text"]}
                for paragraph in paragraphs
                if paragraph["id"] in draft.source_ids
            ],
        }
        for draft in drafts
    ]
    review_status = plan.review_status
    if plan.review_status != "local_unreviewed":
        approved, issues = chapter_provider.review_reading_units(chapter["title"], review_input)
        if not approved:
            plan = chapter_provider.plan_reading_units(
                book["title"], chapter["title"], paragraphs, issues
            )
            drafts = unit_drafts_from_plan(chapter["title"], paragraphs, plan)
            review_input = [
                {
                    "title": draft.title,
                    "start_paragraph_id": draft.source_ids[0],
                    "paragraphs": [
                        {"paragraph_id": paragraph["id"], "text": paragraph["text"]}
                        for paragraph in paragraphs
                        if paragraph["id"] in draft.source_ids
                    ],
                }
                for draft in drafts
            ]
            approved, issues = chapter_provider.review_reading_units(chapter["title"], review_input)
            if not approved:
                raise ProviderError("阅读单元未通过两轮冷读复核：" + "；".join(issues[:3]))
        review_status = "cold_reviewed"
    if on_progress:
        on_progress(0, 1, "正在校验原文范围")
    with database.transaction() as connection:
        units = persist_unit_set(
            connection,
            chapter,
            paragraphs,
            drafts,
            chapter_provider.route,
            intro=plan.intro,
            review_status=review_status,
        )
        connection.execute(
            "UPDATE books SET status = 'ready', updated_at = ? WHERE id = ?",
            (utc_now(), book_id),
        )
    if on_progress:
        on_progress(1, 1, "本章阅读单元已发布")
    return {"chapter_id": chapter_id, "unit_ids": [unit["id"] for unit in units]}


def generate_map(
    database: Database,
    book_id: str,
    version_id: str,
    map_version_id: str,
    on_progress: ProgressCallback | None = None,
    provider: ChapterProvider | None = None,
    target_chapter_id: str | None = None,
) -> dict[str, Any]:
    book = database.one("SELECT * FROM books WHERE id = ?", (book_id,))
    if not book:
        raise ValueError("书籍不存在")

    chapters = database.query(
        "SELECT * FROM chapters WHERE version_id = ? ORDER BY ordinal",
        (version_id,),
    )
    total = max(1, len(chapters))
    chapter_provider = provider or get_chapter_provider()
    if on_progress:
        on_progress(0, total, "正在整理全书结构")

    chapter_payloads: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for chapter in chapters:
        paragraphs = database.query(
            """
            SELECT * FROM paragraphs
            WHERE chapter_id = ? AND status = 'ready'
            ORDER BY ordinal
            """,
            (chapter["id"],),
        )
        chapter_payloads.append((chapter, paragraphs))

    with database.transaction() as connection:
        connection.execute(
            """
            INSERT INTO map_versions (
                id, book_version_id, status, prompt_version, model_route, created_at
            ) VALUES (?, ?, 'generating', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                status = 'generating',
                prompt_version = excluded.prompt_version,
                model_route = excluded.model_route
            """,
            (
                map_version_id,
                version_id,
                chapter_provider.route,
                chapter_provider.route,
                utc_now(),
            ),
        )
        connection.execute(
            "DELETE FROM relations WHERE map_version_id = ?",
            (map_version_id,),
        )
        connection.execute(
            "DELETE FROM nodes WHERE map_version_id = ?",
            (map_version_id,),
        )
        root_id = _insert_node(
            connection,
            map_version_id,
            None,
            "question",
            f"{book['title']}试图回答什么？",
            book["description"]
            or f"围绕《{book['title']}》的主要问题、观点和论证建立可追溯的阅读地图。",
            "先理解全书问题，再进入主要观点、证据和适用条件。",
            [],
            0,
            origin="inferred",
            confidence=0.9,
        )

    theme_ids: list[tuple[str, str]] = []
    for chapter_ordinal, (chapter, paragraphs) in enumerate(chapter_payloads, start=1):
        with database.transaction() as connection:
            if not paragraphs:
                theme_ids.append(
                    (
                        _insert_node(
                            connection,
                            map_version_id,
                            root_id,
                            "theme",
                            chapter["title"],
                            f"{chapter['title']}没有可可靠提炼的段落。",
                            "本节暂未提炼出可靠观点，可直接阅读完整原文。",
                            [],
                            chapter_ordinal,
                            origin="inferred",
                            confidence=0.5,
                        ),
                        "",
                    )
                )
            else:
                sample = "；".join(paragraph["text"] for paragraph in paragraphs[:2])
                theme_id = _insert_node(
                    connection,
                    map_version_id,
                    root_id,
                    "theme",
                    chapter["title"],
                    f"{chapter['title']}围绕以下主张展开。",
                    _clip(sample, 88),
                    [],
                    chapter_ordinal,
                    origin="inferred",
                    confidence=0.9,
                )
                connection.execute(
                    "INSERT INTO node_chapters (node_id, chapter_id) VALUES (?, ?)",
                    (theme_id, chapter["id"]),
                )
                theme_ids.append((theme_id, chapter["title"]))

                if target_chapter_id is None or target_chapter_id == chapter["id"]:
                    plan = chapter_provider.plan_reading_units(
                        book["title"], chapter["title"], paragraphs
                    )
                    unit_drafts = unit_drafts_from_plan(chapter["title"], paragraphs, plan)
                    review_status = plan.review_status
                else:
                    plan = None
                    unit_drafts = _latest_unit_drafts(database, chapter)
                    review_status = "previously_published"
                review_input = [
                    {
                        "title": draft.title,
                        "start_paragraph_id": draft.source_ids[0],
                        "paragraphs": [
                            {"paragraph_id": paragraph["id"], "text": paragraph["text"]}
                            for paragraph in paragraphs
                            if paragraph["id"] in draft.source_ids
                        ],
                    }
                    for draft in unit_drafts
                ]
                approved, issues = (True, [])
                if plan and plan.review_status != "local_unreviewed":
                    approved, issues = chapter_provider.review_reading_units(
                        chapter["title"], review_input
                    )
                if plan and not approved:
                    revised_plan = chapter_provider.plan_reading_units(
                        book["title"], chapter["title"], paragraphs, issues
                    )
                    unit_drafts = unit_drafts_from_plan(
                        chapter["title"], paragraphs, revised_plan
                    )
                    review_input = [
                        {
                            "title": draft.title,
                            "start_paragraph_id": draft.source_ids[0],
                            "paragraphs": [
                                {"paragraph_id": paragraph["id"], "text": paragraph["text"]}
                                for paragraph in paragraphs
                                if paragraph["id"] in draft.source_ids
                            ],
                        }
                        for draft in unit_drafts
                    ]
                    approved, issues = chapter_provider.review_reading_units(
                        chapter["title"], review_input
                    )
                    if not approved:
                        raise ProviderError(
                            "阅读单元未通过两轮冷读复核：" + "；".join(issues[:3])
                        )
                    plan = revised_plan
                if plan:
                    review_status = (
                        "cold_reviewed" if plan.review_status != "local_unreviewed" else "local_unreviewed"
                    )
                    units = persist_unit_set(
                        connection,
                        chapter,
                        paragraphs,
                        unit_drafts,
                        chapter_provider.route,
                        intro=plan.intro,
                        review_status=review_status,
                    )
                else:
                    units = [
                        {"id": None, "draft": draft, "paragraphs": []}
                        for draft in unit_drafts
                    ]
                for unit_ordinal, unit in enumerate(units, start=1):
                    draft = unit["draft"]
                    unit_id = _insert_node(
                        connection,
                        map_version_id,
                        theme_id,
                        "unit",
                        draft.title,
                        draft.statement,
                        draft.summary
                        or "该观点由本节原文支持，可继续查看证据和适用条件。",
                        [],
                        unit_ordinal,
                        confidence=0.96,
                    )
                    connection.execute(
                        "INSERT INTO node_chapters (node_id, chapter_id) VALUES (?, ?)",
                        (unit_id, chapter["id"]),
                    )
                    if unit["id"]:
                        connection.execute(
                            """
                            INSERT INTO node_reading_units (node_id, reading_unit_id)
                            VALUES (?, ?)
                            """,
                            (unit_id, unit["id"]),
                        )
                    for source_id in draft.source_ids:
                        source_paragraph = next(
                            paragraph for paragraph in paragraphs if paragraph["id"] == source_id
                        )
                        _insert_source(connection, unit_id, source_paragraph)
        if on_progress:
            on_progress(
                chapter_ordinal,
                total,
                f"已完成 {chapter_ordinal}/{total} 章",
            )

    with database.transaction() as connection:
        for index in range(1, len(theme_ids)):
            from_theme, from_title = theme_ids[index - 1]
            to_theme, to_title = theme_ids[index]
            if not from_theme or not to_theme:
                continue
            connection.execute(
                """
                INSERT INTO relations (
                    id, map_version_id, from_node_id, to_node_id, type, origin,
                    confidence, evidence, status
                ) VALUES (?, ?, ?, ?, 'next', 'author', 1.0, ?, 'published')
                """,
                (
                    new_id("rel"),
                    map_version_id,
                    from_theme,
                    to_theme,
                    f"阅读顺序：先读{from_title}，再读{to_title}。",
                ),
            )

    with database.transaction() as connection:
        connection.execute(
            """
            UPDATE map_versions
            SET status = 'ready', published_at = ?
            WHERE id = ?
            """,
            (utc_now(), map_version_id),
        )
        connection.execute(
            """
            UPDATE books
            SET current_version_id = ?, status = 'ready', updated_at = ?
            WHERE id = ?
            """,
            (version_id, utc_now(), book_id),
        )

    if on_progress:
        on_progress(total, total, "全书地图已生成")
    return {"map_version_id": map_version_id}
