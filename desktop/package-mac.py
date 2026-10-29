"""Create native macOS artifacts without downloading a separate DMG toolchain."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
release = root / 'release'
display_name = '逻辑阅读'
version = json.loads((root / 'package.json').read_text())['version']
artifact_name = f'{display_name}-{version}-arm64-private'
app = release / f'mac-arm64/{display_name}.app'
instructions = (root / 'desktop/分发说明.md').read_text().replace('{{VERSION}}', version)
subprocess.run(['npx', 'electron-builder', '--config', 'desktop/electron-builder.yml', '--mac', '--arm64', '--dir'], cwd=root, check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
with tempfile.TemporaryDirectory(prefix='duobook-dmg-') as temporary:
    stage = Path(temporary)
    subprocess.run(['ditto', str(app), str(stage / f'{display_name}.app')], check=True)
    (stage / 'Applications').symlink_to('/Applications')
    (stage / '安装说明.md').write_text(instructions)
    subprocess.run(['hdiutil', 'create', '-volname', display_name, '-srcfolder', str(stage), '-ov', '-format', 'UDZO', str(release / f'{artifact_name}.dmg')], check=True)
archive = release / f'{artifact_name}.zip'
archive.unlink(missing_ok=True)
subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive)], check=True)
(release / '安装说明.md').write_text(instructions)
checksums = []
for artifact in (release / f'{artifact_name}.dmg', archive):
    with artifact.open('rb') as file:
        digest = hashlib.file_digest(file, 'sha256').hexdigest()
    checksums.append(f'{digest}  {artifact.name}')
(release / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n')
print('DMG and ZIP artifacts ready in release/.')
