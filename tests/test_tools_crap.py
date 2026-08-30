"""crap 子命令：圈复杂度 + 覆盖率归因 + CRAP 公式 + 报告与门禁。"""

from __future__ import annotations

import json
from types import SimpleNamespace

from tools.packages.crap import engine


def first_scope(source):
    return engine.scopes_from_source(source)[0]


def test_cc_flat_function_is_one():
    scope = first_scope("def f():\n    return 1\n")
    assert engine.cyclomatic_complexity(scope) == 1


def test_cc_counts_decision_points():
    source = (
        "def f(x):\n"
        "    if x > 1:\n"
        "        return 1\n"
        "    elif x > 2:\n"
        "        return 2\n"
        "    return 0\n"
    )
    assert engine.cyclomatic_complexity(first_scope(source)) == 3


def test_cc_counts_loops_and_boolean_ops():
    source = (
        "def f(items):\n"
        "    for item in items:\n"
        "        if item and item > 1:\n"
        "            return item\n"
        "    return 0\n"
    )
    # for(+1) if(+1) and(+1) >(+1 比较不计数) -> CC 3? 文档:if +1, and +1, for +1
    assert engine.cyclomatic_complexity(first_scope(source)) == 4


def test_cc_counts_ternary_and_comprehension():
    source = (
        "def f(items):\n"
        "    hits = [x for x in items if x]\n"
        "    return 1 if hits else 0\n"
    )
    # 推导式(+1) 三元(+1)
    assert engine.cyclomatic_complexity(first_scope(source)) == 3


def test_crap_formula_and_missing_coverage():
    assert engine.crap(cc=4, coverage=0.5) == 6.0
    assert engine.crap(cc=1, coverage=1.0) == 1.0
    assert engine.crap(cc=3, coverage=None) is None


def test_risk_bands():
    assert engine.risk_band(3) == "low"
    assert engine.risk_band(12) == "moderate"
    assert engine.risk_band(45) == "high"


def test_attribution_skips_nested_function_lines():
    source = (
        "def outer(x):\n"
        "    def inner(y):\n"
        "        return y + 1\n"
        "    return inner(x) + 1\n"
    )
    scope = first_scope(source)
    executable = engine.executable_lines(scope)
    assert engine.cyclomatic_complexity(scope) == 1
    # 内层函数体(第 3 行)不计入 outer 的可执行行
    assert 3 not in executable
    assert 4 in executable


def test_attribute_and_report_shape():
    source = "def f(x):\n    return x + 1\n"
    coverage = {"/proj/src/m.py": {"executed_lines": [1, 2]}}
    report = engine.build_report([("/proj/src/m.py", source)], coverage)
    assert report[0]["name"] == "f"
    assert report[0]["cc"] == 1
    assert report[0]["coverage"] == 1.0
    assert report[0]["crap"] == 1.0
    assert report[0]["band"] == "low"
    assert report[0]["file"] == "/proj/src/m.py"


def test_uncovered_function_has_crap_score():
    source = "def f(x):\n    if x:\n        return x\n    return 0\n"
    coverage = {"/proj/src/m.py": {"executed_lines": []}}
    report = engine.build_report([("/proj/src/m.py", source)], coverage)
    entry = report[0]
    assert entry["coverage"] == 0.0
    assert entry["crap"] == engine.crap(entry["cc"], 0.0)


def test_missing_artifact_is_null_and_sorts_last():
    source = "def f(x):\n    return x\n"
    report = engine.build_report([("/proj/src/m.py", source)], {})
    assert report[0]["coverage"] is None
    assert report[0]["crap"] is None
    entries = [{"crap": 5.0, "file": "b", "name": "f"},
               {"crap": None, "file": "a", "name": "g"}, {"crap": 2.0, "file": "c", "name": "h"}]
    assert engine.sort_report(entries)[0]["crap"] == 5.0
    assert engine.sort_report(entries)[-1]["crap"] is None


def test_cli_gate_and_top(capsys, tmp_path):
    from tools.packages.crap import cli

    calls = []

    def fake_run(argv, cwd=None, **kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0)

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "m.py").write_text("def f(x):\n    return x\n")
    (tmp_path / ".toolcache").mkdir()
    (tmp_path / ".toolcache" / "coverage.json").write_text(json.dumps(
        {"files": {"src/m.py": {"executed_lines": [1, 2]}}}))

    code = cli.main([], {"repo_root": str(tmp_path)}, run_shell=fake_run)
    assert code == 0
    assert "f" in capsys.readouterr().out
    assert any("coverage" in str(a) for a in calls)

    (tmp_path / ".toolcache" / "coverage.json").write_text(json.dumps(
        {"files": {"src/m.py": {"executed_lines": []}}}))
    (tmp_path / "src" / "m.py").write_text(
        "def f(x):\n    if x:\n        return x\n    return 0\n")
    code = cli.main(["--gate", "--gate-threshold", "3.0"],
                    {"repo_root": str(tmp_path)}, run_shell=fake_run)
    assert code == 2
    captured = capsys.readouterr()
    assert "gate" in captured.err.lower()
