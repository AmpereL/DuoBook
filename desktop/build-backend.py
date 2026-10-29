"""Build only code/dependencies. Private defaults are included on explicit request."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
os.chdir(root)
subprocess.run([
    sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
    '--name', 'duobook-api', '--onedir', '--paths', 'services/api',
    '--distpath', 'build/frozen', '--workpath', 'build/pyinstaller',
    '--specpath', 'build', '--collect-all', 'uvicorn',
    '--exclude-module', 'pytest', 'services/api/desktop_server.py',
], check=True)
target = root / 'build/desktop'
target.mkdir(parents=True, exist_ok=True)
if (target / 'backend').exists():
    shutil.rmtree(target / 'backend')
shutil.copytree(root / 'build/frozen/duobook-api', target / 'backend', symlinks=True)
if os.environ.get('DUOBOOK_INCLUDE_PRIVATE_KEY') != '1':
    raise SystemExit('This private build requires DUOBOOK_INCLUDE_PRIVATE_KEY=1. No key copied.')
shutil.copyfile(root / 'services/api/data/model-defaults.json', target / 'private-defaults.json')
os.chmod(target / 'private-defaults.json', 0o600)
speech_defaults = root / 'services/api/data/speech-defaults.json'
if speech_defaults.exists():
    shutil.copyfile(speech_defaults, target / 'private-speech-defaults.json')
else:
    (target / 'private-speech-defaults.json').write_text('{}')
os.chmod(target / 'private-speech-defaults.json', 0o600)
print('Backend built. Explicitly authorized private defaults copied; no books/database included.')
