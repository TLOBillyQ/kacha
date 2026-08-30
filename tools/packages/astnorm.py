"""AST 词汇表 —— dry 指纹、mutate 语义哈希与 crap 作用域提取共用。

归一化规则(与 dry4lua 对齐):标识符 -> ident,字面量 -> literal/<KIND>,
函数调用的被调用者 -> callee,运算符保留在标签中(如 op/add),节点类型即标签;行号、
列号、ctx 等非结构字段剔除。fold=True 时嵌套函数/类折叠为 (function)/(class) 叶。

本模块也持有"作用域 = 模块级函数 + 类方法"这一 two-pack 工具链的统一作用域模型,
以及"按字段遍历子节点"的唯一实现(带列表下标,供变异引擎重建路径)。
"""

from __future__ import annotations

import ast

#: AST 里不属于结构语义的元数据字段,归一化/遍历时剔除(全链共用一张表)
META_FIELDS = ("ctx", "type_comment", "lineno", "col_offset", "end_lineno",
               "end_col_offset")

FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)

_LITERAL_KINDS = ((bool, "bool"), ((int, float, complex), "num"), (str, "str"),
                  (bytes, "bytes"))

_BIN_OPS = {
    ast.Add: "add", ast.Sub: "sub", ast.Mult: "mult", ast.Div: "div",
    ast.FloorDiv: "floordiv", ast.Mod: "mod", ast.Pow: "pow",
    ast.LShift: "lshift", ast.RShift: "rshift", ast.BitOr: "bitor",
    ast.BitXor: "bitxor", ast.BitAnd: "bitand", ast.MatMult: "matmult",
}
_UNARY_OPS = {ast.Not: "not", ast.USub: "usub", ast.UAdd: "uadd",
              ast.Invert: "invert"}
_COMPARE_OPS = {
    ast.Eq: "eq", ast.NotEq: "neq", ast.Lt: "lt", ast.LtE: "lte",
    ast.Gt: "gt", ast.GtE: "gte", ast.Is: "is", ast.IsNot: "isnot",
    ast.In: "in", ast.NotIn: "notin",
}


def literal_kind(value) -> str:
    """字面量类别;bool 必须先于数值判定(bool 是 int 的子类)。"""
    if value is None:
        return "none"
    for types, kind in _LITERAL_KINDS:
        if isinstance(value, types):
            return kind
    return "other"


def function_scopes(source: str) -> list[tuple[str, str, ast.FunctionDef]]:
    """作用域模型:返回 [(name, kind, node)],kind 为 function | method。

    只收模块级函数与类方法(嵌套函数属于外层作用域);三个工具的"作用域"都以此为准。
    """
    tree = ast.parse(source)
    scopes = [(node.name, "function", node)
              for node in tree.body if isinstance(node, FUNCTION_NODES)]
    scopes += [(method.name, "method", method)
               for cls in tree.body if isinstance(cls, ast.ClassDef)
               for method in cls.body if isinstance(method, FUNCTION_NODES)]
    return scopes


def child_nodes(node, skip: tuple = ()) -> list[tuple[str, int | None, ast.AST]]:
    """返回 (字段名, 列表下标或 None, 子节点);跳过元数据字段与非 AST 值。"""
    return [(field, index, item)
            for field, value in ast.iter_fields(node) if field not in skip
            for index, item in _field_entries(field, value)]


def _field_entries(field: str, value) -> list[tuple[int | None, ast.AST]]:
    if isinstance(value, ast.AST):
        return [(None, value)]
    if isinstance(value, list):
        return [(index, item) for index, item in enumerate(value)
                if isinstance(item, ast.AST)]
    return []


def folded_label(node, outer: bool, fold: bool = True) -> str | None:
    """非根节点的嵌套函数/类折叠为叶标签;否则返回 None 表示继续展开。"""
    if outer or not fold:
        return None
    if isinstance(node, FUNCTION_NODES):
        return "(function)"
    return "(class)" if isinstance(node, ast.ClassDef) else None


def normalize_node(node, outer: bool = False, fold: bool = True) -> str:
    """序列化一个节点为归一化 S 表达式。outer=True 表示作用域根(不折叠)。"""
    folded = folded_label(node, outer, fold)
    if folded is not None:
        return folded
    shaped = _SHAPE_HANDLERS.get(type(node))
    if shaped is not None:
        return shaped(node, fold)
    return _serialize(node, fold)


def _ident(node, fold: bool) -> str:
    return "ident"


def _literal(node, fold: bool) -> str:
    return f"literal/{literal_kind(node.value)}"


def _attribute(node, fold: bool) -> str:
    """属性访问:被访问对象保留结构,属性名一律归为 ident。"""
    return f"(Attribute {normalize_node(node.value, False, fold)} ident)"


def _call(node, fold: bool) -> str:
    """调用:被调用者归为 callee,实参/关键参数保留结构。"""
    parts = ["(Call", "callee"]
    parts += [normalize_node(item, False, fold) for item in node.args]
    parts += [normalize_node(keyword, False, fold) for keyword in node.keywords]
    return " ".join(parts) + ")"


def _compare(node, fold: bool) -> str:
    parts = ["(Compare", normalize_node(node.left, False, fold)]
    parts += [_compare_operator(op, comparator, fold)
              for op, comparator in zip(node.ops, node.comparators)]
    return " ".join(parts) + ")"


def _compare_operator(op, comparator, fold: bool) -> str:
    return (f"(op/{_COMPARE_OPS.get(type(op), 'cmp')} "
            + normalize_node(comparator, False, fold) + ")")


def _node_tag(node) -> str:
    """节点标签:运算符/布尔运算符进标签,其余用 AST 类型名。"""
    if isinstance(node, ast.BinOp):
        return "op/" + _BIN_OPS.get(type(node.op), "binop")
    if isinstance(node, ast.UnaryOp):
        return "op/" + _UNARY_OPS.get(type(node.op), "unaryop")
    if isinstance(node, ast.BoolOp):
        return "boolop/" + ("and" if isinstance(node.op, ast.And) else "or")
    return type(node).__name__


def _serialize(node, fold: bool) -> str:
    parts = [f"({_node_tag(node)}"]
    parts += [normalize_node(child, False, fold)
              for _field, _index, child in child_nodes(node, META_FIELDS)]
    return " ".join(parts) + ")"


#: 需要特殊形状的节点类型;其余走 _serialize 的通用字段遍历。
_SHAPE_HANDLERS = {
    ast.Name: _ident,
    ast.Constant: _literal,
    ast.Attribute: _attribute,
    ast.Call: _call,
    ast.Compare: _compare,
}


def fnv1a64(text: str) -> str:
    """FNV-1a 64 位哈希,16 位十六进制字符串。"""
    value = 0xCBF29CE484222325
    prime = 0x100000001B3
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * prime) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"
