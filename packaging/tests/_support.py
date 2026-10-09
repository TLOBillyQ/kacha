"""测试共用：把 packaging/ 加入导入路径，并构造临时仓库与 release/ 目录。"""

from __future__ import annotations

import hashlib
import base64
import json
import sys
from pathlib import Path

PACKAGING_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = PACKAGING_DIR.parent
if str(PACKAGING_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGING_DIR))


def make_repo(root: Path, version: str = "1.2.3", conf_version: str | None = None, notes: bool = True) -> Path:
    """临时仓库：Cargo.toml、tauri.conf.json（可选 version）、发布说明。"""
    tauri_dir = root / "client" / "src-tauri"
    tauri_dir.mkdir(parents=True, exist_ok=True)
    (tauri_dir / "Cargo.toml").write_text(
        f'[package]\nname = "kacha"\nversion = "{version}"\nedition = "2021"\n',
        encoding="utf-8",
    )
    conf: dict[str, object] = {"productName": "Kacha"}
    if conf_version is not None:
        conf["version"] = conf_version
    (tauri_dir / "tauri.conf.json").write_text(json.dumps(conf, ensure_ascii=False), encoding="utf-8")
    if notes:
        notes_dir = root / "docs" / "release"
        notes_dir.mkdir(parents=True, exist_ok=True)
        (notes_dir / f"release-notes-{version}.md").write_text(
            f"# Kacha {version}\n\n首次运行：更多信息 → 仍要运行；macOS 右键「打开」。\n",
            encoding="utf-8",
        )
    return root


def make_release_dir(root: Path, version: str, *platforms: str) -> Path:
    """Signed release fixture; names/schema are independent literals from the spec."""
    release_dir = root / "release"
    release_dir.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for platform in platforms:
        name = (f"kacha-{version}-win-x64-setup.exe" if platform == "win-x64"
                else f"kacha-{version}-macos-arm64.app.tar.gz")
        signature = base64.b64encode((
            "untrusted comment: signature from tauri secret key\n"
            + base64.b64encode(b"ED" + b"k" * 8 + b"s" * 64).decode() + "\n"
            + "trusted comment: timestamp:1791504000\n"
            + base64.b64encode(b"g" * 64).decode() + "\n"
        ).encode()).decode()
        files = {name: f"fake updater {platform}".encode(), name + ".sig": signature.encode()}
        if platform == "macos-arm64":
            files[f"kacha-{version}-{platform}.zip"] = f"fake zip {platform}".encode()
        descriptor = {
            "version": version,
            "notes": f"# Kacha {version}\n\n首次运行：更多信息 → 仍要运行；macOS 右键「打开」。",
            "pub_date": "2026-10-09T00:00:00Z",
            "platforms": {("windows-x86_64" if platform == "win-x64" else "darwin-aarch64"): {
                "url": f"http://lzxsvn:3000/qinyuanj/kacha/releases/download/v{version}/{name}",
                "signature": signature,
            }},
        }
        files[f"updater-{platform}.json"] = json.dumps(descriptor, ensure_ascii=False).encode()
        for filename, data in files.items():
            (release_dir / filename).write_bytes(data)
            lines.append(f"{hashlib.sha256(data).hexdigest()}  {filename}")
    (release_dir / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return release_dir
