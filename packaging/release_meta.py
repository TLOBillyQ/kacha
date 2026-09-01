"""发布元数据：版本号唯一来源（ADR 0007）。

构建与发布脚本共用；版本号只从仓库根目录 pyproject.toml 的 project.version
读取，发版前手动 bump，构建与发布都拒绝与产物名不一致的版本。纯标准库。
"""

from __future__ import annotations

import os
import tomllib
from pathlib import Path


def pyproject_version(repo_root: Path) -> str:
    """读取 pyproject.toml 的 project.version。"""
    with (repo_root / "pyproject.toml").open("rb") as stream:
        return tomllib.load(stream)["project"]["version"]


def require_injected_version() -> str:
    """发布构建必须由环境变量注入版本号；未注入时直接让构建失败。

    杜绝 PyInstaller 规格里静默回退到 0.1.0，防止界面显示假版本。
    """
    version = os.environ.get("UGC_IMAGE_TOOL_VERSION")
    if not version:
        raise SystemExit("UGC_IMAGE_TOOL_VERSION environment variable is required")
    return version
