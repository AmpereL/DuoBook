from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app import main
    from app.db import Database, db
    from app.providers import ModelConfiguration
    from app.seed import seed_demo

    database_path = tmp_path / "duobook-test.db"
    upload_dir = tmp_path / "uploads"
    db.reconfigure(database_path)
    db.initialize()
    seed_demo(db)
    monkeypatch.setattr(main, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(main, "MODEL_CONFIGURATION", ModelConfiguration())
    monkeypatch.setattr(main, "SPEECH_CONFIGURATION", None)
    monkeypatch.setattr(main, "SPEECH_DEFAULTS_PATH", tmp_path / "speech-defaults.json")

    with TestClient(main.app) as test_client:
        yield test_client

    db.reconfigure(Database().path)
