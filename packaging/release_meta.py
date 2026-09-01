"""发布元数据：版本号唯一来源（ADR 0007）。

构建与发布脚本共用；版本号只从仓库根目录 pyproject.toml 的 project.version
读取，发版前手动 bump，构建与发布都拒绝与产物名不一致的版本。纯标准库。
"""

from __future__ import annotations

import tomllib
from pathlib import Path


def pyproject_version(repo_root: Path) -> str:
    """读取 pyproject.toml 的 project.version。"""
    with (repo_root / "pyproject.toml").open("rb") as stream:
        return tomllib.load(stream)["project"]["version"]
