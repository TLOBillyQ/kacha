"""crap 子命令：圈复杂度 + 覆盖率归因 + CRAP 公式 + 报告与门禁。"""

from __future__ import annotations

import json
import os
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


def test_attribution_counts_only_measured_statement_lines():
    """多行语句的续行与 pragma 排除行都不是语句,不参与分母。"""
    source = (
        "def f(x):\n"          # 1
        "    value = call(\n"  # 2  多行语句:只有首行是语句
        "        a,\n"         # 3
        "        b,\n"         # 4
        "    )\n"              # 5
        "    if value:\n"      # 6
        "        return 1  # pragma: no cover\n"  # 7 被 coverage 排除
        "    return 2\n"       # 8
    )
    coverage = {"/proj/src/m.py": {"executed_lines": [2, 6, 8],
                                   "missing_lines": [],
                                   "excluded_lines": [7]}}
    entry = engine.build_report([("/proj/src/m.py", source)], coverage)[0]
    assert entry["coverage"] == 1.0
    assert entry["crap"] == float(entry["cc"])

    partial = {"/proj/src/m.py": {"executed_lines": [2, 8],
                                  "missing_lines": [6],
                                  "excluded_lines": [7]}}
    entry = engine.build_report([("/proj/src/m.py", source)], partial)[0]
    assert entry["coverage"] == round(2 / 3, 4)
    assert entry["cc"] == 2


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
    # coverage.py 的产物同时给出 executed 与 missing:未执行 = 全在 missing 里
    coverage = {"/proj/src/m.py": {"executed_lines": [], "missing_lines": [2, 3, 4]}}
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
        {"files": {"src/m.py": {"executed_lines": [],
                                "missing_lines": [2, 3, 4]}}}))
    (tmp_path / "src" / "m.py").write_text(
        "def f(x):\n    if x:\n        return x\n    return 0\n")
    code = cli.main(["--gate", "--gate-threshold", "3.0"],
                    {"repo_root": str(tmp_path)}, run_shell=fake_run)
    assert code == 2
    captured = capsys.readouterr()
    assert "gate" in captured.err.lower()


# --- CLI 取数与失败路径(crap 的策略:测试失败仍可报告部分覆盖率) ----------

def prepared_project(tmp_path, source="def f(x):\n    return x\n", executed=(1, 2)):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "m.py").write_text(source)
    write_artifact(tmp_path, executed)
    return str(tmp_path)


def write_artifact(tmp_path, executed_lines, rel="src/m.py"):
    artifact = tmp_path / ".toolcache" / "coverage.json"
    artifact.parent.mkdir(exist_ok=True)
    artifact.write_text(json.dumps(
        {"files": {rel: {"executed_lines": list(executed_lines)}}}))


def test_cli_reports_top_and_json_from_artifact(tmp_path, capsys):
    from tools.packages.crap import cli

    root = prepared_project(tmp_path, source="def f(x):\n    return x\n")
    assert cli.main(["--json"], {"repo_root": root}, run_shell=ok_shell()) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["entries"][0]["file"] == "src/m.py"
    assert payload["entries"][0]["crap"] == 1.0

    assert cli.main(["--top", "0"], {"repo_root": root}, run_shell=ok_shell()) == 0
    assert "No CRAP hotspots." in capsys.readouterr().out


def test_cli_warns_and_continues_when_tests_fail(tmp_path, capsys):
    from tools.packages.crap import cli

    root = prepared_project(tmp_path)
    calls = []
    code = cli.main([], {"repo_root": root},
                    run_shell=scripted_shell(calls, [0, 1, 0]))
    captured = capsys.readouterr()
    assert code == 0
    assert "tests failed under coverage" in captured.err
    assert "cov=100%" in captured.out


def test_cli_business_failures(tmp_path, capsys):
    from tools.packages.crap import cli

    # coverage 未安装:erase 步骤就失败
    root = prepared_project(tmp_path)
    assert cli.main([], {"repo_root": root}, run_shell=ok_shell(1)) == 1
    assert "coverage run failed" in capsys.readouterr().err

    # 产物步骤成功但文件不存在
    empty = str(tmp_path / "empty")
    os.makedirs(os.path.join(empty, "src"))
    assert cli.main(["--source", os.path.join(empty, "src")], {"repo_root": empty},
                    run_shell=ok_shell()) == 1
    assert "coverage artifact missing" in capsys.readouterr().err

    # 产物不可解析
    broken = tmp_path / "broken"
    (broken / ".toolcache").mkdir(parents=True)
    (broken / ".toolcache" / "coverage.json").write_text("{oops")
    (broken / "src").mkdir(parents=True)
    assert cli.main([], {"repo_root": str(broken)}, run_shell=ok_shell()) == 1
    assert "cannot read coverage artifact" in capsys.readouterr().err

    # 源目录不存在
    assert cli.main(["--source", str(tmp_path / "nope")], {"repo_root": root},
                    run_shell=ok_shell()) == 1
    assert "source directory not found" in capsys.readouterr().err


def test_cli_usage_errors(tmp_path, capsys):
    from tools.packages.crap import cli

    root = prepared_project(tmp_path)
    assert cli.main(["--bogus"], {"repo_root": root}, run_shell=ok_shell()) == 2
    assert "未知参数: --bogus" in capsys.readouterr().err
    assert cli.main(["--top", "x"], {"repo_root": root}, run_shell=ok_shell()) == 2
    assert "--top requires a numeric value" in capsys.readouterr().err
    assert cli.main(["--help"], {"repo_root": root}) == 0
    assert "CRAP = CC^2" in capsys.readouterr().out


def test_cli_gate_passes_under_threshold(tmp_path, capsys):
    from tools.packages.crap import cli

    root = prepared_project(tmp_path, source="def f(x):\n    return x\n")
    assert cli.main(["--gate"], {"repo_root": root}, run_shell=ok_shell()) == 0
    assert "gate" not in capsys.readouterr().err


def ok_shell(code=0):
    """三步流水线统一退出码(用于 coverage 未安装 / 一切正常两种极端)。"""
    def run_shell(argv, cwd=None, **kwargs):
        return SimpleNamespace(returncode=code)

    return run_shell


def scripted_shell(calls, codes):
    def run_shell(argv, cwd=None, **kwargs):
        calls.append(list(argv))
        return SimpleNamespace(returncode=codes[min(len(codes) - 1, len(calls) - 1)])

    return run_shell


# --- 引擎边界:不可解析/无体函数/缺失覆盖率 ---------------------------------

def test_build_report_skips_unparsable_and_unattributable_scopes():
    source = "def broken(:\n    pass\n"
    assert engine.build_report([("/p/x.py", source)], {}) == []

    only_nested = (
        "def outer():\n"
        "    def inner():\n"
        "        return 1\n"
    )
    coverage = {"/p/y.py": {"executed_lines": [1, 2, 3, 4]}}
    entry = engine.build_report([("/p/y.py", only_nested)], coverage)[0]
    assert entry["coverage"] is None and entry["crap"] is None
    assert engine.risk_band(None) == "low"
