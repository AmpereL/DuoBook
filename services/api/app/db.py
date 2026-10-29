from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '未知作者',
    subtitle TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    cover_tone TEXT NOT NULL DEFAULT 'sage',
    status TEXT NOT NULL,
    current_version_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_read_at TEXT
);

CREATE TABLE IF NOT EXISTS book_versions (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    file_hash TEXT NOT NULL,
    format TEXT NOT NULL,
    source_path TEXT,
    char_count INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES chapters(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    title TEXT NOT NULL,
    source_path TEXT,
    page_start INTEGER,
    page_end INTEGER
);

CREATE TABLE IF NOT EXISTS paragraphs (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    anchor_json TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS parse_issues (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
    chapter_id TEXT,
    anchor_json TEXT,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS map_versions (
    id TEXT PRIMARY KEY,
    book_version_id TEXT NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    model_route TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_at TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    map_version_id TEXT NOT NULL REFERENCES map_versions(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    statement TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    conditions_json TEXT NOT NULL DEFAULT '[]',
    origin TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'published'
);

CREATE TABLE IF NOT EXISTS node_sources (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
    start_offset INTEGER NOT NULL DEFAULT 0,
    end_offset INTEGER,
    quote TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    map_version_id TEXT NOT NULL REFERENCES map_versions(id) ON DELETE CASCADE,
    from_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    origin TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    evidence TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'published'
);

CREATE TABLE IF NOT EXISTS reading_states (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    last_map_version_id TEXT,
    last_node_id TEXT,
    last_paragraph_id TEXT,
    path_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS reading_positions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    reading_unit_id TEXT REFERENCES reading_units(id) ON DELETE SET NULL,
    paragraph_id TEXT REFERENCES paragraphs(id) ON DELETE SET NULL,
    character_offset INTEGER NOT NULL DEFAULT 0,
    section_ordinal INTEGER,
    anchor_progress REAL NOT NULL DEFAULT 0,
    captured_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS explored_nodes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    map_version_id TEXT NOT NULL REFERENCES map_versions(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    opened_at TEXT NOT NULL,
    PRIMARY KEY (user_id, node_id)
);

CREATE TABLE IF NOT EXISTS read_paragraphs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
    paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
    marked_at TEXT NOT NULL,
    PRIMARY KEY (user_id, paragraph_id)
);

CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
    paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- A unit is the stable result of the chapter-split step.  Its source is kept
-- as paragraph rows, rather than copied into a generated summary, so a later
-- model run can never silently rewrite the book text the reader is seeing.
CREATE TABLE IF NOT EXISTS unit_sets (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,
    planner_route TEXT NOT NULL,
    status TEXT NOT NULL,
    intro TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    published_at TEXT
);

CREATE TABLE IF NOT EXISTS reading_units (
    id TEXT PRIMARY KEY,
    unit_set_id TEXT NOT NULL REFERENCES unit_sets(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    title TEXT NOT NULL,
    statement TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL DEFAULT 'source_checked',
    status TEXT NOT NULL DEFAULT 'published',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reading_unit_paragraphs (
    id TEXT PRIMARY KEY,
    reading_unit_id TEXT NOT NULL REFERENCES reading_units(id) ON DELETE CASCADE,
    paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    UNIQUE(reading_unit_id, paragraph_id)
);

CREATE TABLE IF NOT EXISTS reading_unit_sections (
    id TEXT PRIMARY KEY,
    reading_unit_id TEXT NOT NULL REFERENCES reading_units(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    UNIQUE(reading_unit_id, ordinal)
);

CREATE TABLE IF NOT EXISTS node_reading_units (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    reading_unit_id TEXT NOT NULL REFERENCES reading_units(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS node_chapters (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_chapters (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE
);

-- New annotations record an exact character range.  The original paragraph is
-- never changed; quote is checked against offsets on every write.
CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotation_anchors (
    id TEXT PRIMARY KEY,
    annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
    paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    quote TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    version_id TEXT REFERENCES book_versions(id) ON DELETE CASCADE,
    map_version_id TEXT REFERENCES map_versions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    completed_units INTEGER NOT NULL DEFAULT 0,
    total_units INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_books_owner_updated ON books(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chapters_version_ordinal ON chapters(version_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_paragraphs_chapter_ordinal ON paragraphs(chapter_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_nodes_map_parent_ordinal ON nodes(map_version_id, parent_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_relations_map_from ON relations(map_version_id, from_node_id);
CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_unit_sets_chapter_created ON unit_sets(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reading_units_chapter_ordinal ON reading_units(chapter_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_annotation_anchors_paragraph ON annotation_anchors(paragraph_id);
"""


class Database:
    def __init__(self, path: str | Path | None = None) -> None:
        default_path = Path(__file__).resolve().parents[1] / "data" / "duobook.db"
        self.path = Path(path or os.getenv("DUOBOOK_DB", default_path))

    def reconfigure(self, path: str | Path) -> None:
        self.path = Path(path)

    def connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            # Backfill old chapter nodes so existing libraries can opt into the
            # manual chapter-split flow without recreating their map.
            connection.execute(
                """
                INSERT OR IGNORE INTO node_chapters (node_id, chapter_id)
                SELECT n.id, c.id
                FROM nodes n
                JOIN map_versions m ON m.id = n.map_version_id
                JOIN chapters c ON c.version_id = m.book_version_id
                             AND c.title = n.title
                WHERE n.type = 'theme'
                """
            )

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def query(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def one(self, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        with self.transaction() as connection:
            connection.execute(sql, params)

    def insert(self, table: str, values: dict[str, Any]) -> None:
        columns = ", ".join(values)
        placeholders = ", ".join("?" for _ in values)
        with self.transaction() as connection:
            connection.execute(
                f"INSERT INTO {table} ({columns}) VALUES ({placeholders})",
                tuple(values.values()),
            )

    @staticmethod
    def dumps(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def loads(value: str | None, default: Any) -> Any:
        if not value:
            return default
        return json.loads(value)


db = Database()
