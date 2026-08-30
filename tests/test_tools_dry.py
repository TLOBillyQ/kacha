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
