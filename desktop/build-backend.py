"""Build only code/dependencies. Private defaults are included on explicit request."""
from pathlib import Path
import shutil
import subprocess
import sys
import json
from distribution import distribution_mode, prepare_stage, write_defaults

root = Path(__file__).resolve().parents[1]
mode = distribution_mode()
target = prepare_stage(root, mode)
version = json.loads((root / "package.json").read_text())["version"]
subprocess.run([
    sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
    '--name', 'duobook-api', '--onedir', '--paths', 'services/api',
    '--distpath', f'build/frozen-{mode}', '--workpath', f'build/pyinstaller-{mode}',
    '--specpath', 'build', '--collect-all', 'uvicorn',
    '--exclude-module', 'pytest', 'services/api/desktop_server.py',
], cwd=root, check=True)
shutil.copytree(root / f'build/frozen-{mode}/duobook-api', target / 'backend', symlinks=True)
write_defaults(root, target, mode, version)
print(f'Backend built for {mode} distribution. Public and private staging are isolated.')
