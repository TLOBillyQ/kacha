"""dry 子命令：AST 归一化指纹 + Jaccard 结构重复检测。"""

from __future__ import annotations

import json

from tools.packages.dry import engine

SRC_INTERESTING = '''\
def total(items):
    result = 0
    for item in items:
        if item > 1:
            result = result + item * 2
        else:
            result = result - item
    return result
'''


def test_normalization_masks_names_and_literals():
    a = engine.normalize_scope(engine.scopes_from_source(
        "def f(x):\n    return x + 1\n")[0])
    b = engine.normalize_scope(engine.scopes_from_source(
        "def g(y):\n    return y + 2\n")[0])
    assert a == b


def test_normalization_keeps_operator_kinds():
    a = engine.normalize_scope(engine.scopes_from_source(
        "def f(x):\n    return x + 1\n")[0])
    b = engine.normalize_scope(engine.scopes_from_source(
        "def f(x):\n    return x - 1\n")[0])
    assert a != b


def test_normalization_masks_callees_and_keeps_call_shape():
    a = engine.normalize_scope(engine.scopes_from_source(
        "def f(x):\n    return len(x)\n")[0])
    b = engine.normalize_scope(engine.scopes_from_source(
        "def f(x):\n    return  len(x)\n")[0])
    c = engine.normalize_scope(engine.scopes_from_source(
        "def f(x):\n    return len(x, y)\n")[0])
    assert a == b
    assert a != c


def test_nested_function_folds_to_leaf():
    a = engine.normalize_scope(engine.scopes_from_source(
        "def outer():\n    def inner():\n        return 1\n    return inner()\n")[0])
    b = engine.normalize_scope(engine.scopes_from_source(
        "def outer():\n    def core():\n        return 999\n    return core()\n")[0])
    assert a == b


def test_jaccard_bounds():
    assert engine.jaccard({"a"}, {"a"}) == 1.0
    assert engine.jaccard({"a"}, {"b"}) == 0.0
    assert engine.jaccard({"a", "b"}, {"b", "c"}) == 1 / 3


def test_extract_scopes_kinds():
    scopes = engine.scopes_from_source(
        "def top():\n    pass\n\nclass K:\n    def method(self):\n        pass\n")
    assert [(s.name, s.kind) for s in scopes] == [("top", "function"), ("method", "method")]
    assert scopes[1].start_line == 5


def test_pruning_by_nodes_and_lines():
    tiny = engine.scopes_from_source("def f():\n    return 1\n")[0]
    assert engine.scope_nodes(tiny) < 20 or (tiny.end_line - tiny.start_line + 1) < 4
    big = "def f():\n" + "".join(f"    x{i} = {i}\n" for i in range(12))
    big_scope = engine.scopes_from_source(big)[0]
    assert engine.scope_nodes(big_scope) >= 20


def test_duplicates_found_across_files(tmp_path):
    (tmp_path / "a.py").write_text(SRC_INTERESTING)
    (tmp_path / "b.py").write_text(SRC_INTERESTING.replace("total", "calculate"))
    results = engine.find_duplicates([tmp_path / "a.py", tmp_path / "b.py"])
    assert len(results) == 1
    assert results[0].score >= 0.82


def test_no_candidates_for_distinct_functions(tmp_path):
    (tmp_path / "a.py").write_text(SRC_INTERESTING)
    (tmp_path / "b.py").write_text(
        "def helper():\n"
        "    text = ''\n"
        "    for ch in 'abc':\n"
        "        text += ch\n"
        "    return text.upper()\n")
    assert engine.find_duplicates([tmp_path / "a.py", tmp_path / "b.py"]) == []


def test_same_file_overlaps_excluded(tmp_path):
    (tmp_path / "a.py").write_text(
        "def outer():\n"
        "    def inner():\n"
        "        return 42\n"
        "    return inner()\n")
    assert engine.find_duplicates([tmp_path / "a.py"]) == []


def test_cli_reports_duplicate_pairs(tmp_path, capsys):
    (tmp_path / "a.py").write_text(SRC_INTERESTING)
    (tmp_path / "b.py").write_text(SRC_INTERESTING.replace("total", "calculate"))
    from tools.packages.dry import cli
    code = cli.main([str(tmp_path / "a.py"), str(tmp_path / "b.py")],
                    {"repo_root": str(tmp_path)})
    out = capsys.readouterr().out
    assert code == 0
    assert "DUPLICATE score=" in out
    assert "a.py:" in out and "b.py:" in out


def test_cli_no_candidates_message(tmp_path, capsys):
    (tmp_path / "a.py").write_text(SRC_INTERESTING)
    (tmp_path / "b.py").write_text(
        "def helper():\n    return [i for i in range(10)]\n")
    from tools.packages.dry import cli
    code = cli.main([str(tmp_path / "a.py"), str(tmp_path / "b.py")],
                    {"repo_root": str(tmp_path)})
    assert code == 0
    assert "No duplicate candidates found." in capsys.readouterr().out


def test_cli_json_format_and_bad_format(tmp_path, capsys):
    (tmp_path / "a.py").write_text(SRC_INTERESTING)
    (tmp_path / "b.py").write_text(SRC_INTERESTING)
    from tools.packages.dry import cli
    code = cli.main(["--format", "json", str(tmp_path / "a.py"), str(tmp_path / "b.py")],
                    {"repo_root": str(tmp_path)})
    assert code == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["pairs"][0]["score"] >= 0.82
    assert payload["pairs"][0]["a"]["name"] == "total"
    assert captured.err == ""
    assert cli.main(["--format", "xml", str(tmp_path / "a.py")],
                    {"repo_root": str(tmp_path)}) == 2
    assert "未知格式" in capsys.readouterr().err


# --- CLI 选项与引擎边界 -------------------------------------------------------

def test_cli_numeric_option_errors_exit_2(tmp_path, capsys):
    from tools.packages.dry import cli

    (tmp_path / "a.py").write_text(SRC_INTERESTING)
    for option in ("--threshold", "--min-lines", "--min-nodes", "--limit"):
        assert cli.main([option, "abc", str(tmp_path / "a.py")],
                        {"repo_root": str(tmp_path)}) == 2
        assert "requires a numeric value" in capsys.readouterr().err
    assert cli.main(["--threshold"], {"repo_root": str(tmp_path)}) == 2
    assert cli.main(["--help"], {"repo_root": str(tmp_path)}) == 0
    assert "结构重复检测" in capsys.readouterr().out


def test_cli_limit_and_default_paths(tmp_path, capsys):
    from tools.packages.dry import cli

    for name in ("a.py", "b.py", "c.py"):
        (tmp_path / name).write_text(SRC_INTERESTING)
    # 无路径参数 -> 默认扫描 <repo_root>/src,不存在则整个 repo_root
    assert cli.main([], {"repo_root": str(tmp_path)}) == 0
    out = capsys.readouterr().out
    assert out.count("DUPLICATE score=") == 3
    assert cli.main(["--limit", "1"], {"repo_root": str(tmp_path)}) == 0
    assert capsys.readouterr().out.count("DUPLICATE score=") == 1


def test_cli_json_and_text_report_the_same_pairs(tmp_path, capsys):
    from tools.packages.dry import cli

    (tmp_path / "a.py").write_text(SRC_INTERESTING)
    (tmp_path / "b.py").write_text(SRC_INTERESTING.replace("total", "calculate"))
    assert cli.main(["--format", "json", str(tmp_path)],
                    {"repo_root": str(tmp_path)}) == 0
    payload = json.loads(capsys.readouterr().out)
    assert {payload["pairs"][0]["b"]["name"]} == {"calculate"}


def test_unreadable_and_unparsable_files_are_skipped(tmp_path):
    (tmp_path / "good.py").write_text(SRC_INTERESTING)
    (tmp_path / "bad.py").write_text("def broken(:\n    pass\n")
    pairs = engine.find_duplicates([tmp_path / "good.py", tmp_path / "bad.py",
                                    tmp_path / "missing.py"])
    assert pairs == []


def test_overlapping_scopes_in_one_file_are_excluded():
    lhs = engine.Scope(name="outer", kind="function", start_line=1, end_line=9,
                       nodes=30, fingerprint=frozenset({"a", "b"}))
    rhs = engine.Scope(name="inner", kind="function", start_line=4, end_line=6,
                       nodes=30, fingerprint=frozenset({"a", "b"}))
    other = engine.Scope(name="later", kind="function", start_line=10, end_line=18,
                         nodes=30, fingerprint=frozenset({"a", "b"}))
    assert engine._overlaps(lhs, rhs)
    assert not engine._overlaps(lhs, other)

def test_jaccard_of_two_empty_sets_is_zero():
    assert engine.jaccard(set(), set()) == 0.0
    assert engine.jaccard(set(), {"a"}) == 0.0


def test_scope_nodes_counts_folded_nested_definition_as_one_leaf():
    plain = engine.scopes_from_source("def f():\n    return 1\n")[0]
    nested = engine.scopes_from_source(
        "def f():\n    def inner():\n        return 1\n    return inner()\n")[0]
    assert engine.scope_nodes(plain) == 4
    # 嵌套定义整块折叠成一个 "(function)" 叶:计 1 个节点,内部不计
    assert engine.scope_nodes(nested) == 6


def test_pruned_scope_pair_is_not_reported(tmp_path):
    wide = "def f():\n" + "".join(f"    s{i} = a + b\n" for i in range(6))
    (tmp_path / "a.py").write_text(wide)
    (tmp_path / "b.py").write_text(wide.replace("def f", "def g"))
    assert len(engine.find_duplicates([tmp_path / "a.py", tmp_path / "b.py"],
                                     threshold=0.0, min_lines=2, min_nodes=2)) == 1
    # 只满足一个维度不算候选(and 而非 or)
    assert engine.find_duplicates([tmp_path / "a.py", tmp_path / "b.py"],
                                 threshold=0.0, min_lines=2,
                                 min_nodes=10 ** 6) == []
    assert engine.find_duplicates([tmp_path / "a.py", tmp_path / "b.py"],
                                 threshold=0.0, min_lines=10 ** 6,
                                 min_nodes=2) == []


def test_line_span_boundary_is_inclusive(tmp_path):
    exactly_four = "def f():\n    x = 1\n    y = 2\n    return x + y\n"
    (tmp_path / "a.py").write_text(exactly_four)
    (tmp_path / "b.py").write_text(exactly_four.replace("def f", "def g"))
    assert len(engine.find_duplicates([tmp_path / "a.py", tmp_path / "b.py"],
                                      threshold=0.0, min_lines=4,
                                      min_nodes=1)) == 1
    assert engine.find_duplicates([tmp_path / "a.py", tmp_path / "b.py"],
                                  threshold=0.0, min_lines=5,
                                  min_nodes=1) == []


def test_pairs_sort_by_score_descending(tmp_path):
    body = "".join(f"    s{i} = a + b\n" for i in range(6))
    (tmp_path / "a.py").write_text("def f_one():\n" + body
                                   + "\n\ndef f_two():\n" + body)
    (tmp_path / "b.py").write_text("def g_one():\n" + body
                                   + "    if a:\n        return 1\n")
    pairs = engine.find_duplicates([tmp_path / "a.py", tmp_path / "b.py"],
                                   threshold=0.1, min_lines=1, min_nodes=1)
    assert len(pairs) >= 2
    assert [pair.score for pair in pairs] == sorted((p.score for p in pairs),
                                                    reverse=True)
    assert pairs[0].score == 1.0 and pairs[-1].score < 1.0


def test_fingerprint_pair_detection_relies_on_folding_nested_defs(tmp_path):
    def source(name, inner_name, inner_body):
        return (f"def {name}():\n"
                f"    def {inner_name}():\n"
                f"        {inner_body}\n"
                "    if flag:\n"
                f"        return {inner_name}()\n"
                "    return 0\n")

    (tmp_path / "a.py").write_text(source("outer", "helper", "return 1"))
    (tmp_path / "b.py").write_text(source("other", "core", "return 22 * a"))
    pairs = engine.find_duplicates([tmp_path / "a.py", tmp_path / "b.py"],
                                   min_lines=1, min_nodes=1)
    assert len(pairs) == 1 and pairs[0].score == 1.0


def test_cli_json_keeps_non_ascii_names(tmp_path, capsys):
    from tools.packages.dry import cli

    body = SRC_INTERESTING.split("\n", 1)[1]
    source = "def 汇总(items):\n" + body
    (tmp_path / "a.py").write_text(source)
    (tmp_path / "b.py").write_text(source.replace("def 汇总", "def 统计"))
    assert cli.main(["--format", "json", str(tmp_path / "a.py"),
                     str(tmp_path / "b.py")], {"repo_root": str(tmp_path)}) == 0
    raw = capsys.readouterr().out
    assert "汇总" in raw and "\\u6c47" not in raw
    assert json.loads(raw)["pairs"][0]["a"]["name"] == "汇总"


def test_cli_text_pair_block_layout(tmp_path, capsys):
    from tools.packages.dry import cli

    (tmp_path / "a.py").write_text(SRC_INTERESTING)
    (tmp_path / "b.py").write_text(SRC_INTERESTING.replace("total", "sum_all"))
    assert cli.main([str(tmp_path / "a.py"), str(tmp_path / "b.py")],
                    {"repo_root": str(tmp_path)}) == 0
    assert capsys.readouterr().out == \
        "DUPLICATE score=1.00\n  a.py:1-8\n  b.py:1-8\n"
