"""Read publisher-declared EPUB covers; never guess a cover from a body image."""
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
import posixpath
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
import zipfile

LIMIT = 10 * 1024 * 1024


def resolve(base: str, href: str) -> str:
    url = urlsplit(href)
    if url.scheme or url.netloc:
        return ''
    path = posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(url.path)))
    return '' if path.startswith(('../', '/')) else path


class CoverImages(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'img':
            self.refs.append(values.get('src', ''))
        elif tag == 'image':
            self.refs.append(values.get('href', values.get('xlink:href', '')))


def image_type(data: bytes) -> str | None:
    if data.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png'
    if data.startswith(b'\xff\xd8\xff'): return 'image/jpeg'
    if data.startswith((b'GIF87a', b'GIF89a')): return 'image/gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP': return 'image/webp'
    return None


@lru_cache(maxsize=16)
def extract_cover(source: str, mtime: int) -> tuple[bytes, str] | None:
    del mtime  # Included in cache key to invalidate replaced files.
    try:
        if Path(source).suffix.lower() != '.epub': return None
        with zipfile.ZipFile(source) as archive:
            def read(name):
                if not name or archive.getinfo(name).file_size > LIMIT: raise ValueError('Oversized cover')
                return archive.read(name)
            container = ET.fromstring(read('META-INF/container.xml'))
            rootfile = container.find('.//{*}rootfile')
            if rootfile is None: return None
            opf_path = rootfile.attrib['full-path']
            opf = ET.fromstring(read(opf_path))
            items = {item.attrib.get('id'): item for item in opf.findall('.//{*}manifest/{*}item')}
            candidates = []
            for item in items.values():
                if 'cover-image' in item.attrib.get('properties', '').split():
                    candidates.append(resolve(opf_path, item.attrib.get('href', '')))
            for meta in opf.findall('.//{*}meta'):
                if meta.attrib.get('name', '').lower() == 'cover':
                    item = items.get(meta.attrib.get('content'))
                    if item is not None: candidates.append(resolve(opf_path, item.attrib.get('href', '')))
            for ref in opf.findall('.//{*}guide/{*}reference'):
                if 'cover' in ref.attrib.get('type', '').split():
                    candidates.append(resolve(opf_path, ref.attrib.get('href', '')))
            for candidate in candidates:
                try:
                    data = read(candidate)
                    mime = image_type(data)
                    if mime: return data, mime
                    parser = CoverImages()
                    parser.feed(data.decode('utf-8'))
                    for href in parser.refs:
                        image = read(resolve(candidate, href))
                        mime = image_type(image)
                        if mime: return image, mime
                except (KeyError, ValueError, UnicodeError):
                    continue
    except (OSError, KeyError, ValueError, zipfile.BadZipFile, ET.ParseError):
        return None
    return None
