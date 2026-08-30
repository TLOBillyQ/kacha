"""mutate CLI：scan / update-manifest / 退出码 2(baseline)/ 3(存活)/ 干净运行写 manifest。"""

from __future__ import annotations

import json
import os
from types import SimpleNamespace

from tools.packages.mutate import cli, manifest

TARGET = "src/m.py"


def make_project(tmp_path, source):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "m.py").write_text(source)
    (tmp_path / "pyproject.toml").write_text("[project]\nname='p'\n")
    return str(tmp_path)


def fake_shell(plan):
    """按调用顺序返回 plan 中的退出码,最后一个重复使用。"""
    calls = []

    def run_shell(argv, cwd=None, **kwargs):
        calls.append((list(argv), cwd, kwargs))
        code = plan[min(len(plan) - 1, len(calls) - 1)]
        return SimpleNamespace(returncode=code)

    return run_shell, calls


def write_coverage(tmp_path, lines, rel="src/m.py"):
    artifact = tmp_path / ".toolcache" / "coverage.json"
    artifact.parent.mkdir(exist_ok=True)
    artifact.write_text(json.dumps(
        {"files": {rel: {"executed_lines": lines}}}))


def test_scan_lists_sites(tmp_path, capsys):
    root = make_project(tmp_path, "def f(x):\n    if x > 0:\n        return x + 1\n")
    code = cli.main(["src/m.py", "--scan"], {"repo_root": root})
    out = capsys.readouterr().out
    assert code == 0
    assert "file: src/m.py" in out
    assert "sites: " in out
    assert "L2 " in out and "(scope: m.f)" in out


def test_update_manifest_writes_footer(tmp_path, capsys):
    source = "def f(x):\n    return x + 1\n"
    root = make_project(tmp_path, source)
    code = cli.main(["src/m.py", "--update-manifest"], {"repo_root": root})
    assert code == 0
    assert "manifest updated: src/m.py" in capsys.readouterr().out
    assert manifest.read(os.path.join(root, "src/m.py")) is not None


def test_conflict_and_missing_target(tmp_path, capsys):
    root = make_project(tmp_path, "def f():\n    return 1\n")
    code = cli.main(["src/m.py", "--scan", "--mutate-all"], {"repo_root": root})
    err = capsys.readouterr().err
    assert code == 1 and "cannot be combined" in err
    assert cli.main(["--scan"], {"repo_root": root}) == 1
    assert "target file required" in capsys.readouterr().err


def test_baseline_failure_exits_2(tmp_path, capsys):
    root = make_project(tmp_path,
                        "def f(x):\n    result = x + 1\n    return result\n")
    write_coverage(tmp_path, [1, 2, 3])
    plan = [0, 0, 0, 7]
    run_shell, _ = fake_shell(plan)
    assert cli.main(["src/m.py"], {"repo_root": root}, run_shell=run_shell) == 2
    assert "baseline test failed" in capsys.readouterr().err


def test_survivors_exit_3_and_no_manifest(tmp_path, capsys):
    source = "def f(x):\n    result = x + 1\n    return result\n"
    root = make_project(tmp_path, source)
    write_coverage(tmp_path, [1, 2, 3])
    run_shell, _ = fake_shell([0, 0, 0, 0, 0])
    code = cli.main(["src/m.py"], {"repo_root": root}, run_shell=run_shell)
    out = capsys.readouterr().out
    assert code == 3
    assert "score: 0.0% (0/" in out
    assert "manifest updated" not in out
    assert manifest.read(os.path.join(root, "src/m.py")) is None


def test_clean_run_writes_manifest(tmp_path, capsys):
    source = "def f(x):\n    result = x + 1\n    return result\n"
    root = make_project(tmp_path, source)
    write_coverage(tmp_path, [1, 2, 3])
    run_shell, _ = fake_shell([0, 0, 0, 0, 1])
    code = cli.main(["src/m.py"], {"repo_root": root}, run_shell=run_shell)
    out = capsys.readouterr().out
    assert code == 0
    assert "score: 100.0%" in out
    assert "manifest updated: src/m.py" in out
    assert manifest.read(os.path.join(root, "src/m.py")) is not None
    # workspace 副本已清理
    assert not os.path.isdir(os.path.join(root, ".toolcache", "mutate4py"))


def test_scan_shows_changed_scope_prefix(tmp_path, capsys):
    source = "def f(x):\n    return x + 1\n"
    root = make_project(tmp_path, source)
    target = os.path.join(root, "src/m.py")
    manifest.write(target, source, {"version": 4, "project_hash": "old", "scopes": [
        {"id": "m.f", "kind": "function", "start_line": 1, "end_line": 2,
         "semantic_hash": "stale"}]})
    cli.main(["src/m.py", "--scan"], {"repo_root": root})
    out = capsys.readouterr().out
    assert "* L2 " in out  # scope 语义哈希失配 -> 标星
