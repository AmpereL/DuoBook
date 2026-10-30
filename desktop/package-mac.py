"""Build audited public macOS artifacts; private packaging requires explicit opt-in."""
from pathlib import Path
import hashlib
import json
import plistlib
import subprocess
import tempfile

from distribution import distribution_mode, audit_public_tree, local_secrets

root = Path(__file__).resolve().parents[1]
mode = distribution_mode()
release = root / 'release' / mode
version = json.loads((root / 'package.json').read_text())['version']
staging = root / 'build/desktop' / mode
manifest = json.loads((staging / 'distribution.json').read_text())
if manifest != {'mode': mode, 'version': version}:
    raise SystemExit('Backend mode/version mismatch. Rebuild before packaging.')
secrets = local_secrets(root) if mode == 'public' else []
if mode == 'public':
    audit_public_tree(staging, secrets)

name = f'LogicReading-{version}-macOS-arm64' + ('-private' if mode == 'private' else '')
app = release / 'mac-arm64/逻辑阅读.app'
instructions = (root / 'desktop' / ('公开分发说明.md' if mode == 'public' else '分发说明.md')).read_text().replace('{{VERSION}}', version)
subprocess.run(['npx', 'electron-builder', '--config', 'desktop/electron-builder.cjs', '--mac', '--arm64', '--dir'], cwd=root, check=True)
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
if info['CFBundleShortVersionString'] != version or info['CFBundleIdentifier'] != 'com.duobook.reader':
    raise SystemExit('Packaged app identity/version mismatch')
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
audit = audit_public_tree(app, secrets) if mode == 'public' else None

with tempfile.TemporaryDirectory(prefix=f'duobook-{mode}-dmg-') as temporary:
    stage = Path(temporary)
    subprocess.run(['ditto', str(app), str(stage / '逻辑阅读.app')], check=True)
    (stage / 'Applications').symlink_to('/Applications')
    (stage / '安装说明.md').write_text(instructions)
    subprocess.run(['hdiutil', 'create', '-volname', '逻辑阅读', '-srcfolder', str(stage), '-ov', '-format', 'UDZO', str(release / f'{name}.dmg')], check=True)
archive = release / f'{name}.zip'
archive.unlink(missing_ok=True)
subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive)], check=True)
(release / 'INSTALL.md').write_text(instructions)
artifacts = [release / f'{name}.dmg', archive, release / 'INSTALL.md']
if audit is not None:
    (release / 'public-audit.json').write_text(json.dumps({'version': version, 'app_id': info['CFBundleIdentifier'], **audit}, indent=2) + '\n')
    artifacts.append(release / 'public-audit.json')
checksums = []
for artifact in artifacts:
    with artifact.open('rb') as file:
        digest = hashlib.file_digest(file, 'sha256').hexdigest()
    checksums.append(f'{digest}  {artifact.name}')
(release / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n')
print(f'{mode.capitalize()} DMG and ZIP ready in release/{mode}/; public artifacts passed credential/data audit.' if audit is not None else 'Private artifacts ready; do not publish these files.')
