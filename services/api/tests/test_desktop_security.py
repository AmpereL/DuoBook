"""Exercise desktop middleware in a fresh process, without modifying the test API app."""
import os
from pathlib import Path
import subprocess
import sys


def test_desktop_media_policy_allows_local_audio_without_relaxing_auth(tmp_path):
    service = Path(__file__).resolve().parents[1]
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<html><body>reader</body></html>")
    script = """
from fastapi.testclient import TestClient
from desktop_server import app
with TestClient(app) as client:
    assert client.get('/').status_code == 401
    response = client.get('/', headers={'x-duobook-token': 'desktop-test-token'})
    assert response.status_code == 200
    policy = dict(part.strip().split(' ', 1) for part in response.headers['content-security-policy'].split(';') if part.strip())
    assert set(policy['media-src'].split()) == {"'self'", 'blob:'}
    assert policy['default-src'] == "'self'"
    assert policy['script-src'] == "'self'"
    assert policy['connect-src'] == "'self'"
    assert policy['object-src'] == "'none'"
    assert policy['frame-src'] == "'none'"
    assert client.get('/api/v1/health').status_code == 401
    assert client.get('/api/v1/health', headers={'x-duobook-token': 'desktop-test-token'}).status_code == 200
"""
    result = subprocess.run([sys.executable, "-c", script], env={
        **os.environ, "PYTHONPATH": str(service),
        "DUOBOOK_WEB_DIR": str(web), "DUOBOOK_DESKTOP_TOKEN": "desktop-test-token",
        "DUOBOOK_DB": str(tmp_path / "desktop.db"), "DUOBOOK_UPLOAD_DIR": str(tmp_path / "uploads"),
    }, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
