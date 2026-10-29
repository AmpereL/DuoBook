import time

from app.db import Database, db
from app.seed import seed_demo


def body(client, chapter_id="chapter_goal", captured_at=100):
    paragraph = client.get(f"/api/v1/books/book_learning/chapters/{chapter_id}").json()["paragraphs"][1]
    return {"chapter_id": chapter_id, "reading_unit_id": None, "paragraph_id": paragraph["id"],
            "character_offset": 3, "section_ordinal": None, "anchor_progress": .4, "captured_at": captured_at}


def test_position_persists_and_books_expose_resume_summary(client):
    assert client.get("/api/v1/books/book_learning/reading-position").json()["position"] is None
    value = body(client)
    response = client.put("/api/v1/books/book_learning/reading-position", json=value)
    assert response.status_code == 200, response.text
    position = client.get("/api/v1/books/book_learning/reading-position").json()["position"]
    assert position["paragraph_id"] == value["paragraph_id"]
    assert position["character_offset"] == 3
    assert position["anchor_progress"] == .4
    assert position["resume_path"] == "/books/book_learning/chapters/chapter_goal"
    book = client.get("/api/v1/books/book_learning").json()
    assert book["reading_position"]["paragraph_id"] == value["paragraph_id"]
    assert book["last_read_at"]
    db.initialize()
    assert client.get("/api/v1/books/book_learning/reading-position").json()["position"]["paragraph_id"] == value["paragraph_id"]


def test_position_rejects_cross_book_chapter_unit_and_bad_offsets(client):
    value = body(client)
    for update in ({"chapter_id": "missing"}, {"paragraph_id": "p_recall_3"}, {"reading_unit_id": "missing"},
                   {"character_offset": 100000}, {"anchor_progress": 1.1}, {"paragraph_id": None, "character_offset": 1},
                   {"section_ordinal": 8}, {"captured_at": 10 ** 50}):
        assert client.put("/api/v1/books/book_learning/reading-position", json={**value, **update}).status_code == 422
    assert client.put("/api/v1/books/missing/reading-position", json=value).status_code == 404
    assert client.get("/api/v1/books/missing/reading-position").status_code == 404


def test_late_save_cannot_overwrite_a_newer_location_or_read_time(client):
    first = body(client, captured_at=200)
    client.put("/api/v1/books/book_learning/reading-position", json=first)
    last_read = client.get("/api/v1/books/book_learning").json()["last_read_at"]
    stale = body(client, captured_at=100)
    stale["paragraph_id"] = client.get("/api/v1/books/book_learning/chapters/chapter_goal").json()["paragraphs"][0]["id"]
    response = client.put("/api/v1/books/book_learning/reading-position", json=stale)
    assert response.json()["position"]["paragraph_id"] == first["paragraph_id"]
    assert client.get("/api/v1/books/book_learning").json()["last_read_at"] == last_read


def test_unit_position_survives_resplit_and_falls_back_after_unit_removal(client):
    client.post("/api/v1/books/book_learning/chapters/chapter_goal/split-runs")
    chapter = client.get("/api/v1/books/book_learning/chapters/chapter_goal").json()
    unit = chapter["units"][0]
    source = client.get(f"/api/v1/reading-units/{unit['id']}").json()
    value = {**body(client), "reading_unit_id": unit["id"], "paragraph_id": source["paragraphs"][0]["id"], "section_ordinal": 8}
    saved = client.put("/api/v1/books/book_learning/reading-position", json=value)
    assert saved.status_code == 200, saved.text
    client.post("/api/v1/books/book_learning/chapters/chapter_goal/split-runs")
    assert client.get("/api/v1/books/book_learning/reading-position").json()["resume_path"].endswith(unit["id"])
    db.execute("DELETE FROM reading_units WHERE id = ?", (unit["id"],))
    resumed = client.get("/api/v1/books/book_learning/reading-position").json()
    assert resumed["resume_path"].endswith("chapters/chapter_goal")
    assert resumed["position"]["section_ordinal"] is None
    client.delete("/api/v1/books/book_learning")
    assert not db.query("SELECT * FROM reading_positions")


def test_initialization_adds_position_table_to_an_existing_library(tmp_path):
    database = Database(tmp_path / "existing.db")
    database.initialize()
    seed_demo(database)
    books = database.query("SELECT * FROM books")
    database.execute("DROP TABLE reading_positions")
    database.initialize()
    assert database.query("SELECT * FROM books") == books
    assert database.query("SELECT * FROM reading_positions") == []
