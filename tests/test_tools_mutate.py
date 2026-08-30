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
    """纯操作数逐字相同才抑制:`x and x` 与 `x or x` 都只会返回 x。"""
    for source in ("def f(x):\n    return x and x\n",
                   "def f():\n    return True or True\n"):
        _scopes, sites, suppressed = engine.scan_module(source)
        assert not [s for s in sites if s.description.startswith("boolop/")], source
        assert suppressed == 1, source
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


# --- 算子施加、差分选择与表面面积 -------------------------------------------

ALL_OPERATORS = '''\
def flags(on, off):
    ok = True
    count = 0
    total = count + 1
    total -= 2
    text: str = "x"
    other: str
    if on and not off:
        return total or text
    return 0


def compares(a, b):
    if a == b or a != b or a < b or a <= b or a > b:
        pass
    if a >= b or a is b or a is not b or a in b or a not in b:
        pass
    return a * b


class Box:
    def shift(self, value):
        value //= 2
        value **= 2
        return value << 1 | value >> 1 & value @ value
'''


def test_every_operator_kind_applies():
    """每种算子都要能在"每次重新解析"的前提下施加成功并改变结构。"""
    _scopes, sites, _suppressed = engine.scan_module(ALL_OPERATORS)
    original = pyast.dump(pyast.parse(ALL_OPERATORS))
    kinds = set()
    for site in sites:
        site.apply(pyast.parse(ALL_OPERATORS))
        kinds.add(site.kind)
        assert pyast.dump(pyast.parse(site.mutated_source(ALL_OPERATORS))) != original
    assert {"bool-flip", "int-swap", "compare-swap", "binop-swap",
            "boolop-swap", "unary-remove", "rhs-none"} == kinds


def test_unknown_site_kind_is_a_programming_error():
    site = engine.Site(scope_id="m.f", line=1, description="?", kind="nope",
                       path=(), meta={})
    import pytest

    with pytest.raises(ValueError) as bad:
        site.apply(pyast.parse("def f():\n    return 1\n"))
    assert "unknown site kind" in str(bad.value)


def test_annassign_without_value_yields_no_site():
    _scopes, sites, _ = engine.scan_module("def f():\n    x: int\n    return x\n")
    assert sites == []


def test_changed_scope_ids_without_and_with_manifest():
    scopes, _sites, _ = engine.scan_module("def f(x):\n    return x > 1\n")
    assert engine.changed_scope_ids(scopes, None) == {scope.id for scope in scopes}

    recorded = {"scopes": [{"id": scopes[0].id,
                            "semantic_hash": scopes[0].semantic_hash}]}
    assert engine.changed_scope_ids(scopes, recorded) == set()
    assert engine.changed_scope_ids(scopes, {"scopes": []}) == {scopes[0].id}


def test_select_sites_without_manifest_and_with_untouched_module():
    scopes, sites, _ = engine.scan_module("def f(x):\n    return x > 1\n")
    options = {}
    assert engine.select_sites(sites, scopes, None, options, False) == sites
    same = {"scopes": [{"id": scopes[0].id,
                        "semantic_hash": scopes[0].semantic_hash}]}
    assert engine.select_sites(sites, scopes, same, options, True) == []
    # 语义哈希未变:即便强制 --since-last-run 也没有变更 scope
    assert engine.select_sites(sites, scopes, same,
                               {"since_last_run": True}, True) == []
    stale = {"scopes": [{"id": scopes[0].id, "semantic_hash": "stale"}]}
    assert engine.select_sites(sites, scopes, stale,
                               {"since_last_run": True}, True) == sites


def test_surface_areas_counts_differential_and_violating():
    scopes, sites, _ = engine.scan_module("def f(x):\n    return x > 1\n")
    assert engine.surface_areas(sites, scopes, None) == (len(sites), 0)

    stale = {"scopes": [{"id": scopes[0].id, "semantic_hash": "stale"}]}
    assert engine.surface_areas(sites, scopes, stale) == (0, len(sites))

    other = {"scopes": [{"id": "gone", "semantic_hash": "stale"}]}
    assert engine.surface_areas(sites, scopes, other) == (len(sites), 0)


def test_find_root_walks_up_to_marker(tmp_path):
    nested = tmp_path / "pkg" / "deep"
    nested.mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    target = nested / "m.py"
    target.write_text("def f():\n    return 1\n")
    assert engine.find_root(str(tmp_path), str(target)) == str(tmp_path)
    # workspace_root 是上界:再向上也不会越过它
    assert engine.find_root(str(nested), str(target)) == str(nested)

    loose = tmp_path / "loose"
    loose.mkdir()
    assert engine.find_root(str(loose), str(target)) == str(tmp_path)

    outside = tmp_path / "only"
    outside.mkdir()
    lonely = outside / "m.py"
    lonely.write_text("x = 1\n")
    assert engine.find_root(str(lonely.parent), str(lonely)) == str(lonely.parent)


# --- footer 识别:真 footer 只在文件末尾,引用文本不得截断源文件 ------------

FOOTER = "# mutate4py-manifest\n# version=4\n# projectHash=h\n"
MARKER_LINE = manifest.MARKER_LINE


def test_footer_recognised_after_code():
    source = "x = 1\n\n" + FOOTER
    assert manifest.strip(source) == "x = 1\n"
    assert manifest.parse_text(source)["version"] == 4


def test_marker_inside_string_does_not_truncate_source():
    """文档/示例里行首出现的 marker 后面还有代码:不是 footer,源文件保持原样。"""
    source = '"""\n格式:\n' + FOOTER + '\nx = 1\n"""\n'
    assert manifest.strip(source) == source
    assert manifest.parse_text(source) is None


def test_marker_must_own_its_line():
    """marker 前面还有别的字符(行中)且其后只剩注释:也不算 footer。"""
    source = "x = 1\n# note # mutate4py-manifest\n# version=4\n"
    assert manifest.strip(source) == source
    assert manifest.parse_text(source) is None


def test_footer_must_run_to_end_of_file():
    """marker 之后还有代码:整个文件视为没有 manifest。"""
    source = FOOTER + "raise SystemExit(1)\n"
    assert manifest.parse_text(source) is None
    assert manifest.strip(source) == source


def test_footer_at_offset_zero_without_trailing_newline():
    assert manifest.parse_text("# mutate4py-manifest\n# version=7")["version"] == 7


def test_last_valid_footer_wins_over_earlier_quoted_marker():
    source = '# note: # mutate4py-manifest\n# version=1\nx = 1\n\n' + FOOTER
    assert manifest.parse_text(source)["version"] == 4
    assert manifest.strip(source) == '# note: # mutate4py-manifest\n# version=1\nx = 1\n'


def test_assign_none_rhs_is_equivalent_and_suppressed():
    """`x = None` 的 rhs-none 变异写回同一个字面量:构造性等价,不产位点。"""
    _scopes, sites, suppressed = engine.scan_module("def f():\n    x = None\n    return x\n")
    assert sites == []
    assert suppressed == 1


def test_footer_may_contain_blank_lines():
    """footer 注释块里的空行不算"代码":仍要识别,且正文按 marker 行切分。"""
    source = "x = 1\n\n" + MARKER_LINE + "# version=4\n\n# projectHash=h\n"
    assert manifest.strip(source) == "x = 1\n"
    assert manifest.parse_text(source)["project_hash"] == "h"


def test_serialize_fills_missing_scope_fields_with_defaults():
    footer = manifest.serialize({"version": 4, "project_hash": "h",
                                 "scopes": [{"id": "m.f"}]})
    assert manifest.parse_text("x = 1\n\n" + footer)["scopes"] == [
        {"id": "m.f", "kind": "function", "start_line": 0, "end_line": 0,
         "semantic_hash": ""}]


# --- 算子施加结果、位点集合与哈希口径 ---------------------------------------

def _dump(text: str) -> str:
    return pyast.dump(pyast.parse(text))


def site_of(source: str, kind: str):
    found = [item for item in engine.scan_module(source)[1] if item.kind == kind]
    assert len(found) == 1, (kind, [item.kind for item in found])
    return found[0]


def test_each_operator_edit_rewrites_the_expected_node():
    cases = {
        "bool-flip": ("def f():\n    return True\n", "def f():\n    return False\n"),
        "int-swap": ("def f():\n    return 1\n", "def f():\n    return 0\n"),
        "compare-swap": ("def f(a, b):\n    return a > b\n",
                         "def f(a, b):\n    return a < b\n"),
        "binop-swap": ("def f(a, b):\n    return a + b\n",
                       "def f(a, b):\n    return a - b\n"),
        "boolop-swap": ("def f(a, b):\n    return a and b\n",
                        "def f(a, b):\n    return a or b\n"),
        "unary-remove": ("def f(a):\n    return not a\n", "def f(a):\n    return a\n"),
        "rhs-none": ("def f():\n    x = 1\n", "def f():\n    x = None\n"),
    }
    for kind, (source, expected) in cases.items():
        mutated = site_of(source, kind).mutated_source(source)
        assert _dump(mutated) == _dump(expected), kind


def test_semantic_hash_keeps_nested_definition_bodies():
    """嵌套定义属于外层 scope:内层结构变了,外层哈希必须变(否则差分漏跑)。"""
    a = engine.scan_module("def f():\n    def inner():\n        return 1\n"
                           "    return inner()\n")[0][0]
    b = engine.scan_module("def f():\n    def inner():\n        if flag:\n"
                           "            return 1\n    return inner()\n")[0][0]
    assert a.semantic_hash != b.semantic_hash


def test_semantic_hash_masks_names_and_literal_values():
    """钉死已知口径:改名与改字面量取值被归一化掩蔽,差分看不见这类编辑。

    要推翻这条口径(改成值敏感的哈希)是一次有意识的设计变更,不能顺手改。
    """
    a = engine.scan_module("def f(x):\n    return x > 5\n")[0][0]
    b = engine.scan_module("def f(y):\n    return y > 6\n")[0][0]
    assert a.semantic_hash == b.semantic_hash


def test_distinct_boolop_operands_are_not_suppressed():
    """`a and b` 换成 `a or b` 是真实行为差异:操作数不同名就不能算等价。"""
    _scopes, sites, suppressed = engine.scan_module("def f(a, b):\n    return a and b\n")
    assert [s.description for s in sites] == ["boolop/and->or"]
    assert suppressed == 0


def test_side_effecting_boolop_operands_are_not_suppressed():
    """`f() and f()` 操作数逐字相同,但 and/or 短路方向相反、求值次数不同。"""
    for source in ("def f(g):\n    return g() and g()\n",
                   "def f(g):\n    return g.x and g.x\n",
                   "def f(g):\n    return g[0] and g[0]\n"):
        _scopes, sites, suppressed = engine.scan_module(source)
        boolops = [site.description for site in sites
                   if site.description.startswith("boolop/")]
        assert boolops == ["boolop/and->or"], source
        assert suppressed == 0, source


def test_only_bool_and_zero_one_literals_produce_sites():
    for literal in ("0.0", "1.0", "2", "'1'", "None", "b'1'"):
        assert engine.scan_module(f"def f():\n    return {literal}\n")[1] == []
    assert engine.scan_module("def f():\n    return 0\n")[1]


def test_find_root_gives_up_at_filesystem_root(tmp_path, monkeypatch):
    """往上没有任何项目 marker 时退回 workspace 根。

    marker 判定必须 monkeypatch:真实 TMPDIR 可能本身就在项目副本里(mutate
    worker 的私有 TMPDIR 就是这样),祖先目录"没有 marker"不是可靠前提。
    """
    monkeypatch.setattr(engine, "_is_project_root", lambda path: False)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    outside = tmp_path / "elsewhere" / "deep"
    assert engine.find_root(str(workspace), str(outside / "m.py")) == str(workspace)


def test_project_hash_covers_python_and_marker_only(tmp_path):
    target = tmp_path / "a.py"
    target.write_text("def f():\n    return 1\n")
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    plain = engine.project_hash(str(tmp_path), str(target), "def f():\n    return 1\n")

    (tmp_path / "README.md").write_text("notes\n")
    (tmp_path / "app.log").write_text("noise\n")
    assert engine.project_hash(str(tmp_path), str(target),
                              "def f():\n    return 1\n") == plain
    (tmp_path / "README.md").write_text("different notes\n")
    assert engine.project_hash(str(tmp_path), str(target),
                              "def f():\n    return 1\n") == plain
    (tmp_path / "pyproject.toml").write_text("[project]\nname='y'\n")
    assert engine.project_hash(str(tmp_path), str(target),
                              "def f():\n    return 1\n") != plain


def test_since_last_run_picks_up_scopes_missing_from_manifest():
    source = "def f(x):\n    return x + 1\n"
    scopes, sites, _ = engine.scan_module(source)
    partial = {"version": 4, "project_hash": "h", "scopes": []}
    forced = {"mutate_all": False, "since_last_run": True, "line_set": None}
    plain = {"mutate_all": False, "since_last_run": False, "line_set": None}
    # 模块哈希未变但有 scope 没被登记:只有 --since-last-run 会补跑
    assert engine.select_sites(sites, scopes, partial, forced, False) == sites
    assert engine.select_sites(sites, scopes, partial, plain, False) == []
