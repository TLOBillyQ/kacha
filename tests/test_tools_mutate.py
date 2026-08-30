"""mutate 子命令：manifest footer、项目哈希、差分选择、变异算子与退出码。"""

from __future__ import annotations

import ast as pyast
from pathlib import Path

from tools.packages.mutate import engine, manifest

SRC = '''\
def add(a, b):
    if a > 0:
        result = a + b
        return result
    return 0


class K:
    def method(self, x):
        return x and True
'''


def test_manifest_roundtrip(tmp_path):
    data = {
        "version": 4,
        "project_hash": "abc123",
        "scopes": [
            {"id": "mod.add", "kind": "function", "start_line": 1,
             "end_line": 4, "semantic_hash": "fff"},
        ],
    }
    head = "def add(a, b):\n    return a + b\n"
    path = tmp_path / "m.py"
    manifest.write(path, head, data)
    raw = path.read_text()
    assert "# mutate4py-manifest" in raw
    assert "scope.0.id=mod.add" in raw
    got = manifest.read(path)
    assert got["project_hash"] == "abc123"
    assert got["scopes"][0]["semantic_hash"] == "fff"
    assert manifest.strip(raw) == head


def test_manifest_last_marker_wins(tmp_path):
    path = tmp_path / "m.py"
    path.write_text("# mutate4py-manifest\n# version=1\n")
    manifest.write(path, "# old\n", {"version": 4, "project_hash": "h", "scopes": []})
    got = manifest.read(path)
    assert got["version"] == 4
    assert manifest.strip(path.read_text()) == "# old\n"


def test_manifest_invalid_footer_is_none():
    assert manifest.parse_text("# mutate4py-manifest\n# notkv\n") is None


def test_project_hash_stable_and_sensitive(tmp_path):
    (tmp_path / "a.py").write_text("def f():\n    return 1\n")
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    target = tmp_path / "a.py"
    source = "def f():\n    return 1\n"
    hash_a = engine.project_hash(str(tmp_path), str(target), source)
    hash_b = engine.project_hash(str(tmp_path), str(target), source)
    hash_c = engine.project_hash(str(tmp_path), str(target), "def f():\n    return 2\n")
    assert hash_a == hash_b
    assert hash_a != hash_c


def test_project_hash_excludes_target_manifest(tmp_path):
    (tmp_path / "a.py").write_text("def f():\n    return 1\n")
    target = tmp_path / "a.py"
    plain = engine.project_hash(str(tmp_path), str(target), "def f():\n    return 1\n")
    with_footer = "def f():\n    return 1\n\n# mutate4py-manifest\n# version=4\n"
    assert engine.project_hash(str(tmp_path), str(target),
                               manifest.strip(with_footer)) == plain


def test_project_hash_ignores_cache_dirs(tmp_path):
    (tmp_path / "a.py").write_text("def f():\n    return 1\n")
    (tmp_path / ".venv").mkdir()
    (tmp_path / ".venv" / "junk.py").write_text("x = 1\n")
    (tmp_path / ".swarmforge").mkdir()
    (tmp_path / ".swarmforge" / "state.py").write_text("x = 2\n")
    (tmp_path / ".toolcache").mkdir()
    (tmp_path / ".toolcache" / "coverage.json").write_text("{}")
    target = tmp_path / "a.py"
    with_venv = engine.project_hash(str(tmp_path), str(target), "def f():\n    return 1\n")
    (tmp_path / ".venv" / "junk.py").write_text("x = 999\n")
    (tmp_path / ".swarmforge" / "state.py").write_text("x = 999\n")
    (tmp_path / ".toolcache" / "coverage.json").write_text('{"x": 1}')
    assert engine.project_hash(str(tmp_path), str(target), "def f():\n    return 1\n") \
        == with_venv


def test_scope_semantic_hash_ignores_names_but_keeps_ops():
    scopes_a, _, _ = engine.scan_module("def f(x):\n    return x + 1\n")
    scopes_b, _, _ = engine.scan_module("def g(y):\n    return y + 1\n")
    scopes_c, _, _ = engine.scan_module("def f(x):\n    return x - 1\n")
    assert engine.semantic_hash(scopes_a[0]) == engine.semantic_hash(scopes_b[0])
    assert engine.semantic_hash(scopes_a[0]) != engine.semantic_hash(scopes_c[0])


def test_scan_finds_operator_sites():
    scopes, sites, _ = engine.scan_module(SRC)
    descriptions = {site.description for site in sites}
    assert "compare/gt->lt" in descriptions
    assert "binop/add->sub" in descriptions
    assert "boolop/and->or" in descriptions
    assert "bool-flip" in descriptions
    assert "int-swap" in descriptions
    assert "rhs->none" in descriptions
    kinds = {scope.kind for scope in scopes}
    assert kinds == {"function", "method"}


def test_scan_skips_nested_functions():
    _scopes, sites, _ = engine.scan_module(
        "def outer():\n"
        "    def inner():\n"
        "        return True\n"
        "    return inner() + 1\n")
    assert {site.scope_id for site in sites} == {"mod.outer"}


def test_equivalent_boolop_swap_suppressed():
    _scopes, sites, _ = engine.scan_module("def f(x):\n    return x and x\n")
    assert not [s for s in sites if s.description.startswith("boolop/")]
    _scopes, sites, _ = engine.scan_module("def f(x):\n    return x and True\n")
    assert [s for s in sites if s.description.startswith("boolop/")]


def test_equivalent_add_sub_zero_suppressed():
    _scopes, sites, _ = engine.scan_module("def f(x):\n    return x - 0\n")
    assert not [s for s in sites if s.description.startswith("binop/")]
    _scopes, sites, _ = engine.scan_module("def f(x):\n    return x - 1\n")
    assert [s for s in sites if s.description.startswith("binop/")]


def test_selection_modes():
    source = "def f(x):\n    return x + 1\n"
    scopes, sites, _ = engine.scan_module(source)
    scope = scopes[0]
    options = {"mutate_all": False, "since_last_run": False, "line_set": None}
    assert engine.select_sites(sites, scopes, None, options, True) == sites

    same = {"version": 4, "project_hash": "h", "scopes": [
        {"id": scope.id, "kind": scope.kind, "start_line": scope.start_line,
         "end_line": scope.end_line, "semantic_hash": scope.semantic_hash}]}
    assert engine.select_sites(sites, scopes, same, options, False) == []
    assert engine.select_sites(sites, scopes, same, options, True) == []

    diff = {"version": 4, "project_hash": "h",
            "scopes": [dict(same["scopes"][0], semantic_hash="different")]}
    assert engine.select_sites(sites, scopes, diff, options, True) == sites
    assert engine.select_sites(sites, scopes, diff,
                               {"mutate_all": True, "since_last_run": False,
                                "line_set": None}, True) == sites
    assert engine.select_sites(sites, scopes, diff,
                               {"mutate_all": False, "since_last_run": True,
                                "line_set": None}, True) == sites
    assert engine.select_sites(sites, scopes, diff,
                               {"mutate_all": False, "since_last_run": False,
                                "line_set": {2}}, True) == sites


def test_apply_mutations_change_ast(tmp_path):
    source = "def f(x):\n    return x + 1\n"
    _scopes, sites, _ = engine.scan_module(source)
    for site in sites:
        mutated = site.mutated_source(source)
        assert pyast.dump(pyast.parse(mutated)) != pyast.dump(pyast.parse(source))
