"""covdata 适配层:coverage.py 三步流水线、产物归一化与按文件取行。"""

from __future__ import annotations

import json
import os
from types import SimpleNamespace

from tools.packages import covdata


def fake_shell(codes):
    """按步骤顺序返回给定退出码(最后一条复用)。"""
    calls = []

    def run_shell(argv, cwd=None, **kwargs):
        calls.append((list(argv), cwd, kwargs))
        return SimpleNamespace(returncode=codes[min(len(codes) - 1, len(calls) - 1)])

    return run_shell, calls


def test_artifact_path_and_pipeline():
    assert covdata.artifact_path("/r") == os.path.join("/r", ".toolcache",
                                                       "coverage.json")
    commands = covdata.pipeline("/p", covdata.DEFAULT_SOURCE, "/r/art.json")
    assert commands[0][-1] == "erase"
    assert "--source=src" in commands[1]
    assert commands[1][-2:] == ["-m", "pytest"]
    assert commands[2][-2:] == ["-o", "/r/art.json"]


def test_collect_reports_clean_run():
    run_shell, calls = fake_shell([0])
    result = covdata.collect("/p", "/r", "src", run_shell=run_shell)
    assert result == covdata.Collection(artifact_ok=True, tests_failed=False)
    assert [call[1] for call in calls] == ["/r", "/r", "/r"]


def test_collect_keeps_going_when_tests_fail():
    run_shell, calls = fake_shell([0, 1, 0])
    result = covdata.collect("/p", "/r", "src", run_shell=run_shell)
    assert result.artifact_ok and result.tests_failed
    assert len(calls) == 3  # 仍走到 coverage json 这一步


def test_collect_flags_failed_setup_or_missing_artifact_step():
    run_shell, calls = fake_shell([1])
    result = covdata.collect("/p", "/r", "src", run_shell=run_shell)
    assert not result.artifact_ok and result.returncode == 1 and len(calls) == 1

    run_shell, calls = fake_shell([0, 0, 2])
    result = covdata.collect("/p", "/r", "src", run_shell=run_shell)
    assert not result.artifact_ok and result.returncode == 2 and len(calls) == 3


def test_load_normalizes_relative_keys(tmp_path):
    write_artifact(tmp_path, {"src/m.py": {"executed_lines": [1, 2]}})
    files = covdata.load(str(tmp_path))
    assert covdata.covered_lines(files, str(tmp_path / "src" / "m.py")) == {1, 2}


def test_load_reads_absolute_keys(tmp_path):
    absolute = os.path.join(str(tmp_path), "src", "m.py")
    write_artifact(tmp_path, {absolute: {"executed_lines": []}})
    files = covdata.load(str(tmp_path))
    assert covdata.covered_lines(files, absolute) == set()


def test_covered_lines_matches_by_suffix_and_misses_unknown_files():
    files = {"/other/root/src/m.py": {"executed_lines": [3]}}
    assert covdata.covered_lines(files, "src/m.py") == {3}
    assert covdata.covered_lines(files, "/r/src/other.py") is None


def test_load_surfaces_missing_or_broken_artifact(tmp_path):
    import pytest

    with pytest.raises(OSError):
        covdata.load(str(tmp_path))
    write_raw_artifact(tmp_path, "{not json")
    with pytest.raises(ValueError):
        covdata.load(str(tmp_path))


def write_artifact(root, files):
    write_raw_artifact(root, json.dumps({"files": files}))


def write_raw_artifact(root, text):
    artifact = covdata.artifact_path(str(root))
    os.makedirs(os.path.dirname(artifact), exist_ok=True)
    with open(artifact, "w", encoding="utf-8") as handle:
        handle.write(text)
