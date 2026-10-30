import importlib.util
import json
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('duobook_distribution', ROOT / 'desktop/distribution.py')
distribution = importlib.util.module_from_spec(spec)
spec.loader.exec_module(distribution)


def test_public_is_default_and_staging_never_cleans_the_private_tree(tmp_path):
    assert distribution.distribution_mode({}) == 'public'
    assert distribution.distribution_mode({'DUOBOOK_INCLUDE_PRIVATE_KEY': '0'}) == 'public'
    assert distribution.distribution_mode({'DUOBOOK_INCLUDE_PRIVATE_KEY': '1'}) == 'private'
    private = distribution.prepare_stage(tmp_path, 'private')
    (private / 'keep').write_text('private build')
    public = distribution.prepare_stage(tmp_path, 'public')
    (public / 'private-defaults.json').write_text('stale data')
    assert not list(distribution.prepare_stage(tmp_path, 'public').iterdir())
    assert (private / 'keep').read_text() == 'private build'


def test_public_defaults_do_not_read_or_copy_private_configuration(tmp_path):
    source = tmp_path / 'services/api/data'
    source.mkdir(parents=True)
    (source / 'model-defaults.json').write_text('invalid JSON must not be loaded')
    stage = distribution.prepare_stage(tmp_path, 'public')
    distribution.write_defaults(tmp_path, stage, 'public', '1.2.10')
    assert [p.name for p in stage.iterdir()] == ['distribution.json']
    assert json.loads((stage / 'distribution.json').read_text()) == {'mode': 'public', 'version': '1.2.10'}


def test_private_defaults_require_explicit_mode_and_use_private_files(tmp_path):
    source = tmp_path / 'services/api/data'
    source.mkdir(parents=True)
    (source / 'model-defaults.json').write_text(json.dumps({'api_key': 'example-private-config'}))
    stage = distribution.prepare_stage(tmp_path, 'private')
    distribution.write_defaults(tmp_path, stage, 'private', '1.2.10')
    assert json.loads((stage / 'private-defaults.json').read_text())['api_key'] == 'example-private-config'
    assert (stage / 'private-defaults.json').stat().st_mode & 0o777 == 0o600
    assert (stage / 'private-speech-defaults.json').read_text() == '{}'


def test_public_audit_rejects_known_key_across_a_stream_boundary_without_printing_it(tmp_path):
    marker = b'credential-used-only-by-this-test'
    file = tmp_path / 'binary'
    file.write_bytes(b'\0' * (1024 * 1024 - 5) + marker + b'\0')
    with pytest.raises(ValueError) as error:
        distribution.audit_public_tree(tmp_path, [marker])
    assert marker.decode() not in str(error.value)
    file.write_bytes(b'clean application payload')
    assert distribution.audit_public_tree(tmp_path, [marker])['known_private_keys'] is False


def test_public_audit_rejects_configuration_database_external_links_and_token_patterns(tmp_path):
    for name in ['private-defaults.json', 'speech.enc', 'duobook.db']:
        file = tmp_path / name
        file.write_text('{}')
        with pytest.raises(ValueError):
            distribution.audit_public_tree(tmp_path)
        file.unlink()
    link = tmp_path / 'external'
    link.symlink_to(tmp_path.parent)
    with pytest.raises(ValueError):
        distribution.audit_public_tree(tmp_path)
    link.unlink()
    (tmp_path / 'unexpected.js').write_text('sk-' + 'a' * 32)
    with pytest.raises(ValueError):
        distribution.audit_public_tree(tmp_path)


def test_electron_configuration_keeps_public_private_resources_and_outputs_separate():
    for mode in ['public', 'private']:
        config = json.loads(subprocess.check_output(['node', '-e', "console.log(JSON.stringify(require('./desktop/electron-builder.cjs')))"], cwd=ROOT, env={**os.environ, 'DUOBOOK_INCLUDE_PRIVATE_KEY': '1' if mode == 'private' else '0'}))
        assert config['appId'] == 'com.duobook.reader'
        assert config['directories']['output'] == f'release/{mode}'
        files = [r['from'] for r in config['extraResources']]
        assert (any('private-defaults.json' in name for name in files)) == (mode == 'private')
        assert f'build/desktop/{mode}/backend' in files
    scripts = json.loads((ROOT / 'package.json').read_text())['scripts']
    assert scripts['package:mac'].startswith('DUOBOOK_INCLUDE_PRIVATE_KEY=0 ')
    assert scripts['package:mac:private'].startswith('DUOBOOK_INCLUDE_PRIVATE_KEY=1 ')
