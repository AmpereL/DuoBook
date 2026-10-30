"""Separate public/private packaging and audit public payloads before publication."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
from collections.abc import Mapping, Iterable

PRIVATE_FILES = {'private-defaults.json', 'private-speech-defaults.json',
                 'model-defaults.json', 'speech-defaults.json', 'model.enc', 'speech.enc'}
TOKEN_PATTERN = re.compile(rb'\b(?:sk-[A-Za-z0-9_-]{20,}|t?tp-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})')


def distribution_mode(environment: Mapping[str, str] | None = None) -> str:
    return 'private' if (os.environ if environment is None else environment).get('DUOBOOK_INCLUDE_PRIVATE_KEY') == '1' else 'public'


def prepare_stage(root: Path, mode: str) -> Path:
    if mode not in {'public', 'private'}:
        raise ValueError('Unknown distribution mode')
    stage = root / 'build' / 'desktop' / mode
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    return stage


def write_defaults(root: Path, stage: Path, mode: str, version: str) -> None:
    if mode == 'private':
        shutil.copyfile(root / 'services/api/data/model-defaults.json', stage / 'private-defaults.json')
        speech = root / 'services/api/data/speech-defaults.json'
        if speech.exists():
            shutil.copyfile(speech, stage / 'private-speech-defaults.json')
        else:
            (stage / 'private-speech-defaults.json').write_text('{}')
        for name in ('private-defaults.json', 'private-speech-defaults.json'):
            (stage / name).chmod(0o600)
    elif mode != 'public':
        raise ValueError('Unknown distribution mode')
    (stage / 'distribution.json').write_text(json.dumps({'mode': mode, 'version': version}, indent=2) + '\n')


def local_secrets(root: Path) -> list[bytes]:
    """Never print keys; compare known local credentials with the public payload."""
    secrets: list[bytes] = []
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if isinstance(item, str) and len(item) >= 12 and re.search('key|token|secret', key, re.I):
                    secrets.append(item.encode())
                else:
                    visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    for name in ('model-defaults.json', 'speech-defaults.json'):
        source = root / 'services/api/data' / name
        if source.exists():
            visit(json.loads(source.read_text()))
    return secrets


def audit_public_tree(tree: Path, secrets: Iterable[bytes] = ()) -> dict:
    tree = tree.resolve()
    if not tree.is_dir():
        raise ValueError('Public payload directory is missing')
    secrets = tuple(secrets)
    overlap_size = max(512, max((len(s) for s in secrets), default=0))
    count = 0
    for file in tree.rglob('*'):
        if file.is_symlink():
            if not file.resolve().is_relative_to(tree):
                raise ValueError(f'External payload symlink: {file.relative_to(tree)}')
            continue
        if not file.is_file():
            continue
        relative = file.relative_to(tree)
        if file.name in PRIVATE_FILES or file.name.endswith(('.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3')) or 'uploads' in relative.parts:
            raise ValueError(f'Private configuration or user data in public payload: {relative}')
        count += 1
        tail = b''
        with file.open('rb') as stream:
            while block := stream.read(1024 * 1024):
                buffer = tail + block
                if any(secret in buffer for secret in secrets) or TOKEN_PATTERN.search(buffer):
                    raise ValueError(f'Credential-like content in public payload: {relative}')
                tail = buffer[-overlap_size:]
    return {'mode': 'public', 'files_scanned': count, 'private_configuration_files': False,
            'known_private_keys': False, 'credential_patterns': False, 'user_database_or_uploads': False}
