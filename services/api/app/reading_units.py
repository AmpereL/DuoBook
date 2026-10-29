from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from .db import Database, new_id, utc_now
from .providers import UnitPlan


@dataclass
class ReadingUnitDraft:
    """A source-checked chapter-split result used by both map and reader."""

    title: str
    statement: str
    summary: str
    source_ids: list[str]
    density_note: str = ""


SECTION_SKELETON = (
    ("original", "原文"),
    ("gloss", "二、字词注"),
    ("plain", "三、白话直译"),
    ("commentary", "四、注家对照"),
    ("connection", "五、与前章/上一单元的连接"),
    ("questions", "六、三个问题"),
    ("life", "七、生活关联"),
    ("understanding", "八、你的理解/疑问"),
    ("revisit", "九、回看批注"),
)


def chapter_source_hash(paragraphs: list[dict[str, Any]]) -> str:
    source = "\n\n".join(str(paragraph["text"]) for paragraph in paragraphs)
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def unit_drafts_from_plan(
    chapter_title: str,
    paragraphs: list[dict[str, Any]],
    plan: UnitPlan,
) -> list[ReadingUnitDraft]:
    """Slice a chapter only at validated start anchors and cover it exactly once."""

    if not paragraphs:
        return []
    positions = {paragraph["id"]: index for index, paragraph in enumerate(paragraphs)}
    starts = [unit.start_paragraph_id for unit in plan.units]
    if not starts or starts[0] != paragraphs[0]["id"]:
        raise ValueError("阅读单元必须从章节首段开始")
    if len(starts) != len(set(starts)) or any(start not in positions for start in starts):
        raise ValueError("阅读单元包含重复或不存在的原文锚点")
    if starts != sorted(starts, key=positions.__getitem__):
        raise ValueError("阅读单元锚点必须按原文顺序排列")

    drafts: list[ReadingUnitDraft] = []
    for index, item in enumerate(plan.units):
        start = positions[item.start_paragraph_id]
        end = positions[starts[index + 1]] if index + 1 < len(starts) else len(paragraphs)
        source_ids = [paragraph["id"] for paragraph in paragraphs[start:end]]
        if not source_ids:
            raise ValueError("阅读单元不能为空")
        drafts.append(
            ReadingUnitDraft(
                title=item.title,
                statement=item.purpose or f"阅读《{chapter_title}》中的这一完整内容单元。",
                summary=item.independence_reason or "该单元按原文连续范围保留，可独立进入阅读。",
                source_ids=source_ids,
                density_note=item.density_note,
            )
        )
    if [source_id for draft in drafts for source_id in draft.source_ids] != [
        paragraph["id"] for paragraph in paragraphs
    ]:
        raise ValueError("阅读单元未完整且无重复地覆盖章节原文")
    return drafts


def persist_unit_set(
    connection: Any,
    chapter: dict[str, Any],
    paragraphs: list[dict[str, Any]],
    drafts: list[ReadingUnitDraft],
    planner_route: str,
    intro: str = "",
    review_status: str = "source_checked",
) -> list[dict[str, Any]]:
    """Persist one immutable split run, plus empty deep-reading note sections."""

    now = utc_now()
    unit_set_id = new_id("uset")
    connection.execute(
        """
        INSERT INTO unit_sets (
            id, chapter_id, source_hash, planner_route, status, intro, created_at, published_at
        ) VALUES (?, ?, ?, ?, 'published', ?, ?, ?)
        """,
        (
            unit_set_id,
            chapter["id"],
            chapter_source_hash(paragraphs),
            planner_route,
            intro or f"《{chapter['title']}》按带来源的阅读单元组织；点击标题可回到对应原文。",
            now,
            now,
        ),
    )
    paragraph_lookup = {paragraph["id"]: paragraph for paragraph in paragraphs}
    persisted: list[dict[str, Any]] = []
    for ordinal, draft in enumerate(drafts, start=1):
        unit_id = new_id("unit")
        connection.execute(
            """
            INSERT INTO reading_units (
                id, unit_set_id, chapter_id, ordinal, title, statement, summary,
                review_status, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
            """,
            (
                unit_id,
                unit_set_id,
                chapter["id"],
                ordinal,
                draft.title,
                draft.statement,
                draft.summary,
                review_status,
                now,
            ),
        )
        ordered_sources = [
            paragraph_lookup[source_id]
            for source_id in draft.source_ids
            if source_id in paragraph_lookup
        ]
        for source_ordinal, paragraph in enumerate(ordered_sources, start=1):
            connection.execute(
                """
                INSERT INTO reading_unit_paragraphs (id, reading_unit_id, paragraph_id, ordinal)
                VALUES (?, ?, ?, ?)
                """,
                (new_id("unitp"), unit_id, paragraph["id"], source_ordinal),
            )
        original = "\n\n".join(paragraph["text"] for paragraph in ordered_sources)
        for section_ordinal, (kind, title) in enumerate(SECTION_SKELETON, start=1):
            connection.execute(
                """
                INSERT INTO reading_unit_sections (id, reading_unit_id, ordinal, kind, title, body)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("unitsec"),
                    unit_id,
                    section_ordinal,
                    kind,
                    title,
                    original if kind == "original" else "",
                ),
            )
        persisted.append({"id": unit_id, "draft": draft, "paragraphs": ordered_sources})
    return persisted
