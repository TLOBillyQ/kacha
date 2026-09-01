"""版本信息：为界面状态栏组装版本角标字符串。

打包构建通过 PyInstaller 把 release/build-info.json 作为数据文件进包，运行时
从 sys._MEIPASS 读取 commit hash；开发构建未冻结时回退到 git，并附加 -dev
与 dirty 标记。版本号本身仍由 diagnostics.app_version() 提供（pyproject.toml）。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from .diagnostics import app_version


def _short_hash(commit: str) -> str:
    return commit[:7]


def _read_packaged_commit() -> str | None:
    """在 PyInstaller 打包产物内读取 build-info.json 的 commit 短 hash。"""
    if not getattr(sys, "frozen", False):
        return None
    meipass = Path(getattr(sys, "_MEIPASS", ""))
    path = meipass / "release" / "build-info.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    commit = data.get("commit")
    return _short_hash(commit) if commit else None


def _git_commit() -> tuple[str | None, bool]:
    """开发环境下从仓库根读取 git commit 短 hash 与 dirty 状态。

    git 不可用时返回 (None, False)，保证界面仍可显示带 -dev 的版本号。
    """
    repo = Path(__file__).resolve().parent.parent.parent
    try:
        rev_parse = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            cwd=repo,
            check=True,
            timeout=5,
        )
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True,
            text=True,
            cwd=repo,
            check=True,
            timeout=5,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None, False
    return rev_parse.stdout.strip(), bool(status.stdout.strip())


def _build_label(version: str, commit: str | None, dirty: bool, dev: bool) -> str:
    """纯函数：按基线规则组装状态栏角标文本。"""
    label = f"v{version}"
    if dev:
        label += "-dev"
    parts: list[str] = []
    if commit:
        parts.append(commit)
    if dirty:
        parts.append("dirty")
    if parts:
        label += f" ({', '.join(parts)})"
    return label


def build_label() -> str:
    """应用当前运行形态下的完整版本角标文本。"""
    version = app_version()
    packaged_commit = _read_packaged_commit()
    if packaged_commit is not None:
        return _build_label(version, packaged_commit, dirty=False, dev=False)
    commit, dirty = _git_commit()
    return _build_label(version, commit, dirty=dirty, dev=True)
