"""astnorm:共享 AST 词汇表 —— 作用域模型、子节点遍历、折叠与归一化标签。"""

from __future__ import annotations

import ast

from tools.packages import astnorm


def parse(source):
    return ast.parse(source).body


def test_function_scopes_covers_module_functions_and_methods():
    scopes = astnorm.function_scopes(
        "def top():\n    pass\n\n\nasync def later():\n    pass\n\n\n"
        "class K:\n    def m(self):\n        pass\n\n    x = 1\n")
    assert [(name, kind) for name, kind, _node in scopes] == [
        ("top", "function"), ("later", "function"), ("m", "method")]


def test_function_scopes_ignores_nested_definitions():
    scopes = astnorm.function_scopes(
        "def outer():\n    def inner():\n        return 1\n    return inner\n")
    assert [name for name, _kind, _node in scopes] == ["outer"]


def test_child_nodes_pairs_field_with_list_index():
    function = parse("def f():\n    a = [1, 2]\n    return a\n")[0]
    assert [(field, index) for field, index, _child
            in astnorm.child_nodes(function)] == [("args", None), ("body", 0),
                                                  ("body", 1)]
    assign = astnorm.child_nodes(function.body[0])
    assert [(field, index, type(node).__name__) for field, index, node in assign] == [
        ("targets", 0, "Name"), ("value", None, "List")]
    assert astnorm.child_nodes(parse("x = 1")[0].value) == []


def test_child_nodes_skips_meta_and_non_ast_fields():
    annotated = parse("x: int = 1\n")[0]
    assert {field for field, _index, _child in astnorm.child_nodes(annotated)} == {
        "target", "annotation", "value"}
    function = parse("def f():\n    return 1\n")[0]
    assert {field for field, _index, _child
            in astnorm.child_nodes(function, astnorm.META_FIELDS)} == {
        "args", "body"}


def test_folded_label_only_folds_non_root_definitions():
    function = parse("def f():\n    return 1\n")[0]
    klass = parse("class K:\n    pass\n")[0]
    assert astnorm.folded_label(function, outer=True) is None
    assert astnorm.folded_label(function, outer=False) == "(function)"
    assert astnorm.folded_label(function, outer=False, fold=False) is None
    assert astnorm.folded_label(klass, outer=False) == "(class)"
    assert astnorm.folded_label(parse("x = 1")[0], outer=False) is None


def test_literal_kind_covers_every_family():
    assert [astnorm.literal_kind(value) for value in
            (True, 3, 1.5, 2j, "s", b"b", None, object())] == \
        ["bool", "num", "num", "num", "str", "bytes", "none", "other"]


def test_normalize_node_shapes_stay_distinct():
    def fingerprint(source):
        return astnorm.normalize_node(parse(source)[0], outer=True)

    assert fingerprint("def f(x):\n    return x.y\n") != \
        fingerprint("def f(x):\n    return x\n")
    assert fingerprint("def f():\n    return ~1\n") != \
        fingerprint("def f():\n    return +1\n")
    assert "op/mod" in fingerprint("def f():\n    return 1 % 2\n")
    assert "op/matmult" in fingerprint("def f(a, b):\n    return a @ b\n")
    and_form = fingerprint("def f(a, b):\n    return a and b\n")
    or_form = fingerprint("def f(a, b):\n    return a or b\n")
    assert "boolop/and" in and_form and "boolop/or" in or_form
    assert and_form != or_form
    # 未知运算符类型保留可读兜底标签
    weird = ast.Compare(left=ast.Constant(1), ops=[ast.Add()],
                        comparators=[ast.Constant(2)])
    assert "op/cmp" in astnorm.normalize_node(weird)


def test_normalize_node_keeps_unknown_operator_labels():
    class Weird(ast.BinOp):
        pass

    assert astnorm._node_tag(Weird(left=ast.Constant(1), op=ast.Add(),
                                   right=ast.Constant(2))) == "op/add"
    node = ast.UnaryOp(op=ast.UAdd(), operand=ast.Constant(1))
    assert astnorm._node_tag(node) == "op/uadd"
    assert astnorm._node_tag(ast.Raise()) == "Raise"


def test_fnv1a64_is_stable_hex():
    assert astnorm.fnv1a64("abc") == astnorm.fnv1a64("abc")
    assert astnorm.fnv1a64("abc") != astnorm.fnv1a64("abd")
    assert len(astnorm.fnv1a64("")) == 16


def _def_node(source, index=0):
    body = ast.parse(source).body
    return body[index]


def test_normalize_node_folds_nested_definitions_in_statement_children():
    nested = ("def outer_fn():\n"
              "    if flag:\n"
              "        def inner():\n"
              "            return 1\n"
              "    return outer_fn\n")
    same_shape = ("def outer_fn():\n"
                  "    if flag:\n"
                  "        def helper(a, b):\n"
                  "            return 2 * a\n"
                  "    return outer_fn\n")
    folded = astnorm.normalize_node(_def_node(nested), outer=True)
    assert "(function)" in folded and "inner" not in folded
    # 折叠只看"这里有个嵌套定义",不看它的名字、参数与实现
    assert folded == astnorm.normalize_node(_def_node(same_shape), outer=True)
    # fold=False 与作用域哈希同口径:嵌套定义继续展开,两者就分得开
    unfolded = astnorm.normalize_node(_def_node(nested), outer=True, fold=False)
    assert "(function)" not in unfolded
    assert unfolded != astnorm.normalize_node(_def_node(same_shape), outer=True,
                                             fold=False)


def test_normalize_node_root_is_never_folded():
    node = _def_node("def f():\n    return 1\n")
    assert astnorm.normalize_node(node, outer=True).startswith("(FunctionDef")
    assert astnorm.normalize_node(node, outer=False) == "(function)"
    assert astnorm.normalize_node(node, outer=True, fold=False) == \
        astnorm.normalize_node(node, outer=False, fold=False)
