"""共享小工具:解释器解析、路径/源文件走查与三个子命令共用的选项走查器。"""

from __future__ import annotations

import os
import sys

import pytest

from tools.packages import common


def test_repo_root_from_prefers_env_else_cwd(tmp_path):
    assert common.repo_root_from({"repo_root": str(tmp_path)}) == str(tmp_path)
    assert common.repo_root_from(None) == os.getcwd()
    assert common.repo_root_from({}) == os.getcwd()


def test_project_python_falls_back_to_current_interpreter(tmp_path, monkeypatch):
    monkeypatch.setattr(common.sys, "executable", "/fancy/python")
    assert common.project_python(str(tmp_path)) == "/fancy/python"


def test_project_python_uses_executable_venv(tmp_path):
    venv_python = tmp_path / ".venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("#!/bin/sh\n")
    venv_python.chmod(0o644)  # 存在但不可执行 -> 仍回退
    assert common.project_python(str(tmp_path)) == sys.executable
    venv_python.chmod(0o755)
    assert common.project_python(str(tmp_path)) == str(venv_python)


def test_wants_help_scans_every_position():
    assert common.wants_help(["--help"])
    assert common.wants_help(["a", "-h", "b"])
    assert not common.wants_help(["a", "--help-me"])


def test_relative_path_keeps_original_when_escaping_root(tmp_path):
    assert common.relative_path(str(tmp_path / "src/a.py"), str(tmp_path)) == "src/a.py"
    assert common.relative_path("/elsewhere/a.py", str(tmp_path / "deep")) == \
        "/elsewhere/a.py"


def test_python_files_walks_directories_and_keeps_plain_paths(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "b.py").write_text("x = 2\n")
    (tmp_path / "pkg" / "a.py").write_text("x = 1\n")
    (tmp_path / "pkg" / "notes.txt").write_text("ignore me\n")
    walked = common.python_files([str(tmp_path / "pkg")])
    assert [item.split("/")[-1] for item in walked] == ["a.py", "b.py"]
    assert common.python_files([str(tmp_path / "nope.py")]) == [str(tmp_path / "nope.py")]


def test_read_sources_skips_unreadable_files(tmp_path):
    good = tmp_path / "good.py"
    good.write_text("def f():\n    return 1\n")
    documents = common.read_sources([str(good), str(tmp_path / "missing.py")])
    assert documents == [(str(good), "def f():\n    return 1\n")]


def test_as_int_and_as_float_reject_bad_values_with_empty_message():
    assert common.as_int("4") == 4
    assert common.as_float("0.5") == 0.5
    with pytest.raises(ValueError) as bad_int:
        common.as_int("four")
    assert str(bad_int.value) == ""
    with pytest.raises(ValueError):
        common.as_float("")


def test_parse_tokens_sets_flags_and_converts_values():
    flags = (common.Flag("--gate", "gate"), common.Flag("--json", "as_json", "yes"))
    values = (common.Value("--top", "top", common.as_int),
              common.Value("--source", "source"))
    options, paths, error = common.parse_tokens(
        ["--gate", "--top", "3", "--source", "pkg", "--json"],
        flags=flags, values=values)
    assert error is None and paths == []
    assert options == {"gate": True, "top": 3, "source": "pkg", "as_json": "yes"}


def test_parse_tokens_reports_unknown_token_and_bad_number():
    values = (common.Value("--top", "top", common.as_int),)
    _options, _paths, error = common.parse_tokens(["--bogus"], flags=(),
                                                  values=values)
    assert error == "未知参数: --bogus"
    _options, _paths, error = common.parse_tokens(["--top", "x"], flags=(),
                                                  values=values)
    assert error == "--top requires a numeric value"
    _options, _paths, error = common.parse_tokens(["--top"], flags=(), values=values)
    assert error == "--top requires a numeric value"


def test_parse_tokens_positional_policies():
    flags = (common.Flag("--scan", "scan"),)
    _options, paths, error = common.parse_tokens(
        ["a.py", "b.py"], flags=flags, values=(),
        positional=common.POSITIONAL_ANY)
    assert (paths, error) == (["a.py", "b.py"], None)

    _options, paths, error = common.parse_tokens(
        ["a.py"], flags=flags, values=(), positional=common.POSITIONAL_SINGLE)
    assert (paths, error) == (["a.py"], None)

    _options, _paths, error = common.parse_tokens(
        ["a.py", "b.py"], flags=flags, values=(),
        positional=common.POSITIONAL_SINGLE)
    assert error == "未知参数: b.py"

    _options, _paths, error = common.parse_tokens(
        ["--scan", "a.py"], flags=flags, values=(),
        positional=common.POSITIONAL_NONE)
    assert error == "未知参数: a.py"


def test_parse_tokens_custom_converter_message_surfaces():
    def lines(text: str) -> set[int]:
        raise ValueError("needs line numbers")

    _options, _paths, error = common.parse_tokens(
        ["--lines", ""], flags=(), values=(common.Value("--lines", "line_set", lines),))
    assert error == "needs line numbers"
