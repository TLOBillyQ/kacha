"""发布元数据 helper 测试。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

PACKAGING_DIR = Path(__file__).resolve().parents[1] / "packaging"
sys.path.insert(0, str(PACKAGING_DIR))

from release_meta import pyproject_version, require_injected_version  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_pyproject_version_reads_project_version():
    assert pyproject_version(REPO_ROOT) == "0.1.0"


def test_require_injected_version_returns_env_variable(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("UGC_IMAGE_TOOL_VERSION", "1.2.3")
    assert require_injected_version() == "1.2.3"


def test_require_injected_version_fails_when_env_missing(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("UGC_IMAGE_TOOL_VERSION", raising=False)
    with pytest.raises(SystemExit):
        require_injected_version()
