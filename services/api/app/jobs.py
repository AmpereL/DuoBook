from __future__ import annotations

import time
import traceback

from .db import Database, new_id, utc_now
from .generation import split_chapter
from .providers import ChapterProvider, get_chapter_provider


def create_generation_job(
    database: Database,
    book_id: str,
    version_id: str,
    map_version_id: str | None = None,
    provider: ChapterProvider | None = None,
    chapter_id: str | None = None,
) -> dict:
    job_id = new_id("job")
    del map_version_id
    now = utc_now()
    chapter_provider = provider or get_chapter_provider()
    total = 1 if chapter_id else int(
        (database.one("SELECT COUNT(*) AS count FROM chapters WHERE version_id = ?", (version_id,)) or {"count": 1})["count"]
    )
    with database.transaction() as connection:
        connection.execute(
            """
            INSERT INTO jobs (
                id, book_id, version_id, map_version_id, kind, status, stage,
                progress, completed_units, total_units, message, error,
                created_at, updated_at
            ) VALUES (?, ?, ?, NULL, 'chapter_split', 'queued', 'queued', 0, 0, ?, ?, NULL, ?, ?)
            """,
            (
                job_id,
                book_id,
                version_id,
                total,
                "已加入生成队列",
                now,
                now,
            ),
        )
        if chapter_id:
            connection.execute(
                "INSERT INTO job_chapters (job_id, chapter_id) VALUES (?, ?)",
                (job_id, chapter_id),
            )
    database.execute(
        "UPDATE books SET status = 'generating', updated_at = ? WHERE id = ?",
        (now, book_id),
    )
    return database.one("SELECT * FROM jobs WHERE id = ?", (job_id,)) or {}


def run_generation_job(
    database: Database,
    job_id: str,
    book_id: str,
    version_id: str,
    provider: ChapterProvider | None = None,
    chapter_id: str | None = None,
) -> None:
    database.execute(
        """
        UPDATE jobs
        SET status = 'running', stage = 'parsing', message = '正在校验原文覆盖',
            progress = 2, updated_at = ?
        WHERE id = ?
        """,
        (utc_now(), job_id),
    )
    time.sleep(0.08)

    def on_progress(completed: int, total: int, message: str) -> None:
        progress = min(96, 8 + round((completed / max(total, 1)) * 84))
        database.execute(
            """
            UPDATE jobs
            SET stage = 'chapter_analysis', progress = ?, completed_units = ?,
                total_units = ?, message = ?, updated_at = ?
            WHERE id = ?
            """,
            (progress, completed, total, message, utc_now(), job_id),
        )
        time.sleep(0.06)

    try:
        database.execute(
            """
            UPDATE jobs
            SET stage = 'chapter_analysis', message = '正在按语义拆分本章阅读单元',
                updated_at = ?
            WHERE id = ?
            """,
            (utc_now(), job_id),
        )
        if not chapter_id:
            raise ValueError("章节拆分任务缺少章节")
        split_chapter(
            database,
            book_id,
            version_id,
            chapter_id,
            on_progress,
            provider=provider,
        )
        database.execute(
            """
            UPDATE jobs
            SET status = 'completed', stage = 'completed', progress = 100,
                completed_units = total_units, message = '本章阅读单元已发布',
                updated_at = ?
            WHERE id = ?
            """,
            (utc_now(), job_id),
        )
    except Exception as exc:  # pragma: no cover - exercised through API tests
        error = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        database.execute(
            """
            UPDATE jobs
            SET status = 'failed', stage = 'failed', message = '生成失败',
                error = ?, updated_at = ?
            WHERE id = ?
            """,
            (error, utc_now(), job_id),
        )
        database.execute(
            """
            UPDATE books
            SET status = 'failed_partial', updated_at = ?
            WHERE id = ?
            """,
            (utc_now(), book_id),
        )
