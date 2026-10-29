from __future__ import annotations

from typing import Any

from .db import Database, new_id, utc_now


DEMO_USER_ID = "user_demo"
DEMO_BOOK_ID = "book_learning"
DEMO_VERSION_ID = "version_learning_v1"
DEMO_MAP_ID = "map_learning_v1"


def _insert_many(connection: Any, table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    columns = list(rows[0])
    sql = (
        f"INSERT INTO {table} ({', '.join(columns)}) "
        f"VALUES ({', '.join('?' for _ in columns)})"
    )
    connection.executemany(sql, [tuple(row[column] for column in columns) for row in rows])


def seed_demo(database: Database) -> None:
    if database.one("SELECT id FROM users WHERE id = ?", (DEMO_USER_ID,)):
        return

    now = utc_now()
    with database.transaction() as connection:
        _insert_many(
            connection,
            "users",
            [
                {
                    "id": DEMO_USER_ID,
                    "email": "reader@duobook.local",
                    "name": "林默",
                    "created_at": now,
                }
            ],
        )
        _insert_many(
            connection,
            "books",
            [
                {
                    "id": DEMO_BOOK_ID,
                    "owner_id": DEMO_USER_ID,
                    "title": "学习的方法",
                    "author": "林见",
                    "subtitle": "在不确定的世界里建立可持续的成长",
                    "description": "从目标、练习、反馈和节奏四个方面，构建更高效的学习方法。",
                    "cover_tone": "sage",
                    "status": "ready",
                    "current_version_id": DEMO_VERSION_ID,
                    "created_at": now,
                    "updated_at": now,
                    "last_read_at": now,
                }
            ],
        )
        _insert_many(
            connection,
            "book_versions",
            [
                {
                    "id": DEMO_VERSION_ID,
                    "book_id": DEMO_BOOK_ID,
                    "file_hash": "demo-learning-hash",
                    "format": "epub",
                    "source_path": None,
                    "char_count": 1380,
                    "parser_version": "1.0",
                    "status": "parsed",
                    "created_at": now,
                }
            ],
        )
        chapters = [
            ("chapter_goal", 1, "明确目标"),
            ("chapter_recall", 2, "主动提取"),
            ("chapter_feedback", 3, "及时反馈"),
            ("chapter_spacing", 4, "间隔练习"),
        ]
        _insert_many(
            connection,
            "chapters",
            [
                {
                    "id": chapter_id,
                    "version_id": DEMO_VERSION_ID,
                    "parent_id": None,
                    "ordinal": ordinal,
                    "title": title,
                    "source_path": f"OEBPS/ch{ordinal:02d}.xhtml",
                    "page_start": None,
                    "page_end": None,
                }
                for chapter_id, ordinal, title in chapters
            ],
        )

        paragraphs = [
            (
                "p_goal_1",
                "chapter_goal",
                1,
                "学习的起点不是投入更多时间，而是明确自己要解决的问题。没有目标，练习很容易变成机械重复。",
            ),
            (
                "p_goal_2",
                "chapter_goal",
                2,
                "如果学习者能够说出完成学习后要获得的能力，就更容易选择合适的方法，也更容易判断练习是否有效。",
            ),
            (
                "p_recall_1",
                "chapter_recall",
                1,
                "看过一段文字，并不意味着已经能够解释它。阅读之后，我们可以尝试用自己的语言整理其中的观点。",
            ),
            (
                "p_recall_2",
                "chapter_recall",
                2,
                "读完一节后，先合上材料，尝试说出其中的主要观点。遇到无法解释的部分，再回到原文核对。",
            ),
            (
                "p_recall_3",
                "chapter_recall",
                3,
                "合上材料尝试回忆，可以帮助读者发现尚未掌握的内容。这正是主动提取最重要的价值。",
            ),
            (
                "p_recall_4",
                "chapter_recall",
                4,
                "如果基础概念仍不清楚，可以先补充解释，再进行下一轮练习。",
            ),
            (
                "p_recall_5",
                "chapter_recall",
                5,
                "复述时出现卡顿或无法继续，往往说明该部分的知识掌握得不够牢固。",
            ),
            (
                "p_feedback_1",
                "chapter_feedback",
                1,
                "练习之后需要及时检查结果，才知道下一步应该巩固什么，或者调整什么。",
            ),
            (
                "p_feedback_2",
                "chapter_feedback",
                2,
                "反馈应该指向具体偏差，而不是只给一个总分。具体反馈可以帮助学习者调整下一步练习。",
            ),
            (
                "p_spacing_1",
                "chapter_spacing",
                1,
                "在合适的时间再次回忆，有助于巩固记忆。间隔练习把一次集中学习拆成多次短时提取。",
            ),
            (
                "p_spacing_2",
                "chapter_spacing",
                2,
                "间隔不是越久越好，需要根据遗忘和复习结果持续调整。",
            ),
        ]
        _insert_many(
            connection,
            "paragraphs",
            [
                {
                    "id": paragraph_id,
                    "chapter_id": chapter_id,
                    "ordinal": ordinal,
                    "text": text,
                    "normalized_text": text,
                    "anchor_json": database.dumps(
                        {
                            "format": "epub",
                            "resource": f"OEBPS/{chapter_id}.xhtml",
                            "block_path": f"/html/body/p[{ordinal}]",
                            "char_start": 0,
                            "char_end": len(text),
                            "cfi": f"epubcfi(/6/{ordinal * 2}!/4/2/{ordinal * 2})",
                        }
                    ),
                    "text_hash": str(abs(hash(text))),
                    "status": "ready",
                }
                for paragraph_id, chapter_id, ordinal, text in paragraphs
            ],
        )
        _insert_many(
            connection,
            "map_versions",
            [
                {
                    "id": DEMO_MAP_ID,
                    "book_version_id": DEMO_VERSION_ID,
                    "status": "ready",
                    "prompt_version": "demo-1.0",
                    "model_route": "curated-demo",
                    "created_at": now,
                    "published_at": now,
                }
            ],
        )

        nodes = [
            (
                "node_root",
                None,
                "question",
                "如何让学习更有效？",
                "学习效率来自目标、提取、反馈和节奏之间的配合，而不是单一技巧。",
                "从目标、练习、反馈和节奏四个方面构建更高效的学习方法。",
                [],
                "author",
                1.0,
                0,
            ),
            (
                "node_goal",
                "node_root",
                "theme",
                "明确目标",
                "明确目标决定练习什么，并让学习结果可以被判断。",
                "先确定要解决的问题，再选择方法和衡量结果。",
                [],
                "author",
                0.98,
                1,
            ),
            (
                "node_recall",
                "node_root",
                "theme",
                "主动提取",
                "主动提取帮助读者发现知识缺口。",
                "通过回忆、复述和自测暴露尚未掌握的内容。",
                [],
                "author",
                0.99,
                2,
            ),
            (
                "node_feedback",
                "node_root",
                "theme",
                "及时反馈",
                "及时反馈根据练习结果调整下一步的方向。",
                "反馈不只是评分，还要指出具体偏差。",
                [],
                "author",
                0.98,
                3,
            ),
            (
                "node_spacing",
                "node_root",
                "theme",
                "间隔练习",
                "间隔练习把学习拆到不同时间，帮助记忆得到巩固。",
                "复习间隔需要根据结果持续调整。",
                [],
                "author",
                0.97,
                4,
            ),
            (
                "node_recall_claim",
                "node_recall",
                "claim",
                "回忆帮助发现知识缺口",
                "合上材料尝试回忆，可以帮助读者发现尚未掌握的内容。",
                "回忆不是重复阅读，而是一种检验理解的方式。",
                [],
                "author",
                0.99,
                1,
            ),
            (
                "node_recall_explanation",
                "node_recall",
                "evidence",
                "复述时暴露遗漏",
                "在尝试复述时，如果出现卡顿或无法继续，往往说明该部分知识掌握得不够牢固。",
                "复述暴露的是理解中的断点。",
                [],
                "author",
                0.98,
                2,
            ),
            (
                "node_recall_example",
                "node_recall",
                "example",
                "读完一章节后复述",
                "读完一节后先合上材料，尝试说出主要观点；遇到无法解释的部分，再回到原文核对。",
                "这是一个练习示例，不代表实验结论。",
                [],
                "author",
                0.96,
                3,
            ),
            (
                "node_recall_condition",
                "node_recall",
                "condition",
                "先理解基础概念",
                "如果基础概念仍不清楚，可以先补充解释，再进行下一轮练习。",
                "主动提取需要在理解基础概念的前提下进行。",
                [
                    "学习者已经接触或理解基础概念",
                    "无法解释时应允许回到原文补充",
                ],
                "author",
                0.98,
                4,
            ),
            (
                "node_feedback_claim",
                "node_feedback",
                "claim",
                "具体反馈比总分更能指导下一步",
                "反馈应该指向具体偏差，而不是只给一个总分。",
                "反馈的价值在于帮助学习者调整下一步行动。",
                [],
                "author",
                0.97,
                1,
            ),
            (
                "node_spacing_claim",
                "node_spacing",
                "claim",
                "间隔需要根据复习结果调整",
                "间隔不是越久越好，需要根据遗忘和复习结果持续调整。",
                "固定间隔不是普遍最优解。",
                ["根据个人遗忘情况调整"],
                "author",
                0.96,
                1,
            ),
        ]
        _insert_many(
            connection,
            "nodes",
            [
                {
                    "id": node_id,
                    "map_version_id": DEMO_MAP_ID,
                    "parent_id": parent_id,
                    "type": node_type,
                    "title": title,
                    "statement": statement,
                    "summary": summary,
                    "conditions_json": database.dumps(conditions),
                    "origin": origin,
                    "confidence": confidence,
                    "ordinal": ordinal,
                    "status": "published",
                }
                for (
                    node_id,
                    parent_id,
                    node_type,
                    title,
                    statement,
                    summary,
                    conditions,
                    origin,
                    confidence,
                    ordinal,
                ) in nodes
            ],
        )
        _insert_many(
            connection,
            "node_chapters",
            [
                {"node_id": "node_goal", "chapter_id": "chapter_goal"},
                {"node_id": "node_recall", "chapter_id": "chapter_recall"},
                {"node_id": "node_feedback", "chapter_id": "chapter_feedback"},
                {"node_id": "node_spacing", "chapter_id": "chapter_spacing"},
            ],
        )

        sources = [
            ("src_recall_claim", "node_recall_claim", "p_recall_3"),
            ("src_recall_explanation", "node_recall_explanation", "p_recall_5"),
            ("src_recall_example", "node_recall_example", "p_recall_2"),
            ("src_recall_condition", "node_recall_condition", "p_recall_4"),
            ("src_feedback_claim", "node_feedback_claim", "p_feedback_2"),
            ("src_spacing_claim", "node_spacing_claim", "p_spacing_2"),
        ]
        paragraph_lookup = {paragraph_id: text for paragraph_id, _, _, text in paragraphs}
        _insert_many(
            connection,
            "node_sources",
            [
                {
                    "id": source_id,
                    "node_id": node_id,
                    "paragraph_id": paragraph_id,
                    "start_offset": 0,
                    "end_offset": len(paragraph_lookup[paragraph_id]),
                    "quote": paragraph_lookup[paragraph_id],
                }
                for source_id, node_id, paragraph_id in sources
            ],
        )

        relations = [
            (
                new_id("rel"),
                "node_goal",
                "node_recall",
                "premise",
                "author",
                0.95,
                "明确目标决定练习什么，主动提取才有检验对象。",
            ),
            (
                new_id("rel"),
                "node_recall",
                "node_feedback",
                "supports",
                "inferred",
                0.91,
                "回忆暴露的知识缺口为后续反馈提供方向。",
            ),
            (
                new_id("rel"),
                "node_spacing",
                "node_recall",
                "supports",
                "author",
                0.96,
                "间隔练习依赖在合适时间再次回忆。",
            ),
        ]
        _insert_many(
            connection,
            "relations",
            [
                {
                    "id": relation_id,
                    "map_version_id": DEMO_MAP_ID,
                    "from_node_id": from_node_id,
                    "to_node_id": to_node_id,
                    "type": relation_type,
                    "origin": origin,
                    "confidence": confidence,
                    "evidence": evidence,
                    "status": "published",
                }
                for (
                    relation_id,
                    from_node_id,
                    to_node_id,
                    relation_type,
                    origin,
                    confidence,
                    evidence,
                ) in relations
            ],
        )
        _insert_many(
            connection,
            "reading_states",
            [
                {
                    "user_id": DEMO_USER_ID,
                    "book_id": DEMO_BOOK_ID,
                    "last_map_version_id": DEMO_MAP_ID,
                    "last_node_id": "node_recall",
                    "last_paragraph_id": "p_recall_3",
                    "path_json": database.dumps(["node_root", "node_recall"]),
                    "updated_at": now,
                }
            ],
        )
        _insert_many(
            connection,
            "explored_nodes",
            [
                {
                    "user_id": DEMO_USER_ID,
                    "map_version_id": DEMO_MAP_ID,
                    "node_id": node_id,
                    "opened_at": now,
                }
                for node_id in [
                    "node_root",
                    "node_goal",
                    "node_recall",
                    "node_recall_claim",
                    "node_feedback",
                    "node_spacing",
                ]
            ],
        )
        _insert_many(
            connection,
            "read_paragraphs",
            [
                {
                    "user_id": DEMO_USER_ID,
                    "version_id": DEMO_VERSION_ID,
                    "paragraph_id": paragraph_id,
                    "marked_at": now,
                }
                for paragraph_id in [
                    "p_goal_1",
                    "p_goal_2",
                    "p_recall_1",
                    "p_recall_2",
                    "p_recall_3",
                    "p_recall_4",
                    "p_recall_5",
                    "p_feedback_1",
                    "p_feedback_2",
                    "p_spacing_1",
                    "p_spacing_2",
                ]
            ],
        )
