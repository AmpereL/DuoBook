import io
import zipfile
import pytest
from app.covers import extract_cover
from tests.test_api import make_epub


@pytest.mark.parametrize('mode', ['epub3', 'epub2', 'guide'])
def test_declared_cover_served_without_changing_source(client, mode):
    original = zipfile.ZipFile(io.BytesIO(make_epub()))
    output = io.BytesIO()
    image = b'\x89PNG\r\n\x1a\ncover-fixture'
    with zipfile.ZipFile(output, 'w') as target:
        for entry in original.infolist():
            data = original.read(entry)
            if entry.filename.endswith('.opf'):
                text = data.decode()
                prop = ' properties="cover-image"' if mode == 'epub3' else ''
                text = text.replace('</manifest>', f'<item id="cover" href="images/cover%20image.png" media-type="image/png"{prop}/></manifest>')
                if mode == 'epub2': text = text.replace('</metadata>', '<meta name="cover" content="cover"/></metadata>')
                if mode == 'guide': text = text.replace('</package>', '<guide><reference type="cover" href="cover.xhtml#top"/></guide></package>')
                data = text.encode()
            target.writestr(entry, data)
        target.writestr('OEBPS/images/cover image.png', image)
        target.writestr('OEBPS/cover.xhtml', '<html><img src="images/cover%20image.png"/></html>')
    uploaded = client.post('/api/v1/books/upload', files={'file': ('cover.epub', output.getvalue(), 'application/epub+zip')})
    assert uploaded.status_code == 201
    cover = client.get(uploaded.json()['book']['cover_url'])
    assert cover.status_code == 200
    assert cover.headers['content-type'] == 'image/png'
    assert cover.content == image


def test_missing_cover_allows_graphic_fallback(client, tmp_path):
    cover = client.get('/api/v1/books/book_learning/cover')
    assert cover.status_code == 404
    path = tmp_path / 'no-cover.epub'
    path.write_bytes(make_epub())
    assert extract_cover(str(path), path.stat().st_mtime_ns) is None
