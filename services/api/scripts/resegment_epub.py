"""Conservative one-book EPUB chapter repair; preserves existing paragraph IDs."""
from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.db import Database, db, new_id
from app.parsers import parse_file


def repair(book_id: str) -> tuple[int, Path]:
    book = db.one('SELECT * FROM books WHERE id = ?', (book_id,))
    if not book:
        raise ValueError('Book not found')
    version = db.one('SELECT * FROM book_versions WHERE id = ? AND book_id = ?', (book['current_version_id'], book_id))
    if not version or version['format'] != 'epub' or not version['source_path']:
        raise ValueError('This operation needs an archived EPUB source')
    source = Path(version['source_path'])
    parsed = parse_file(source.read_bytes(), source.name)
    old_chapters = db.query('SELECT * FROM chapters WHERE version_id = ? ORDER BY ordinal', (version['id'],))
    old_paragraphs = db.query(
        'SELECT p.* FROM paragraphs p JOIN chapters c ON c.id = p.chapter_id '
        'WHERE c.version_id = ? ORDER BY c.ordinal, p.ordinal', (version['id'],)
    )
    new_paragraphs = [p for chapter in parsed.chapters for p in chapter.paragraphs]
    if len(parsed.chapters) <= len(old_chapters):
        raise ValueError('Reparse did not find more chapters; no change made')
    if [p['text'] for p in old_paragraphs] != [p.text for p in new_paragraphs]:
        raise ValueError('Paragraph text or order changed; manual migration required')
    if not old_paragraphs or any(not chapter['source_path'] for chapter in old_chapters):
        raise ValueError('Existing source path metadata is incomplete')
    for table in ('unit_sets', 'reading_units', 'job_chapters', 'node_chapters'):
        row = db.one(f'SELECT COUNT(*) AS count FROM {table} WHERE chapter_id IN '
                     '(SELECT id FROM chapters WHERE version_id = ?)', (version['id'],))
        if row['count']:
            raise ValueError(f'Existing {table} depends on old chapter IDs; manual migration required')
    old_by_source = {chapter['source_path']: chapter for chapter in old_chapters}
    if len(old_by_source) != len(old_chapters):
        raise ValueError('Old chapters do not map one-to-one to spine resources')
    backup = db.path.parent / f"backup-before-epub-resegment-{book_id}-{datetime.now():%Y%m%d-%H%M%S}.db"
    with sqlite3.connect(db.path) as origin, sqlite3.connect(backup) as copy:
        origin.backup(copy)
    allocated_sources: set[str] = set()
    used_old_ids: set[str] = set()
    offset = 0
    with db.transaction() as connection:
        for ordinal, chapter in enumerate(parsed.chapters, start=1):
            resource = chapter.source_path
            old = old_by_source.get(resource) if resource not in allocated_sources else None
            allocated_sources.add(resource)
            chapter_id = old['id'] if old else new_id('chapter')
            if old:
                used_old_ids.add(chapter_id)
                connection.execute('UPDATE chapters SET title = ?, ordinal = ?, source_path = ? WHERE id = ?',
                                   (chapter.title, ordinal, resource, chapter_id))
            else:
                connection.execute(
                    'INSERT INTO chapters (id, version_id, parent_id, ordinal, title, source_path, page_start, page_end) '
                    'VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)',
                    (chapter_id, version['id'], ordinal, chapter.title, resource),
                )
            for paragraph_ordinal, _ in enumerate(chapter.paragraphs, start=1):
                row = old_paragraphs[offset]
                connection.execute('UPDATE paragraphs SET chapter_id = ?, ordinal = ? WHERE id = ?',
                                   (chapter_id, paragraph_ordinal, row['id']))
                offset += 1
        for old in old_chapters:
            if old['id'] not in used_old_ids:
                connection.execute('DELETE FROM chapters WHERE id = ?', (old['id'],))
    actual = db.query('SELECT p.id, p.text FROM paragraphs p JOIN chapters c ON c.id = p.chapter_id '
                      'WHERE c.version_id = ? ORDER BY c.ordinal, p.ordinal', (version['id'],))
    if [(p['id'], p['text']) for p in actual] != [(p['id'], p['text']) for p in old_paragraphs]:
        raise RuntimeError(f'Post-write verification failed; restore backup {backup}')
    return len(parsed.chapters), backup


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('book_id')
    args = parser.parse_args()
    count, backup = repair(args.book_id)
    print(f'Repaired {count} chapters; preserved all paragraph IDs and order. Backup: {backup}')
