"""tools/cli.py 顶层调度：封闭命令集、用法错误退出码 2、子命令路由与退出码透传。"""

from __future__ import annotations

import pytest

from tools.cli import COMMANDS, main as cli_main


class FakePackage:
    def __init__(self, code, usage_text="fake usage\n"):
        self.code = code
        self.usage_text = usage_text
        self.last_args = None
        self.last_env = None

    def main(self, args, env):
        self.last_args = args
        self.last_env = env
        return self.code

    def usage(self):
        return self.usage_text


def test_help_lists_all_commands(capsys):
    code = cli_main(["--help"], packages={})
    assert code == 0
    out = capsys.readouterr().out
    for name, summary in COMMANDS:
        assert name in out and summary in out


def test_no_args_prints_usage_and_exits_2(capsys):
    code = cli_main([], packages={})
    assert code == 2
    assert "用法" in capsys.readouterr().err


def test_unknown_command_exits_2(capsys):
    code = cli_main(["frobnicate"], packages={})
    assert code == 2
    assert "未知子命令" in capsys.readouterr().err


def test_subcommand_help_prints_package_usage(capsys):
    pkg = FakePackage(0, "dry usage\n")
    code = cli_main(["dry", "--help"], packages={"dry": pkg})
    assert code == 0
    assert pkg.last_args is None  # help handled by the dispatcher
    assert "dry usage" in capsys.readouterr().out


def test_routes_args_and_passes_env(capsys):
    pkg = FakePackage(3)
    code = cli_main(["mutate", "src/a.py", "--scan"], env={"repo_root": "/r"},
                    packages={"mutate": pkg})
    assert code == 3
    assert pkg.last_args == ["src/a.py", "--scan"]
    assert pkg.last_env["repo_root"] == "/r"


def test_missing_subcommand_package_exits_2(capsys):
    code = cli_main(["dry"], packages={})
    assert code == 2
    assert "加载失败" in capsys.readouterr().err


def test_real_packages_load_and_report_help(capsys):
    """封闭命令集里每条都要能真实 import 并交出子命令帮助。"""
    for name, _summary in COMMANDS:
        assert cli_main([name, "--help"]) == 0
        assert "用法" in capsys.readouterr().out


def test_real_subcommand_runs_through_dispatcher(tmp_path, capsys):
    (tmp_path / "a.py").write_text("def f(x):\n    return x\n")
    code = cli_main(["dry", str(tmp_path / "a.py")],
                    env={"repo_root": str(tmp_path)})
    assert code == 0
    assert "No duplicate candidates found." in capsys.readouterr().out


def test_bad_package_shape_is_a_load_failure(monkeypatch, capsys):
    class Broken:
        def usage(self):
            return "no main here\n"

    monkeypatch.setattr("tools.cli.importlib.import_module",
                        lambda name: Broken())
    assert cli_main(["dry"]) == 2
    err = capsys.readouterr().err
    assert "子命令加载失败" in err and "bad package shape" in err


def test_import_failure_is_a_load_failure(monkeypatch, capsys):
    def explode(name):
        raise ImportError("boom")

    monkeypatch.setattr("tools.cli.importlib.import_module", explode)
    assert cli_main(["crap"]) == 2
    assert "boom" in capsys.readouterr().err
