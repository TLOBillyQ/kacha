"""测试共用：把 packaging/ 加入导入路径，并构造临时仓库与 release/ 目录。"""

from __future__ import annotations

import hashlib
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
        f'[package]\nname = "ugc-image-tool"\nversion = "{version}"\nedition = "2021"\n',
        encoding="utf-8",
    )
    conf: dict[str, object] = {"productName": "UGC AI 生图工具"}
    if conf_version is not None:
        conf["version"] = conf_version
    (tauri_dir / "tauri.conf.json").write_text(json.dumps(conf, ensure_ascii=False), encoding="utf-8")
    if notes:
        notes_dir = root / "docs" / "release"
        notes_dir.mkdir(parents=True, exist_ok=True)
        (notes_dir / f"release-notes-{version}.md").write_text(
            f"# UGC AI 生图工具 {version}\n\n首次运行：更多信息 → 仍要运行；macOS 右键「打开」。\n",
            encoding="utf-8",
        )
    return root


def make_release_dir(root: Path, version: str, *platforms: str) -> Path:
    """模拟一台构建机的 release/：平台 zip + 本机 SHA256SUMS。"""
    release_dir = root / "release"
    release_dir.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for platform in platforms:
        name = f"ugc-image-tool-{version}-{platform}.zip"
        data = f"fake zip {platform}".encode("utf-8")
        (release_dir / name).write_bytes(data)
        lines.append(f"{hashlib.sha256(data).hexdigest()}  {name}")
    (release_dir / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return release_dir
