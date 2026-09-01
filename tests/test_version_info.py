"""版本信息角标组装单元测试。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from ugc_image_tool import version_info


class TestBuildLabelFormat:
    """纯格式化函数覆盖所有分支。"""

    def test_packaged_release_label(self):
        assert version_info._build_label("0.1.0", "a1b2c3d", dirty=False, dev=False) == "v0.1.0 (a1b2c3d)"

    def test_dev_with_clean_git(self):
        assert version_info._build_label("0.1.0", "a1b2c3d", dirty=False, dev=True) == "v0.1.0-dev (a1b2c3d)"

    def test_dev_with_dirty_git(self):
        assert version_info._build_label("0.1.0", "a1b2c3d", dirty=True, dev=True) == "v0.1.0-dev (a1b2c3d, dirty)"

    def test_dev_without_git(self):
        assert version_info._build_label("0.1.0", None, dirty=False, dev=True) == "v0.1.0-dev"

    def test_packaged_commit_truncated_to_seven(self):
        assert version_info._short_hash("a1b2c3d4e5f6789") == "a1b2c3d"


class TestReadPackagedCommit:
    """打包产物内 build-info.json 读取。"""

    def test_non_frozen_returns_none(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(version_info.sys, "frozen", False, raising=False)
        assert version_info._read_packaged_commit() is None

    def test_frozen_without_file_returns_none(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        monkeypatch.setattr(version_info.sys, "frozen", True, raising=False)
        monkeypatch.setattr(version_info.sys, "_MEIPASS", str(tmp_path), raising=False)
        assert version_info._read_packaged_commit() is None

    def test_frozen_with_valid_build_info_returns_short_hash(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        build_info_dir = tmp_path / "release"
        build_info_dir.mkdir()
        build_info_path = build_info_dir / "build-info.json"
        build_info_path.write_text(
            json.dumps({"commit": "587c76d7ded2eb1a2234a2b70fcf7ad605f500bd"}),
            encoding="utf-8",
        )
        monkeypatch.setattr(version_info.sys, "frozen", True, raising=False)
        monkeypatch.setattr(version_info.sys, "_MEIPASS", str(tmp_path), raising=False)
        assert version_info._read_packaged_commit() == "587c76d"

    def test_frozen_with_bad_json_returns_none(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        build_info_dir = tmp_path / "release"
        build_info_dir.mkdir()
        (build_info_dir / "build-info.json").write_text("not json", encoding="utf-8")
        monkeypatch.setattr(version_info.sys, "frozen", True, raising=False)
        monkeypatch.setattr(version_info.sys, "_MEIPASS", str(tmp_path), raising=False)
        assert version_info._read_packaged_commit() is None


class TestGitCommit:
    """开发环境下 git 读取与 dirty 检测。"""

    def test_git_available_clean_repo(self, monkeypatch: pytest.MonkeyPatch):
        def fake_run(command, **kwargs):
            if "rev-parse" in command:
                return subprocess.CompletedProcess(command, 0, stdout="a1b2c3d\n", stderr="")
            if "status" in command:
                return subprocess.CompletedProcess(command, 0, stdout="\n", stderr="")
            raise AssertionError(f"unexpected command: {command}")

        monkeypatch.setattr(version_info.subprocess, "run", fake_run)
        commit, dirty = version_info._git_commit()
        assert commit == "a1b2c3d"
        assert dirty is False

    def test_git_available_dirty_repo(self, monkeypatch: pytest.MonkeyPatch):
        def fake_run(command, **kwargs):
            if "rev-parse" in command:
                return subprocess.CompletedProcess(command, 0, stdout="a1b2c3d\n", stderr="")
            if "status" in command:
                return subprocess.CompletedProcess(command, 0, stdout=" M src/foo.py\n", stderr="")
            raise AssertionError(f"unexpected command: {command}")

        monkeypatch.setattr(version_info.subprocess, "run", fake_run)
        commit, dirty = version_info._git_commit()
        assert commit == "a1b2c3d"
        assert dirty is True

    def test_git_unavailable_returns_none(self, monkeypatch: pytest.MonkeyPatch):
        def fake_run(command, **kwargs):
            raise OSError("git not found")

        monkeypatch.setattr(version_info.subprocess, "run", fake_run)
        commit, dirty = version_info._git_commit()
        assert commit is None
        assert dirty is False


class TestBuildLabelIntegration:
    """build_label() 在打包/开发两条路径上的集成行为。"""

    def test_packaged_build_uses_build_info_and_no_dev_suffix(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        build_info_dir = tmp_path / "release"
        build_info_dir.mkdir()
        (build_info_dir / "build-info.json").write_text(
            json.dumps({"commit": "587c76d7ded2eb1a2234a2b70fcf7ad605f500bd"}),
            encoding="utf-8",
        )
        monkeypatch.setattr(version_info.sys, "frozen", True, raising=False)
        monkeypatch.setattr(version_info.sys, "_MEIPASS", str(tmp_path), raising=False)
        monkeypatch.setattr(version_info, "app_version", lambda: "0.1.0")

        assert version_info.build_label() == "v0.1.0 (587c76d)"

    def test_dev_build_uses_git(self, monkeypatch: pytest.MonkeyPatch):
        def fake_run(command, **kwargs):
            if "rev-parse" in command:
                return subprocess.CompletedProcess(command, 0, stdout="a1b2c3d\n", stderr="")
            if "status" in command:
                return subprocess.CompletedProcess(command, 0, stdout="\n", stderr="")
            raise AssertionError(f"unexpected command: {command}")

        monkeypatch.setattr(version_info, "app_version", lambda: "0.1.0")
        monkeypatch.setattr(version_info.sys, "frozen", False, raising=False)
        monkeypatch.setattr(version_info.subprocess, "run", fake_run)

        assert version_info.build_label() == "v0.1.0-dev (a1b2c3d)"

    def test_dev_build_without_git_falls_back_to_dev_only(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(version_info, "app_version", lambda: "0.1.0")
        monkeypatch.setattr(version_info.sys, "frozen", False, raising=False)
        monkeypatch.setattr(version_info.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("git")))

        assert version_info.build_label() == "v0.1.0-dev"
