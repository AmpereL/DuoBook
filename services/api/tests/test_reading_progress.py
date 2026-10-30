from app.db import db
from app.providers import UnitPlan, UnitPlanItem
from app.reading_units import persist_unit_set, unit_drafts_from_plan


def all_source(client):
    chapters = client.get('/api/v1/books/book_learning/chapters').json()['chapters']
    return [p for chapter in chapters for p in client.get(f"/api/v1/books/book_learning/chapters/{chapter['id']}").json()['paragraphs']]


def test_book_progress_uses_unicode_source_order_and_follows_reordered_chapters(client):
    db.execute('UPDATE paragraphs SET text = ? WHERE id = ?', ('甲😊\t乙\nABC', 'p_goal_1'))
    paragraphs = all_source(client)
    payload = client.get('/api/v1/books/book_learning/chapters/chapter_recall').json()['reading_progress']
    assert payload['total_characters'] == sum(len(p['text']) for p in paragraphs)
    first = payload['paragraphs'][0]
    assert first['paragraph_id'] == 'p_recall_1'
    assert first['start_character'] == sum(len(p['text']) for p in paragraphs[:2])
    assert first['character_count'] == len(paragraphs[2]['text'])
    assert len(payload['paragraphs']) == 5
    # The book's legacy char_count is an import estimate, not the progress denominator.
    db.execute('UPDATE book_versions SET char_count = 999999')
    assert client.get('/api/v1/books/book_learning/chapters/chapter_recall').json()['reading_progress'] == payload
    db.execute('UPDATE chapters SET ordinal = 9 WHERE id = ?', ('chapter_goal',))
    reordered = client.get('/api/v1/books/book_learning/chapters/chapter_goal').json()['reading_progress']
    assert reordered['total_characters'] == payload['total_characters']
    assert reordered['paragraphs'][0]['start_character'] == sum(len(p['text']) for p in paragraphs[2:])


def test_unit_progress_keeps_book_offsets_and_does_not_double_count_resplit_versions(client):
    chapter = db.one('SELECT * FROM chapters WHERE id = ?', ('chapter_recall',))
    paragraphs = db.query('SELECT * FROM paragraphs WHERE chapter_id = ? ORDER BY ordinal', (chapter['id'],))
    plan = UnitPlan(intro='', units=[UnitPlanItem('前半', paragraphs[0]['id'], '', '', ''), UnitPlanItem('后半', paragraphs[2]['id'], '', '', '')])
    draft = unit_drafts_from_plan(chapter['title'], paragraphs, plan)
    with db.transaction() as connection:
        first = persist_unit_set(connection, chapter, paragraphs, draft, 'test')
    old = client.get(f"/api/v1/reading-units/{first[1]['id']}").json()['reading_progress']
    source = all_source(client)
    assert old['total_characters'] == sum(len(p['text']) for p in source)
    assert old['paragraphs'][0]['start_character'] == sum(len(p['text']) for p in source[:4])
    assert [p['paragraph_id'] for p in old['paragraphs']] == [p['id'] for p in paragraphs[2:]]
    with db.transaction() as connection:
        second = persist_unit_set(connection, chapter, paragraphs, draft, 'test')
    assert client.get(f"/api/v1/reading-units/{second[1]['id']}").json()['reading_progress'] == old
    assert client.get(f"/api/v1/reading-units/{first[1]['id']}").json()['reading_progress'] == old


def test_empty_book_progress_is_finite_and_unknown_sources_are_rejected(client):
    db.execute('UPDATE paragraphs SET text = ?', ('',))
    progress = client.get('/api/v1/books/book_learning/chapters/chapter_goal').json()['reading_progress']
    assert progress['total_characters'] == 0
    assert all(p['start_character'] == p['character_count'] == 0 for p in progress['paragraphs'])
    assert client.get('/api/v1/books/missing/chapters/chapter_goal').status_code == 404
    assert client.get('/api/v1/books/book_learning/chapters/missing').status_code == 404
