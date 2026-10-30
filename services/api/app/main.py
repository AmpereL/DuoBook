from __future__ import annotations

import hashlib
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .db import Database, db, new_id, utc_now
from .covers import extract_cover
from .jobs import create_generation_job, run_generation_job
from .parsers import ParseError, parse_file
from .providers import (
    ModelConfiguration,
    ProviderError,
    get_chapter_provider,
    test_model_connection,
)
from .seed import DEMO_USER_ID, seed_demo
from .speech import MIMO_MODEL, MIMO_VOICES, SpeechError, SpeechTone, load_speech_configuration, save_speech_configuration, mimo_base_url, synthesize_mimo


PACKAGE_JSON = Path(__file__).resolve().parents[3] / "package.json"
APP_VERSION = os.getenv("DUOBOOK_APP_VERSION") or (
    json.loads(PACKAGE_JSON.read_text())["version"] if PACKAGE_JSON.exists() else "0.0.0"
)
UPLOAD_DIR = Path(
    os.getenv(
        "DUOBOOK_UPLOAD_DIR",
        str(Path(__file__).resolve().parents[1] / "data" / "uploads"),
    )
)
MODEL_CONFIGURATION = ModelConfiguration.from_environment()
# Local installation defaults are separate from source control. Explicit
# environment settings and isolated test databases take precedence.
MODEL_DEFAULTS_PATH = Path(__file__).resolve().parents[1] / "data" / "model-defaults.json"
if MODEL_DEFAULTS_PATH.exists() and not any(
    os.getenv(name) for name in ("DUOBOOK_DB", "DUOBOOK_LLM_PROVIDER", "DUOBOOK_LLM_BASE_URL")
):
    MODEL_CONFIGURATION = ModelConfiguration(**json.loads(MODEL_DEFAULTS_PATH.read_text()))
SPEECH_DEFAULTS_PATH = (
    Path(os.environ["DUOBOOK_DB"]).with_suffix(".speech.json")
    if os.getenv("DUOBOOK_DB") else MODEL_DEFAULTS_PATH.with_name("speech-defaults.json")
)
SPEECH_CONFIGURATION = load_speech_configuration(SPEECH_DEFAULTS_PATH, os.environ)


class StructureChapter(BaseModel):
    id: str
    title: str
    ordinal: int
    include: bool = True


class StructureUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    author: str = Field(default="未知作者", max_length=120)
    chapters: list[StructureChapter] = Field(min_length=1)


class ReadingStateUpdate(BaseModel):
    map_version_id: str | None = None
    node_id: str | None = None
    paragraph_id: str | None = None
    path: list[str] = Field(default_factory=list)


class ReadingPositionUpdate(BaseModel):
    chapter_id: str = Field(min_length=1, max_length=120)
    reading_unit_id: str | None = Field(default=None, max_length=120)
    paragraph_id: str | None = Field(default=None, max_length=120)
    character_offset: int = Field(default=0, ge=0)
    section_ordinal: int | None = Field(default=None, ge=1, le=9)
    anchor_progress: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    captured_at: int = Field(ge=0, le=9_999_999_999_999)


class ReadUpdate(BaseModel):
    read: bool = True


class NoteCreate(BaseModel):
    paragraph_id: str
    body: str = Field(min_length=1, max_length=20_000)


class NoteUpdate(BaseModel):
    body: str = Field(min_length=1, max_length=20_000)


class AnnotationCreate(BaseModel):
    paragraph_id: str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(gt=0)
    quote: str = Field(min_length=1, max_length=20_000)
    body: str = Field(default="", max_length=20_000)


class ReadingUnitSectionUpdate(BaseModel):
    """Reader-owned notes.  Section 1 is the immutable source and is never writable."""

    body: str = Field(default="", max_length=20_000)


class ModelConfigurationUpdate(BaseModel):
    provider: Literal["local", "openai", "anthropic"]
    base_url: str = Field(default="", max_length=500)
    api_key: str | None = Field(default=None, max_length=10_000)
    model: str = Field(default="", max_length=200)
    timeout: float = Field(default=60.0, ge=5.0, le=300.0)


class SpeechRequest(BaseModel):
    paragraph_id: str
    start_offset: int = Field(default=0, ge=0)
    end_offset: int = Field(gt=0)
    voice: Literal["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"] = "mimo_default"
    tone: SpeechTone = "natural"


class SpeechConfigurationUpdate(BaseModel):
    base_url: str = Field(default="https://api.xiaomimimo.com/v1", max_length=500)
    api_key: str | None = Field(default=None, max_length=10000)
    timeout: float = Field(default=120, ge=5, le=300)


def _speech_configuration_from_update(body: SpeechConfigurationUpdate) -> ModelConfiguration:
    current = SPEECH_CONFIGURATION or MODEL_CONFIGURATION
    try:
        # Validate the official host before selecting any existing credentials.
        base_url = mimo_base_url(ModelConfiguration(base_url=body.base_url.strip()))
    except SpeechError as exc:
        raise HTTPException(status_code=422, detail={"code": "INVALID_SPEECH_URL", "message": str(exc)}) from None
    key = body.api_key.strip() if body.api_key is not None else current.api_key
    if not key:
        raise HTTPException(status_code=422, detail={"code": "SPEECH_KEY_REQUIRED", "message": "请填写 MiMo 语音 API Key"})
    return ModelConfiguration(provider="openai", base_url=base_url, api_key=key, model=MIMO_MODEL, timeout=body.timeout)


def _model_configuration_payload() -> dict[str, Any]:
    return {
        "provider": MODEL_CONFIGURATION.provider,
        "base_url": MODEL_CONFIGURATION.base_url,
        "model": MODEL_CONFIGURATION.model,
        "timeout": MODEL_CONFIGURATION.timeout,
        "has_api_key": bool(MODEL_CONFIGURATION.api_key),
    }


def _configuration_from_update(body: ModelConfigurationUpdate) -> ModelConfiguration:
    provider = body.provider
    base_url = body.base_url.strip().rstrip("/")
    model = body.model.strip()
    api_key = body.api_key.strip() if body.api_key is not None else MODEL_CONFIGURATION.api_key
    if provider == "local":
        return ModelConfiguration(timeout=body.timeout)
    if not model:
        raise HTTPException(
            status_code=422,
            detail={"code": "MODEL_REQUIRED", "message": "请填写模型名称"},
        )
    if not api_key:
        raise HTTPException(
            status_code=422,
            detail={"code": "API_KEY_REQUIRED", "message": "请填写 API Key"},
        )
    if provider == "openai" and not base_url:
        raise HTTPException(
            status_code=422,
            detail={"code": "API_URL_REQUIRED", "message": "请填写 OpenAI 兼容 API 地址"},
        )
    return ModelConfiguration(
        provider=provider,
        base_url=base_url or "https://api.anthropic.com",
        api_key=api_key,
        model=model,
        timeout=body.timeout,
    )


def _book_or_404(book_id: str) -> dict[str, Any]:
    book = db.one(
        "SELECT * FROM books WHERE id = ? AND owner_id = ?",
        (book_id, DEMO_USER_ID),
    )
    if not book:
        raise HTTPException(status_code=404, detail={"code": "BOOK_NOT_FOUND"})
    return book


def _version_or_404(book: dict[str, Any]) -> dict[str, Any]:
    version_id = book.get("current_version_id")
    if not version_id:
        raise HTTPException(status_code=409, detail={"code": "BOOK_NOT_PARSED"})
    version = db.one("SELECT * FROM book_versions WHERE id = ?", (version_id,))
    if not version:
        raise HTTPException(status_code=409, detail={"code": "VERSION_NOT_FOUND"})
    return version


def _map_for_book(book: dict[str, Any], allow_generating: bool = False) -> dict[str, Any]:
    version = _version_or_404(book)
    statuses = ("ready", "generating") if allow_generating else ("ready",)
    placeholders = ", ".join("?" for _ in statuses)
    map_version = db.one(
        f"""
        SELECT * FROM map_versions
        WHERE book_version_id = ? AND status IN ({placeholders})
        ORDER BY created_at DESC LIMIT 1
        """,
        (version["id"], *statuses),
    )
    if not map_version:
        raise HTTPException(status_code=404, detail={"code": "MAP_NOT_READY"})
    return map_version


def _latest_job(book_id: str) -> dict[str, Any] | None:
    return db.one(
        "SELECT * FROM jobs WHERE book_id = ? ORDER BY created_at DESC LIMIT 1",
        (book_id,),
    )


def _book_payload(book: dict[str, Any], include_job: bool = True) -> dict[str, Any]:
    payload = dict(book)
    payload["reading_position"] = _saved_reading_position(book)
    payload["cover_url"] = f"/api/v1/books/{book['id']}/cover" if book.get('current_version_id') else None
    version_id = book.get("current_version_id")
    chapter_count = 0
    explored_count = 0
    read_count = 0
    paragraph_count = 0
    if version_id:
        row = db.one(
            "SELECT COUNT(*) AS count FROM chapters WHERE version_id = ?",
            (version_id,),
        )
        chapter_count = int(row["count"]) if row else 0
        row = db.one(
            """
            SELECT COUNT(*) AS count FROM paragraphs p
            JOIN chapters c ON c.id = p.chapter_id
            WHERE c.version_id = ?
            """,
            (version_id,),
        )
        paragraph_count = int(row["count"]) if row else 0
        row = db.one(
            """
            SELECT COUNT(*) AS count FROM read_paragraphs rp
            JOIN paragraphs p ON p.id = rp.paragraph_id
            JOIN chapters c ON c.id = p.chapter_id
            WHERE rp.user_id = ? AND c.version_id = ?
            """,
            (DEMO_USER_ID, version_id),
        )
        read_count = int(row["count"]) if row else 0
        row = db.one(
            """
            SELECT COUNT(*) AS count FROM explored_nodes e
            JOIN map_versions m ON m.id = e.map_version_id
            WHERE e.user_id = ? AND m.book_version_id = ?
            """,
            (DEMO_USER_ID, version_id),
        )
        explored_count = int(row["count"]) if row else 0
    payload.update(
        {
            "chapter_count": chapter_count,
            "paragraph_count": paragraph_count,
            "explored_count": explored_count,
            "read_count": read_count,
            "format": db.one(
                "SELECT format FROM book_versions WHERE id = ?",
                (version_id,),
            )["format"]
            if version_id
            else None,
        }
    )
    if include_job:
        payload["job"] = _latest_job(book["id"])
    return payload


def _node_payload(node: dict[str, Any]) -> dict[str, Any]:
    payload = dict(node)
    payload["conditions"] = Database.loads(payload.pop("conditions_json", None), [])
    payload["sources"] = db.query(
        """
        SELECT ns.*, p.chapter_id, p.ordinal AS paragraph_ordinal,
               c.title AS chapter_title
        FROM node_sources ns
        JOIN paragraphs p ON p.id = ns.paragraph_id
        JOIN chapters c ON c.id = p.chapter_id
        WHERE ns.node_id = ?
        ORDER BY c.ordinal, p.ordinal
        """,
        (node["id"],),
    )
    payload["child_count"] = int(
        db.one("SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?", (node["id"],))[
            "count"
        ]
    )
    unit = db.one(
        """
        SELECT nru.reading_unit_id
        FROM node_reading_units nru
        WHERE nru.node_id = ?
        """,
        (node["id"],),
    )
    payload["reading_unit_id"] = unit["reading_unit_id"] if unit else None
    chapter = db.one(
        "SELECT chapter_id FROM node_chapters WHERE node_id = ?", (node["id"],)
    )
    payload["chapter_id"] = chapter["chapter_id"] if chapter else None
    return payload


def _annotation_payload(row: dict[str, Any]) -> dict[str, Any]:
    payload = dict(row)
    payload["anchors"] = db.query(
        """
        SELECT aa.*, p.text AS paragraph_text, p.ordinal AS paragraph_ordinal,
               c.title AS chapter_title
        FROM annotation_anchors aa
        JOIN paragraphs p ON p.id = aa.paragraph_id
        JOIN chapters c ON c.id = p.chapter_id
        WHERE aa.annotation_id = ?
        ORDER BY aa.id
        """,
        (row["id"],),
    )
    return payload


def _map_payload(book: dict[str, Any], map_version: dict[str, Any]) -> dict[str, Any]:
    nodes = db.query(
        """
        SELECT * FROM nodes
        WHERE map_version_id = ? AND status = 'published'
        ORDER BY ordinal, id
        """,
        (map_version["id"],),
    )
    relations = db.query(
        """
        SELECT * FROM relations
        WHERE map_version_id = ? AND status = 'published'
        ORDER BY id
        """,
        (map_version["id"],),
    )
    chapters = db.query(
        "SELECT * FROM chapters WHERE version_id = ? ORDER BY ordinal",
        (book["current_version_id"],),
    )
    state = db.one(
        "SELECT * FROM reading_states WHERE user_id = ? AND book_id = ?",
        (DEMO_USER_ID, book["id"]),
    )
    return {
        "book": _book_payload(book),
        "map_version": map_version,
        "nodes": [_node_payload(node) for node in nodes],
        "relations": relations,
        "chapters": chapters,
        "state": {
            **state,
            "path": Database.loads(state["path_json"], []) if state else [],
        }
        if state
        else None,
    }


def _paragraph_payload(paragraph_id: str) -> dict[str, Any]:
    paragraph = db.one(
        """
        SELECT p.*, c.title AS chapter_title, c.ordinal AS chapter_ordinal,
               c.version_id
        FROM paragraphs p
        JOIN chapters c ON c.id = p.chapter_id
        WHERE p.id = ?
        """,
        (paragraph_id,),
    )
    if not paragraph:
        raise HTTPException(status_code=404, detail={"code": "PARAGRAPH_NOT_FOUND"})
    context = db.query(
        """
        SELECT p.*, c.title AS chapter_title
        FROM paragraphs p
        JOIN chapters c ON c.id = p.chapter_id
        WHERE p.chapter_id = ?
        ORDER BY p.ordinal
        """,
        (paragraph["chapter_id"],),
    )
    related_nodes = db.query(
        """
        SELECT DISTINCT n.*, m.id AS map_version_id
        FROM node_sources ns
        JOIN nodes n ON n.id = ns.node_id
        JOIN map_versions m ON m.id = n.map_version_id
        WHERE ns.paragraph_id = ? AND n.status = 'published'
        ORDER BY n.ordinal
        """,
        (paragraph_id,),
    )
    notes = db.query(
        """
        SELECT * FROM notes
        WHERE user_id = ? AND paragraph_id = ?
        ORDER BY created_at DESC
        """,
        (DEMO_USER_ID, paragraph_id),
    )
    annotations = db.query(
        """
        SELECT DISTINCT a.*
        FROM annotations a
        JOIN annotation_anchors aa ON aa.annotation_id = a.id
        WHERE a.user_id = ? AND aa.paragraph_id = ?
        ORDER BY a.created_at DESC
        """,
        (DEMO_USER_ID, paragraph_id),
    )
    is_read = bool(
        db.one(
            "SELECT 1 AS present FROM read_paragraphs WHERE user_id = ? AND paragraph_id = ?",
            (DEMO_USER_ID, paragraph_id),
        )
    )
    state = db.one(
        """
        SELECT rs.* FROM reading_states rs
        JOIN book_versions bv ON bv.book_id = rs.book_id
        WHERE rs.user_id = ? AND bv.id = ?
        """,
        (DEMO_USER_ID, paragraph["version_id"]),
    )
    book = db.one(
        "SELECT * FROM books WHERE current_version_id = ?",
        (paragraph["version_id"],),
    )
    chapter_list = db.query(
        "SELECT * FROM chapters WHERE version_id = ? ORDER BY ordinal",
        (paragraph["version_id"],),
    )
    return {
        "book": _book_payload(book) if book else None,
        "paragraph": paragraph,
        "context": context,
        "related_nodes": [_node_payload(node) for node in related_nodes],
        "notes": notes,
        "annotations": [_annotation_payload(annotation) for annotation in annotations],
        "read": is_read,
        "state": {
            **state,
            "path": Database.loads(state["path_json"], []) if state else [],
        }
        if state
        else None,
        "chapters": chapter_list,
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    db.initialize()
    seed_demo(db)
    yield


app = FastAPI(
    title="逻辑阅读 API",
    version=APP_VERSION,
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/v1/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "duobook-api"}


@app.get("/api/v1/speech/config")
def speech_configuration() -> dict[str, Any]:
    configuration = SPEECH_CONFIGURATION or MODEL_CONFIGURATION
    try:
        endpoint = mimo_base_url(configuration)
        configured = bool(configuration.api_key)
    except SpeechError:
        endpoint, configured = "", False
    return {"model": MIMO_MODEL, "voices": MIMO_VOICES, "configured": configured, "base_url": endpoint,
            "timeout": configuration.timeout, "credential_source": "speech" if SPEECH_CONFIGURATION is not None else "model"}


@app.put("/api/v1/speech/config")
def update_speech_configuration(body: SpeechConfigurationUpdate) -> dict[str, Any]:
    global SPEECH_CONFIGURATION
    configuration = _speech_configuration_from_update(body)
    if not os.getenv("DUOBOOK_DESKTOP_TOKEN"):
        save_speech_configuration(SPEECH_DEFAULTS_PATH, configuration)
    SPEECH_CONFIGURATION = configuration
    return speech_configuration()


@app.post("/api/v1/speech/test")
def test_speech_configuration(body: SpeechConfigurationUpdate) -> dict[str, Any]:
    configuration = _speech_configuration_from_update(body)
    try:
        audio = synthesize_mimo(configuration, "你好，欢迎使用逻辑阅读。", "mimo_default", "natural")
    except SpeechError as exc:
        raise HTTPException(status_code=502, detail={"code": "SPEECH_FAILED", "message": str(exc)}) from None
    return {"message": "MiMo 语音连接测试通过，已生成有效音频。", "audio_bytes": len(audio)}


@app.post("/api/v1/speech/synthesize")
def synthesize_speech(body: SpeechRequest) -> Response:
    paragraph = db.one(
        """SELECT p.text FROM paragraphs p
        JOIN chapters c ON c.id = p.chapter_id
        JOIN book_versions bv ON bv.id = c.version_id
        JOIN books b ON b.id = bv.book_id
        WHERE p.id = ? AND b.owner_id = ? AND p.status = 'ready'""",
        (body.paragraph_id, DEMO_USER_ID),
    )
    if not paragraph:
        raise HTTPException(status_code=404, detail={"code": "PARAGRAPH_NOT_FOUND", "message": "找不到要朗读的原文"})
    if body.start_offset >= body.end_offset or body.end_offset > len(paragraph["text"]) or body.end_offset - body.start_offset > 800:
        raise HTTPException(status_code=422, detail={"code": "INVALID_SPEECH_RANGE", "message": "朗读范围无效或过长，请重新开始朗读"})
    try:
        audio = synthesize_mimo(SPEECH_CONFIGURATION or MODEL_CONFIGURATION, paragraph["text"][body.start_offset:body.end_offset], body.voice, body.tone)
    except SpeechError as exc:
        raise HTTPException(status_code=502, detail={"code": "SPEECH_FAILED", "message": str(exc)}) from None
    return Response(content=audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@app.get("/api/v1/settings/model")
def get_model_configuration() -> dict[str, Any]:
    """Return configuration without ever exposing an existing API key."""
    return _model_configuration_payload()


@app.put("/api/v1/settings/model")
def update_model_configuration(body: ModelConfigurationUpdate) -> dict[str, Any]:
    global MODEL_CONFIGURATION
    MODEL_CONFIGURATION = _configuration_from_update(body)
    return _model_configuration_payload()


@app.post("/api/v1/settings/model/test")
def test_configured_model(body: ModelConfigurationUpdate) -> dict[str, str]:
    configuration = _configuration_from_update(body)
    try:
        return test_model_connection(configuration)
    except ProviderError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "MODEL_CONNECTION_FAILED", "message": str(exc)},
        ) from exc


@app.get("/api/v1/books")
def list_books(q: str | None = Query(default=None, max_length=120)) -> dict[str, Any]:
    if q:
        pattern = f"%{q.strip()}%"
        rows = db.query(
            """
            SELECT * FROM books
            WHERE owner_id = ? AND (title LIKE ? OR author LIKE ? OR subtitle LIKE ?)
            ORDER BY COALESCE(last_read_at, updated_at) DESC
            """,
            (DEMO_USER_ID, pattern, pattern, pattern),
        )
    else:
        rows = db.query(
            """
            SELECT * FROM books
            WHERE owner_id = ?
            ORDER BY COALESCE(last_read_at, updated_at) DESC
            """,
            (DEMO_USER_ID,),
        )
    return {"items": [_book_payload(row) for row in rows]}


@app.get("/api/v1/books/{book_id}")
def get_book(book_id: str) -> dict[str, Any]:
    return _book_payload(_book_or_404(book_id))


@app.get("/api/v1/books/{book_id}/cover")
def get_book_cover(book_id: str) -> Response:
    version = _version_or_404(_book_or_404(book_id))
    source = version.get('source_path')
    try:
        result = extract_cover(source, Path(source).stat().st_mtime_ns) if source else None
    except OSError:
        result = None
    if not result:
        raise HTTPException(status_code=404, detail={"code": "COVER_NOT_FOUND"})
    content, mime = result
    return Response(content, media_type=mime, headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})


@app.post("/api/v1/books/upload", status_code=201)
async def upload_book(file: UploadFile = File(...)) -> dict[str, Any]:
    filename = file.filename or "book"
    content = await file.read()
    existing_read = getattr(file, "read", None)
    if existing_read is not None and content == b"":
        raise HTTPException(status_code=400, detail={"code": "EMPTY_FILE"})
    try:
        parsed = parse_file(content, filename)
    except ParseError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc

    duplicate = db.one(
        """
        SELECT b.* FROM books b
        JOIN book_versions bv ON bv.book_id = b.id
        WHERE b.owner_id = ? AND bv.file_hash = ?
        ORDER BY b.created_at DESC LIMIT 1
        """,
        (DEMO_USER_ID, parsed.file_hash),
    )
    if duplicate:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "DUPLICATE_BOOK",
                "message": "这本书已经导入",
                "existing_book_id": duplicate["id"],
            },
        )

    book_id = new_id("book")
    version_id = new_id("version")
    extension = Path(filename).suffix.lower()
    stored_name = f"{version_id}{extension}"
    stored_path = UPLOAD_DIR / stored_name
    stored_path.write_bytes(content)
    now = utc_now()
    with db.transaction() as connection:
        connection.execute(
            """
            INSERT INTO books (
                id, owner_id, title, author, subtitle, description, cover_tone,
                status, current_version_id, created_at, updated_at, last_read_at
            ) VALUES (?, ?, ?, ?, '', '', ?, 'awaiting_structure_confirmation', ?, ?, ?, NULL)
            """,
            (
                book_id,
                DEMO_USER_ID,
                parsed.title,
                "未知作者",
                _cover_tone_for(book_id),
                version_id,
                now,
                now,
            ),
        )
        connection.execute(
            """
            INSERT INTO book_versions (
                id, book_id, file_hash, format, source_path, char_count,
                parser_version, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, '1.0', 'parsed', ?)
            """,
            (
                version_id,
                book_id,
                parsed.file_hash,
                parsed.format,
                str(stored_path),
                parsed.char_count,
                now,
            ),
        )
        chapter_ids: list[str] = []
        for chapter_ordinal, chapter in enumerate(parsed.chapters, start=1):
            chapter_id = new_id("chapter")
            chapter_ids.append(chapter_id)
            connection.execute(
                """
                INSERT INTO chapters (
                    id, version_id, parent_id, ordinal, title, source_path,
                    page_start, page_end
                ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
                """,
                (
                    chapter_id,
                    version_id,
                    chapter_ordinal,
                    chapter.title,
                    chapter.source_path,
                    chapter.page_start,
                    chapter.page_end,
                ),
            )
            for paragraph_ordinal, paragraph in enumerate(chapter.paragraphs, start=1):
                connection.execute(
                    """
                    INSERT INTO paragraphs (
                        id, chapter_id, ordinal, text, normalized_text,
                        anchor_json, text_hash, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')
                    """,
                    (
                        new_id("p"),
                        chapter_id,
                        paragraph_ordinal,
                        paragraph.text,
                        paragraph.text,
                        Database.dumps(paragraph.anchor),
                        hashlib.sha256(paragraph.text.encode("utf-8")).hexdigest(),
                    ),
                )
        for issue in parsed.issues:
            connection.execute(
                """
                INSERT INTO parse_issues (
                    id, version_id, chapter_id, anchor_json, code, message, created_at
                ) VALUES (?, ?, NULL, ?, ?, ?, ?)
                """,
                (
                    new_id("issue"),
                    version_id,
                    Database.dumps(issue),
                    issue["code"],
                    issue["message"],
                    now,
                ),
            )

    return {
        "book": _book_payload(_book_or_404(book_id)),
        "structure": _structure_payload(book_id),
    }


def _cover_tone_for(seed: str) -> str:
    tones = ["sage", "sand", "slate", "olive"]
    return tones[int(hash(seed)) % len(tones)]


def _structure_payload(book_id: str) -> dict[str, Any]:
    book = _book_or_404(book_id)
    version = _version_or_404(book)
    chapters = db.query(
        """
        SELECT c.*, COUNT(p.id) AS paragraph_count
        FROM chapters c
        LEFT JOIN paragraphs p ON p.chapter_id = c.id
        WHERE c.version_id = ?
        GROUP BY c.id
        ORDER BY c.ordinal
        """,
        (version["id"],),
    )
    return {"book": _book_payload(book), "chapters": chapters}


def _latest_chapter_job(book_id: str, chapter_id: str) -> dict[str, Any] | None:
    return db.one(
        """
        SELECT j.* FROM jobs j
        JOIN job_chapters jc ON jc.job_id = j.id
        WHERE j.book_id = ? AND jc.chapter_id = ?
        ORDER BY j.created_at DESC LIMIT 1
        """,
        (book_id, chapter_id),
    )


def _chapter_unit_set(chapter_id: str) -> dict[str, Any] | None:
    return db.one(
        """
        SELECT * FROM unit_sets
        WHERE chapter_id = ? AND status = 'published'
        ORDER BY COALESCE(published_at, created_at) DESC LIMIT 1
        """,
        (chapter_id,),
    )


def _chapter_units(chapter_id: str) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    unit_set = _chapter_unit_set(chapter_id)
    if not unit_set:
        return None, []
    units = db.query(
        """
        SELECT ru.*, COUNT(rup.paragraph_id) AS paragraph_count
        FROM reading_units ru
        LEFT JOIN reading_unit_paragraphs rup ON rup.reading_unit_id = ru.id
        WHERE ru.unit_set_id = ? AND ru.status = 'published'
        GROUP BY ru.id
        ORDER BY ru.ordinal
        """,
        (unit_set["id"],),
    )
    return unit_set, units


def _chapter_status(book_id: str, chapter_id: str) -> tuple[str, dict[str, Any] | None, int]:
    _, units = _chapter_units(chapter_id)
    job = _latest_chapter_job(book_id, chapter_id)
    if job and job["status"] in {"queued", "running"}:
        return "splitting", job, len(units)
    if job and job["status"] in {"failed", "partial"}:
        return "failed", job, len(units)
    if units:
        return "ready", job, len(units)
    return "unprocessed", job, 0


def _chapter_payload(book_id: str, chapter: dict[str, Any]) -> dict[str, Any]:
    status, job, unit_count = _chapter_status(book_id, chapter["id"])
    return {
        **chapter,
        "status": status,
        "unit_count": unit_count,
        "job": job,
        "units": _chapter_units(chapter["id"])[1],
    }


@app.get("/api/v1/books/{book_id}/structure")
def get_structure(book_id: str) -> dict[str, Any]:
    return _structure_payload(book_id)


@app.patch("/api/v1/books/{book_id}/structure")
def update_structure(book_id: str, body: StructureUpdate) -> dict[str, Any]:
    book = _book_or_404(book_id)
    version = _version_or_404(book)
    included_ids = [chapter.id for chapter in body.chapters if chapter.include]
    if not included_ids:
        raise HTTPException(
            status_code=422,
            detail={"code": "NO_CHAPTERS_SELECTED", "message": "至少选择一章"},
        )
    existing = {
        row["id"]
        for row in db.query("SELECT id FROM chapters WHERE version_id = ?", (version["id"],))
    }
    if any(chapter_id not in existing for chapter_id in included_ids):
        raise HTTPException(status_code=422, detail={"code": "INVALID_CHAPTER"})
    now = utc_now()
    with db.transaction() as connection:
        connection.execute(
            "UPDATE books SET title = ?, author = ?, status = 'structure_confirmed', updated_at = ? WHERE id = ?",
            (body.title.strip(), body.author.strip() or "未知作者", now, book_id),
        )
        for chapter in body.chapters:
            if chapter.include:
                connection.execute(
                    "UPDATE chapters SET title = ?, ordinal = ? WHERE id = ?",
                    (chapter.title.strip() or "未命名章节", chapter.ordinal, chapter.id),
                )
            else:
                connection.execute("DELETE FROM chapters WHERE id = ?", (chapter.id,))
    return _structure_payload(book_id)


@app.get("/api/v1/books/{book_id}/chapters")
def list_chapters(book_id: str) -> dict[str, Any]:
    """The workbench index: a book becomes available before any chapter is split."""

    book = _book_or_404(book_id)
    version = _version_or_404(book)
    chapters = db.query(
        """
        SELECT c.*, COUNT(p.id) AS paragraph_count
        FROM chapters c
        LEFT JOIN paragraphs p ON p.chapter_id = c.id
        WHERE c.version_id = ?
        GROUP BY c.id
        ORDER BY c.ordinal
        """,
        (version["id"],),
    )
    return {
        "book": _book_payload(book),
        "chapters": [_chapter_payload(book_id, chapter) for chapter in chapters],
    }


def _reading_progress(book: dict[str, Any], paragraphs: list[dict[str, Any]]) -> dict[str, Any]:
    """Count source characters once, independent of reading-unit split versions."""
    targets = {paragraph["id"] for paragraph in paragraphs}
    rows = db.query(
        """SELECT p.id, LENGTH(p.text) AS character_count
           FROM chapters c JOIN paragraphs p ON p.chapter_id = c.id
           WHERE c.version_id = ? ORDER BY c.ordinal, c.id, p.ordinal, p.id""",
        (book["current_version_id"],),
    )
    total = 0
    anchors = []
    for row in rows:
        if row["id"] in targets:
            anchors.append({"paragraph_id": row["id"], "start_character": total,
                            "character_count": row["character_count"]})
        total += row["character_count"]
    return {"total_characters": total, "paragraphs": anchors}


@app.get("/api/v1/books/{book_id}/chapters/{chapter_id}")
def get_chapter(book_id: str, chapter_id: str) -> dict[str, Any]:
    book = _book_or_404(book_id)
    version = _version_or_404(book)
    chapter = db.one(
        """
        SELECT c.*, COUNT(p.id) AS paragraph_count
        FROM chapters c
        LEFT JOIN paragraphs p ON p.chapter_id = c.id
        WHERE c.id = ? AND c.version_id = ?
        GROUP BY c.id
        """,
        (chapter_id, version["id"]),
    )
    if not chapter:
        raise HTTPException(status_code=404, detail={"code": "CHAPTER_NOT_FOUND"})
    unit_set, units = _chapter_units(chapter_id)
    paragraphs = db.query(
        "SELECT * FROM paragraphs WHERE chapter_id = ? ORDER BY ordinal",
        (chapter_id,),
    )
    annotations = db.query(
        """
        SELECT DISTINCT a.* FROM annotations a
        JOIN annotation_anchors aa ON aa.annotation_id = a.id
        JOIN paragraphs p ON p.id = aa.paragraph_id
        WHERE a.user_id = ? AND p.chapter_id = ?
        ORDER BY a.created_at DESC
        """,
        (DEMO_USER_ID, chapter_id),
    )
    payload = _chapter_payload(book_id, chapter)
    payload["unit_set"] = unit_set
    history = db.query(
        "SELECT * FROM unit_sets WHERE chapter_id = ? AND status = 'published' ORDER BY created_at DESC",
        (chapter_id,),
    )
    for entry in history:
        entry["units"] = db.query(
            "SELECT * FROM reading_units WHERE unit_set_id = ? ORDER BY ordinal", (entry["id"],)
        )
    return {
        "book": _book_payload(book),
        "chapter": payload,
        "paragraphs": paragraphs,
        "reading_progress": _reading_progress(book, paragraphs),
        "annotations": [_annotation_payload(annotation) for annotation in annotations],
        "units": units,
        "history": history,
    }


@app.post("/api/v1/books/{book_id}/chapters/{chapter_id}/split-runs", status_code=202)
def start_chapter_split(
    book_id: str,
    chapter_id: str,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    book = _book_or_404(book_id)
    version = _version_or_404(book)
    chapter = db.one(
        "SELECT id FROM chapters WHERE id = ? AND version_id = ?", (chapter_id, version["id"])
    )
    if not chapter:
        raise HTTPException(status_code=404, detail={"code": "CHAPTER_NOT_FOUND"})
    active_job = db.one(
        """
        SELECT j.* FROM jobs j JOIN job_chapters jc ON jc.job_id = j.id
        WHERE j.book_id = ? AND jc.chapter_id = ? AND j.status IN ('queued', 'running')
        ORDER BY j.created_at DESC LIMIT 1
        """,
        (book_id, chapter_id),
    )
    if active_job:
        return active_job
    provider = get_chapter_provider(MODEL_CONFIGURATION)
    job = create_generation_job(
        db, book_id, version["id"], provider=provider, chapter_id=chapter_id
    )
    background_tasks.add_task(
        run_generation_job,
        db,
        job["id"],
        book_id,
        version["id"],
        provider,
        chapter_id,
    )
    return job


@app.post("/api/v1/books/{book_id}/generation-runs", status_code=202)
def start_generation(
    book_id: str,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    del background_tasks
    _book_or_404(book_id)
    raise HTTPException(
        status_code=422,
        detail={
            "code": "CHAPTER_REQUIRED",
            "message": "请选择一个章节后再执行阅读单元拆分。",
        },
    )


@app.get("/api/v1/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    job = db.one("SELECT * FROM jobs WHERE id = ?", (job_id,))
    if not job:
        raise HTTPException(status_code=404, detail={"code": "JOB_NOT_FOUND"})
    return job


@app.post("/api/v1/jobs/{job_id}/retry", status_code=202)
def retry_job(job_id: str, background_tasks: BackgroundTasks) -> dict[str, Any]:
    existing = db.one("SELECT * FROM jobs WHERE id = ?", (job_id,))
    if not existing:
        raise HTTPException(status_code=404, detail={"code": "JOB_NOT_FOUND"})
    if existing["status"] not in {"failed", "partial"}:
        return existing
    chapter_link = db.one("SELECT chapter_id FROM job_chapters WHERE job_id = ?", (job_id,))
    if not chapter_link:
        raise HTTPException(status_code=422, detail={"code": "CHAPTER_REQUIRED"})
    provider = get_chapter_provider(MODEL_CONFIGURATION)
    job = create_generation_job(
        db,
        existing["book_id"],
        existing["version_id"],
        provider=provider,
        chapter_id=chapter_link["chapter_id"],
    )
    background_tasks.add_task(
        run_generation_job,
        db,
        job["id"],
        existing["book_id"],
        existing["version_id"],
        provider,
        chapter_link["chapter_id"],
    )
    return job


@app.get("/api/v1/books/{book_id}/map")
def get_map(book_id: str) -> dict[str, Any]:
    book = _book_or_404(book_id)
    map_version = _map_for_book(book, allow_generating=True)
    if map_version["status"] == "generating":
        raise HTTPException(status_code=409, detail={"code": "MAP_GENERATING"})
    return _map_payload(book, map_version)


@app.get("/api/v1/reading-units/{unit_id}")
def get_reading_unit(unit_id: str) -> dict[str, Any]:
    unit = db.one(
        """
        SELECT ru.*, c.title AS chapter_title, c.version_id, b.id AS book_id
        FROM reading_units ru
        JOIN chapters c ON c.id = ru.chapter_id
        JOIN books b ON b.current_version_id = c.version_id
        WHERE ru.id = ? AND b.owner_id = ? AND ru.status = 'published'
        """,
        (unit_id, DEMO_USER_ID),
    )
    if not unit:
        raise HTTPException(status_code=404, detail={"code": "READING_UNIT_NOT_FOUND"})
    paragraphs = db.query(
        """
        SELECT p.*
        FROM reading_unit_paragraphs rup
        JOIN paragraphs p ON p.id = rup.paragraph_id
        WHERE rup.reading_unit_id = ?
        ORDER BY rup.ordinal
        """,
        (unit_id,),
    )
    sections = db.query(
        """
        SELECT * FROM reading_unit_sections
        WHERE reading_unit_id = ? ORDER BY ordinal
        """,
        (unit_id,),
    )
    chapter_units_set = db.one("SELECT * FROM unit_sets WHERE id = ?", (unit["unit_set_id"],))
    chapter_units = db.query(
        "SELECT * FROM reading_units WHERE unit_set_id = ? ORDER BY ordinal", (unit["unit_set_id"],)
    )
    annotations = db.query(
        """
        SELECT DISTINCT a.* FROM annotations a
        JOIN annotation_anchors aa ON aa.annotation_id = a.id
        JOIN reading_unit_paragraphs rup ON rup.paragraph_id = aa.paragraph_id
        WHERE a.user_id = ? AND rup.reading_unit_id = ?
        ORDER BY a.created_at DESC
        """,
        (DEMO_USER_ID, unit_id),
    )
    book = _book_or_404(unit["book_id"])
    return {
        "book": _book_payload(book),
        "chapter": {
            "id": unit["chapter_id"],
            "title": unit["chapter_title"],
            "unit_set": chapter_units_set,
            "units": chapter_units,
        },
        "unit": unit,
        "paragraphs": paragraphs,
        "reading_progress": _reading_progress(book, paragraphs),
        "sections": sections,
        "annotations": [_annotation_payload(annotation) for annotation in annotations],
    }


@app.patch("/api/v1/reading-units/{unit_id}/sections/{ordinal}")
def update_reading_unit_section(
    unit_id: str,
    ordinal: int,
    body: ReadingUnitSectionUpdate,
) -> dict[str, Any]:
    """Keep generated source locked while allowing a reader to fill the deep-read scaffold."""

    if ordinal < 2 or ordinal > 9:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "IMMUTABLE_OR_INVALID_SECTION",
                "message": "原文区不可编辑；请选择第 2 至第 9 节。",
            },
        )
    section = db.one(
        """
        SELECT rus.* FROM reading_unit_sections rus
        JOIN reading_units ru ON ru.id = rus.reading_unit_id
        JOIN chapters c ON c.id = ru.chapter_id
        JOIN books b ON b.current_version_id = c.version_id
        WHERE rus.reading_unit_id = ? AND rus.ordinal = ? AND b.owner_id = ?
        """,
        (unit_id, ordinal, DEMO_USER_ID),
    )
    if not section:
        raise HTTPException(status_code=404, detail={"code": "READING_UNIT_SECTION_NOT_FOUND"})
    db.execute(
        "UPDATE reading_unit_sections SET body = ? WHERE id = ?",
        (body.body, section["id"]),
    )
    return db.one("SELECT * FROM reading_unit_sections WHERE id = ?", (section["id"],)) or {}


@app.post("/api/v1/books/{book_id}/explored/{node_id}", status_code=204)
def mark_explored(book_id: str, node_id: str) -> Response:
    book = _book_or_404(book_id)
    map_version = _map_for_book(book)
    node = db.one(
        "SELECT id FROM nodes WHERE id = ? AND map_version_id = ?",
        (node_id, map_version["id"]),
    )
    if not node:
        raise HTTPException(status_code=404, detail={"code": "NODE_NOT_FOUND"})
    db.execute(
        """
        INSERT INTO explored_nodes (user_id, map_version_id, node_id, opened_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, node_id) DO UPDATE SET opened_at = excluded.opened_at
        """,
        (DEMO_USER_ID, map_version["id"], node_id, utc_now()),
    )
    return Response(status_code=204)


def _saved_reading_position(book: dict[str, Any]) -> dict[str, Any] | None:
    position = db.one(
        """SELECT rp.*, c.title AS chapter_title, ru.title AS unit_title,
                  CASE WHEN ru.status = 'published' AND ru.chapter_id = c.id THEN ru.id END AS valid_unit_id
           FROM reading_positions rp
           JOIN chapters c ON c.id = rp.chapter_id AND c.version_id = ?
           LEFT JOIN reading_units ru ON ru.id = rp.reading_unit_id
           WHERE rp.user_id = ? AND rp.book_id = ?""",
        (book["current_version_id"], DEMO_USER_ID, book["id"]),
    )
    if not position:
        return None
    unit_id = position.pop("valid_unit_id")
    position["reading_unit_id"] = unit_id
    paragraph = db.one("SELECT chapter_id, LENGTH(text) AS length FROM paragraphs WHERE id = ?", (position["paragraph_id"],)) if position["paragraph_id"] else None
    if not paragraph or paragraph["chapter_id"] != position["chapter_id"]:
        position.update(paragraph_id=None, character_offset=0, anchor_progress=0)
    else:
        position["character_offset"] = min(position["character_offset"], paragraph["length"])
    if not unit_id:
        position["section_ordinal"] = None
    route = f"/books/{book['id']}/units/{unit_id}" if unit_id else f"/books/{book['id']}/chapters/{position['chapter_id']}"
    position["resume_path"] = route
    return position


@app.get("/api/v1/books/{book_id}/reading-position")
def get_reading_position(book_id: str) -> dict[str, Any]:
    book = _book_or_404(book_id)
    position = _saved_reading_position(book)
    first = db.one("SELECT id FROM chapters WHERE version_id = ? ORDER BY ordinal, id LIMIT 1", (book["current_version_id"],))
    return {"position": position, "resume_path": position["resume_path"] if position else f"/books/{book_id}/chapters/{first['id']}" if first else None}


@app.put("/api/v1/books/{book_id}/reading-position")
def save_reading_position(book_id: str, body: ReadingPositionUpdate) -> dict[str, Any]:
    book = _book_or_404(book_id)
    chapter = db.one("SELECT id FROM chapters WHERE id = ? AND version_id = ?", (body.chapter_id, book["current_version_id"]))
    if not chapter:
        raise HTTPException(status_code=422, detail={"code": "INVALID_READING_CHAPTER", "message": "阅读章节不属于这本书"})
    if body.reading_unit_id and not db.one("SELECT id FROM reading_units WHERE id = ? AND chapter_id = ? AND status = 'published'", (body.reading_unit_id, body.chapter_id)):
        raise HTTPException(status_code=422, detail={"code": "INVALID_READING_UNIT", "message": "阅读单元不属于当前章节"})
    if body.section_ordinal and not body.reading_unit_id:
        raise HTTPException(status_code=422, detail={"code": "INVALID_READING_SECTION"})
    if body.paragraph_id:
        paragraph = db.one("SELECT text FROM paragraphs WHERE id = ? AND chapter_id = ? AND status = 'ready'", (body.paragraph_id, body.chapter_id))
        if not paragraph or body.character_offset > len(paragraph["text"]):
            raise HTTPException(status_code=422, detail={"code": "INVALID_READING_ANCHOR", "message": "阅读位置与原文不一致"})
        if body.reading_unit_id and not db.one("SELECT id FROM reading_unit_paragraphs WHERE reading_unit_id = ? AND paragraph_id = ?", (body.reading_unit_id, body.paragraph_id)):
            raise HTTPException(status_code=422, detail={"code": "INVALID_READING_ANCHOR"})
    elif body.character_offset:
        raise HTTPException(status_code=422, detail={"code": "INVALID_READING_ANCHOR"})
    now = utc_now()
    with db.transaction() as connection:
        cursor = connection.execute(
            """INSERT INTO reading_positions (user_id, book_id, chapter_id, reading_unit_id, paragraph_id,
                   character_offset, section_ordinal, anchor_progress, captured_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, book_id) DO UPDATE SET
                   chapter_id=excluded.chapter_id, reading_unit_id=excluded.reading_unit_id,
                   paragraph_id=excluded.paragraph_id, character_offset=excluded.character_offset,
                   section_ordinal=excluded.section_ordinal, anchor_progress=excluded.anchor_progress,
                   captured_at=excluded.captured_at, updated_at=excluded.updated_at
               WHERE excluded.captured_at >= reading_positions.captured_at""",
            (DEMO_USER_ID, book_id, body.chapter_id, body.reading_unit_id, body.paragraph_id, body.character_offset,
             body.section_ordinal, body.anchor_progress, body.captured_at, now),
        )
        if cursor.rowcount:
            connection.execute("UPDATE books SET last_read_at = ? WHERE id = ?", (now, book_id))
    return {"position": _saved_reading_position(book)}


@app.put("/api/v1/books/{book_id}/reading-state")
def update_reading_state(book_id: str, body: ReadingStateUpdate) -> dict[str, Any]:
    book = _book_or_404(book_id)
    now = utc_now()
    db.execute(
        """
        INSERT INTO reading_states (
            user_id, book_id, last_map_version_id, last_node_id,
            last_paragraph_id, path_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, book_id) DO UPDATE SET
            last_map_version_id = excluded.last_map_version_id,
            last_node_id = excluded.last_node_id,
            last_paragraph_id = excluded.last_paragraph_id,
            path_json = excluded.path_json,
            updated_at = excluded.updated_at
        """,
        (
            DEMO_USER_ID,
            book_id,
            body.map_version_id,
            body.node_id,
            body.paragraph_id,
            Database.dumps(body.path),
            now,
        ),
    )
    db.execute("UPDATE books SET last_read_at = ?, updated_at = ? WHERE id = ?", (now, now, book_id))
    return db.one(
        "SELECT * FROM reading_states WHERE user_id = ? AND book_id = ?",
        (DEMO_USER_ID, book_id),
    ) or {}


@app.get("/api/v1/books/{book_id}/paragraphs/{paragraph_id}")
def get_paragraph(book_id: str, paragraph_id: str) -> dict[str, Any]:
    book = _book_or_404(book_id)
    paragraph = db.one(
        """
        SELECT p.id FROM paragraphs p
        JOIN chapters c ON c.id = p.chapter_id
        WHERE p.id = ? AND c.version_id = ?
        """,
        (paragraph_id, book["current_version_id"]),
    )
    if not paragraph:
        raise HTTPException(status_code=404, detail={"code": "PARAGRAPH_NOT_FOUND"})
    return _paragraph_payload(paragraph_id)


@app.put("/api/v1/books/{book_id}/paragraphs/{paragraph_id}/read")
def mark_read(book_id: str, paragraph_id: str, body: ReadUpdate) -> dict[str, Any]:
    book = _book_or_404(book_id)
    paragraph = db.one(
        """
        SELECT p.id, c.version_id FROM paragraphs p
        JOIN chapters c ON c.id = p.chapter_id
        WHERE p.id = ? AND c.version_id = ?
        """,
        (paragraph_id, book["current_version_id"]),
    )
    if not paragraph:
        raise HTTPException(status_code=404, detail={"code": "PARAGRAPH_NOT_FOUND"})
    if body.read:
        db.execute(
            """
            INSERT INTO read_paragraphs (user_id, version_id, paragraph_id, marked_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, paragraph_id) DO UPDATE SET marked_at = excluded.marked_at
            """,
            (DEMO_USER_ID, paragraph["version_id"], paragraph_id, utc_now()),
        )
    else:
        db.execute(
            "DELETE FROM read_paragraphs WHERE user_id = ? AND paragraph_id = ?",
            (DEMO_USER_ID, paragraph_id),
        )
    return {"paragraph_id": paragraph_id, "read": body.read}


@app.get("/api/v1/books/{book_id}/search")
def search_book(
    book_id: str,
    q: str = Query(min_length=1, max_length=120),
) -> dict[str, Any]:
    book = _book_or_404(book_id)
    version = _version_or_404(book)
    pattern = f"%{q.strip()}%"
    paragraphs = db.query(
        """
        SELECT p.id, p.text, p.ordinal, c.id AS chapter_id, c.title AS chapter_title,
               c.ordinal AS chapter_ordinal
        FROM paragraphs p
        JOIN chapters c ON c.id = p.chapter_id
        WHERE c.version_id = ? AND p.text LIKE ?
        ORDER BY c.ordinal, p.ordinal
        LIMIT 40
        """,
        (version["id"], pattern),
    )
    nodes = db.query(
        """
        SELECT DISTINCT n.id, n.title, n.statement, n.type, n.origin
        FROM nodes n
        JOIN map_versions m ON m.id = n.map_version_id
        WHERE m.book_version_id = ? AND n.status = 'published'
          AND (n.title LIKE ? OR n.statement LIKE ? OR n.summary LIKE ?)
        ORDER BY n.ordinal
        LIMIT 40
        """,
        (version["id"], pattern, pattern, pattern),
    )
    return {
        "query": q,
        "paragraphs": paragraphs,
        "nodes": nodes,
        "total": len(paragraphs) + len(nodes),
    }


def _reading_unit_for_paragraph(paragraph_id: str) -> dict[str, Any] | None:
    """Prefer the latest published unit that contains this paragraph."""

    return db.one(
        """
        SELECT ru.id AS reading_unit_id, ru.title AS reading_unit_title,
               ru.ordinal AS unit_ordinal, us.published_at
        FROM reading_unit_paragraphs rup
        JOIN reading_units ru ON ru.id = rup.reading_unit_id
        JOIN unit_sets us ON us.id = ru.unit_set_id
        WHERE rup.paragraph_id = ? AND ru.status = 'published'
        ORDER BY COALESCE(us.published_at, us.created_at) DESC, ru.ordinal
        LIMIT 1
        """,
        (paragraph_id,),
    )


def _note_link(book_id: str, chapter_id: str, reading_unit_id: str | None) -> str:
    if reading_unit_id:
        return f"/books/{book_id}/units/{reading_unit_id}"
    return f"/books/{book_id}/chapters/{chapter_id}"


def _collect_reading_notes(book_id: str | None = None) -> list[dict[str, Any]]:
    """Aggregate section notes, annotations, and paragraph notes into one list."""

    book_filter = "AND b.id = ?" if book_id else ""
    book_params: tuple[Any, ...] = (book_id,) if book_id else ()

    section_rows = db.query(
        f"""
        SELECT rus.id, rus.body, rus.ordinal AS section_ordinal, rus.title AS section_title,
               rus.kind AS section_kind,
               ru.id AS reading_unit_id, ru.title AS reading_unit_title, ru.ordinal AS unit_ordinal,
               c.id AS chapter_id, c.title AS chapter_title, c.ordinal AS chapter_ordinal,
               b.id AS book_id, b.title AS book_title,
               CASE WHEN b.current_version_id = c.version_id THEN 1 ELSE 0 END AS is_current_version
        FROM reading_unit_sections rus
        JOIN reading_units ru ON ru.id = rus.reading_unit_id
        JOIN chapters c ON c.id = ru.chapter_id
        JOIN book_versions bv ON bv.id = c.version_id
        JOIN books b ON b.id = bv.book_id
        WHERE b.owner_id = ?
          AND rus.ordinal BETWEEN 2 AND 9
          AND TRIM(rus.body) != ''
          AND ru.status = 'published'
          {book_filter}
        ORDER BY b.title, c.ordinal, ru.ordinal, rus.ordinal
        """,
        (DEMO_USER_ID, *book_params),
    )
    sections = [
        {
            "kind": "section",
            "id": row["id"],
            "body": row["body"],
            "created_at": None,
            "updated_at": None,
            "book_id": row["book_id"],
            "book_title": row["book_title"],
            "chapter_id": row["chapter_id"],
            "chapter_title": row["chapter_title"],
            "chapter_ordinal": row["chapter_ordinal"],
            "reading_unit_id": row["reading_unit_id"],
            "reading_unit_title": row["reading_unit_title"],
            "unit_ordinal": row["unit_ordinal"],
            "section_ordinal": row["section_ordinal"],
            "section_title": row["section_title"],
            "section_kind": row["section_kind"],
            "paragraph_id": None,
            "paragraph_ordinal": None,
            "paragraph_text": None,
            "quote": None,
            "is_current_version": bool(row["is_current_version"]),
            "link_path": _note_link(row["book_id"], row["chapter_id"], row["reading_unit_id"]),
        }
        for row in section_rows
    ]

    annotation_rows = db.query(
        f"""
        SELECT a.id, a.body, a.created_at, a.updated_at,
               aa.paragraph_id, aa.quote, aa.start_offset, aa.end_offset,
               p.text AS paragraph_text, p.ordinal AS paragraph_ordinal,
               c.id AS chapter_id, c.title AS chapter_title, c.ordinal AS chapter_ordinal,
               b.id AS book_id, b.title AS book_title,
               CASE WHEN b.current_version_id = c.version_id THEN 1 ELSE 0 END AS is_current_version
        FROM annotations a
        JOIN annotation_anchors aa ON aa.annotation_id = a.id
        JOIN paragraphs p ON p.id = aa.paragraph_id
        JOIN chapters c ON c.id = p.chapter_id
        JOIN book_versions bv ON bv.id = c.version_id
        JOIN books b ON b.id = bv.book_id
        WHERE a.user_id = ? {book_filter}
        ORDER BY a.updated_at DESC
        """,
        (DEMO_USER_ID, *book_params),
    )
    annotations: list[dict[str, Any]] = []
    for row in annotation_rows:
        unit = _reading_unit_for_paragraph(row["paragraph_id"])
        annotations.append(
            {
                "kind": "annotation",
                "id": row["id"],
                "body": row["body"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "book_id": row["book_id"],
                "book_title": row["book_title"],
                "chapter_id": row["chapter_id"],
                "chapter_title": row["chapter_title"],
                "chapter_ordinal": row["chapter_ordinal"],
                "reading_unit_id": unit["reading_unit_id"] if unit else None,
                "reading_unit_title": unit["reading_unit_title"] if unit else None,
                "unit_ordinal": unit["unit_ordinal"] if unit else None,
                "section_ordinal": None,
                "section_title": None,
                "section_kind": None,
                "paragraph_id": row["paragraph_id"],
                "paragraph_ordinal": row["paragraph_ordinal"],
                "paragraph_text": row["paragraph_text"],
                "quote": row["quote"],
                "is_current_version": bool(row["is_current_version"]),
                "link_path": _note_link(
                    row["book_id"],
                    row["chapter_id"],
                    unit["reading_unit_id"] if unit else None,
                ),
            }
        )

    paragraph_note_rows = db.query(
        f"""
        SELECT n.id, n.body, n.created_at, n.updated_at, n.paragraph_id,
               p.text AS paragraph_text, p.ordinal AS paragraph_ordinal,
               c.id AS chapter_id, c.title AS chapter_title, c.ordinal AS chapter_ordinal,
               b.id AS book_id, b.title AS book_title,
               CASE WHEN b.current_version_id = c.version_id THEN 1 ELSE 0 END AS is_current_version
        FROM notes n
        JOIN paragraphs p ON p.id = n.paragraph_id
        JOIN chapters c ON c.id = p.chapter_id
        JOIN book_versions bv ON bv.id = c.version_id
        JOIN books b ON b.id = bv.book_id
        WHERE n.user_id = ? {book_filter}
        ORDER BY n.updated_at DESC
        """,
        (DEMO_USER_ID, *book_params),
    )
    paragraph_notes: list[dict[str, Any]] = []
    for row in paragraph_note_rows:
        unit = _reading_unit_for_paragraph(row["paragraph_id"])
        paragraph_notes.append(
            {
                "kind": "paragraph_note",
                "id": row["id"],
                "body": row["body"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "book_id": row["book_id"],
                "book_title": row["book_title"],
                "chapter_id": row["chapter_id"],
                "chapter_title": row["chapter_title"],
                "chapter_ordinal": row["chapter_ordinal"],
                "reading_unit_id": unit["reading_unit_id"] if unit else None,
                "reading_unit_title": unit["reading_unit_title"] if unit else None,
                "unit_ordinal": unit["unit_ordinal"] if unit else None,
                "section_ordinal": None,
                "section_title": None,
                "section_kind": None,
                "paragraph_id": row["paragraph_id"],
                "paragraph_ordinal": row["paragraph_ordinal"],
                "paragraph_text": row["paragraph_text"],
                "quote": None,
                "is_current_version": bool(row["is_current_version"]),
                "link_path": _note_link(
                    row["book_id"],
                    row["chapter_id"],
                    unit["reading_unit_id"] if unit else None,
                ),
            }
        )

    timed = sorted(
        [item for item in annotations + paragraph_notes if item.get("updated_at")],
        key=lambda item: (item["updated_at"], item["book_title"]),
        reverse=True,
    )
    untimed = sorted(
        sections,
        key=lambda item: (
            item["book_title"],
            item["chapter_ordinal"],
            item["unit_ordinal"],
            item["section_ordinal"],
        ),
    )
    return timed + untimed


@app.get("/api/v1/notes")
def list_notes(
    book_id: str | None = None,
    kind: Literal["all", "section", "annotation", "paragraph_note"] = "all",
) -> dict[str, Any]:
    items = _collect_reading_notes(book_id)
    counts = {
        "section": sum(1 for item in items if item["kind"] == "section"),
        "annotation": sum(1 for item in items if item["kind"] == "annotation"),
        "paragraph_note": sum(1 for item in items if item["kind"] == "paragraph_note"),
    }
    counts["total"] = sum(counts.values())
    if kind != "all":
        items = [item for item in items if item["kind"] == kind]
    return {"items": items, "counts": counts}


@app.get("/api/v1/notes/export")
def export_all_notes(format: Literal["markdown", "json"] = "markdown") -> Response:
    notes = _collect_reading_notes()
    if format == "json":
        content = json.dumps({"exported_at": utc_now(), "notes": notes}, ensure_ascii=False, indent=2)
        media_type = "application/json; charset=utf-8"
        extension = "json"
    else:
        lines = ["# 阅读笔记", "", f"导出时间：{utc_now()}", f"共 {len(notes)} 条", ""]
        labels = {"section": "九段笔记", "annotation": "划线笔记", "paragraph_note": "段落笔记"}
        for note in notes:
            kind = "摘抄" if note["kind"] == "annotation" and not note["body"] else labels[note["kind"]]
            context = " / ".join(
                str(part) for part in (note["book_title"], note["chapter_title"], note["reading_unit_title"])
                if part
            )
            lines.extend([f"## {kind} · {context}", ""])
            if note["section_title"]:
                lines.extend([f"位置：{note['section_title']}", ""])
            if note["paragraph_ordinal"] is not None:
                lines.extend([f"原文第 {note['paragraph_ordinal']} 段", ""])
            source = note["quote"] or (note["paragraph_text"] if note["kind"] == "paragraph_note" else None)
            if source:
                lines.extend([*(f"> {line}" for line in source.splitlines()), ""])
            if note["body"]:
                lines.extend([note["body"], ""])
            lines.extend([f"应用内位置：{note['link_path']}", ""])
        content = "\n".join(lines)
        media_type = "text/markdown; charset=utf-8"
        extension = "md"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="logic-reading-notes.{extension}"'},
    )


@app.post("/api/v1/annotations", status_code=201)
def create_annotation(body: AnnotationCreate) -> dict[str, Any]:
    paragraph = db.one(
        """
        SELECT p.id, p.text, c.version_id
        FROM paragraphs p JOIN chapters c ON c.id = p.chapter_id
        WHERE p.id = ?
        """,
        (body.paragraph_id,),
    )
    if not paragraph:
        raise HTTPException(status_code=404, detail={"code": "PARAGRAPH_NOT_FOUND"})
    if body.end_offset > len(paragraph["text"]) or body.start_offset >= body.end_offset:
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_ANNOTATION_RANGE", "message": "划线范围超出原文"},
        )
    exact_quote = paragraph["text"][body.start_offset : body.end_offset]
    if exact_quote != body.quote:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ANNOTATION_QUOTE_MISMATCH",
                "message": "划线内容与原文位置不一致，请重新选择原文",
            },
        )
    annotation_id = new_id("annotation")
    now = utc_now()
    with db.transaction() as connection:
        connection.execute(
            """
            INSERT INTO annotations (id, user_id, version_id, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (annotation_id, DEMO_USER_ID, paragraph["version_id"], body.body.strip(), now, now),
        )
        connection.execute(
            """
            INSERT INTO annotation_anchors (
                id, annotation_id, paragraph_id, start_offset, end_offset, quote
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                new_id("anchor"),
                annotation_id,
                body.paragraph_id,
                body.start_offset,
                body.end_offset,
                exact_quote,
            ),
        )
    row = db.one("SELECT * FROM annotations WHERE id = ?", (annotation_id,))
    return _annotation_payload(row or {})


@app.post("/api/v1/notes", status_code=201)
def create_note(body: NoteCreate) -> dict[str, Any]:
    paragraph = db.one(
        """
        SELECT p.id, c.version_id, c.id AS chapter_id
        FROM paragraphs p JOIN chapters c ON c.id = p.chapter_id
        WHERE p.id = ?
        """,
        (body.paragraph_id,),
    )
    if not paragraph:
        raise HTTPException(status_code=404, detail={"code": "PARAGRAPH_NOT_FOUND"})
    note_id = new_id("note")
    now = utc_now()
    db.insert(
        "notes",
        {
            "id": note_id,
            "user_id": DEMO_USER_ID,
            "version_id": paragraph["version_id"],
            "paragraph_id": body.paragraph_id,
            "body": body.body.strip(),
            "created_at": now,
            "updated_at": now,
        },
    )
    return db.one("SELECT * FROM notes WHERE id = ?", (note_id,)) or {}


@app.patch("/api/v1/notes/{note_id}")
def update_note(note_id: str, body: NoteUpdate) -> dict[str, Any]:
    note = db.one(
        "SELECT * FROM notes WHERE id = ? AND user_id = ?",
        (note_id, DEMO_USER_ID),
    )
    if not note:
        raise HTTPException(status_code=404, detail={"code": "NOTE_NOT_FOUND"})
    db.execute(
        "UPDATE notes SET body = ?, updated_at = ? WHERE id = ?",
        (body.body.strip(), utc_now(), note_id),
    )
    return db.one("SELECT * FROM notes WHERE id = ?", (note_id,)) or {}


@app.delete("/api/v1/notes/{note_id}", status_code=204)
def delete_note(note_id: str) -> Response:
    note = db.one(
        "SELECT id FROM notes WHERE id = ? AND user_id = ?",
        (note_id, DEMO_USER_ID),
    )
    if not note:
        raise HTTPException(status_code=404, detail={"code": "NOTE_NOT_FOUND"})
    db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    return Response(status_code=204)


@app.delete("/api/v1/annotations/{annotation_id}", status_code=204)
def delete_annotation(annotation_id: str) -> Response:
    annotation = db.one(
        "SELECT id FROM annotations WHERE id = ? AND user_id = ?",
        (annotation_id, DEMO_USER_ID),
    )
    if not annotation:
        raise HTTPException(status_code=404, detail={"code": "ANNOTATION_NOT_FOUND"})
    db.execute("DELETE FROM annotations WHERE id = ?", (annotation_id,))
    return Response(status_code=204)


@app.get("/api/v1/books/{book_id}/export")
def export_book(book_id: str) -> Response:
    book = _book_or_404(book_id)
    notes = list_notes(book_id)["items"]
    state = db.one(
        "SELECT * FROM reading_states WHERE user_id = ? AND book_id = ?",
        (DEMO_USER_ID, book_id),
    )
    payload = {
        "exported_at": utc_now(),
        "book": {
            "id": book["id"],
            "title": book["title"],
            "author": book["author"],
        },
        "notes": notes,
        "section_notes": [item for item in notes if item["kind"] == "section"],
        "annotations": [item for item in notes if item["kind"] == "annotation"],
        "paragraph_notes": [item for item in notes if item["kind"] == "paragraph_note"],
        "reading_state": {
            **state,
            "path": Database.loads(state["path_json"], []) if state else [],
        }
        if state
        else None,
    }
    serialized = json.dumps(payload, ensure_ascii=False, indent=2)
    filename = f"duobook-{book_id}.json"
    return Response(
        content=serialized,
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.delete("/api/v1/books/{book_id}", status_code=204)
def delete_book(book_id: str) -> Response:
    book = _book_or_404(book_id)
    versions = db.query(
        "SELECT source_path FROM book_versions WHERE book_id = ?",
        (book_id,),
    )
    db.execute("UPDATE books SET status = 'deleting', updated_at = ? WHERE id = ?", (utc_now(), book_id))
    db.execute("DELETE FROM books WHERE id = ?", (book_id,))
    for version in versions:
        source_path = version.get("source_path")
        if source_path:
            try:
                Path(source_path).unlink(missing_ok=True)
            except OSError:
                pass
    return Response(status_code=204)


@app.exception_handler(HTTPException)
async def http_exception_handler(_, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict):
        code = detail.get("code", "HTTP_ERROR")
        message = detail.get("message", code)
        extra = {key: value for key, value in detail.items() if key not in {"code", "message"}}
    else:
        code = "HTTP_ERROR"
        message = str(detail)
        extra = {}
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": code,
                "message": message,
                "request_id": new_id("req"),
                "details": extra,
            }
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
