"""Build the macOS application icon from the default second icon candidate."""

from pathlib import Path
import shutil
import subprocess


source = Path("apps/web/public/icons/app-icon-2.png")
folder = Path("build/逻辑阅读.iconset")
output = Path("build/逻辑阅读.icns")
if not source.is_file():
    raise SystemExit(f"Missing default app icon: {source}")
if folder.exists():
    shutil.rmtree(folder)
folder.mkdir(parents=True)

for base in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        size = base * scale
        suffix = "@2x" if scale == 2 else ""
        destination = folder / f"icon_{base}x{base}{suffix}.png"
        subprocess.run(
            ["sips", "-z", str(size), str(size), str(source), "--out", str(destination)],
            check=True,
            stdout=subprocess.DEVNULL,
        )

subprocess.run(["iconutil", "-c", "icns", str(folder), "-o", str(output)], check=True)
