"""AST 归一化 —— dry 指纹与 mutate 语义哈希共用。

归一化规则(与 dry4lua 对齐):标识符 -> ident,字面量 -> literal/<KIND>,
函数调用的被调用者 -> callee,运算符保留在标签中(如 op/add),节点类型即标签;行号、
列号、ctx 等非结构字段剔除。fold=True 时嵌套函数/类折叠为 (function)/(class) 叶。
"""

from __future__ import annotations

import ast

_META_FIELDS = {"ctx", "type_comment", "lineno", "col_offset", "end_lineno",
                "end_col_offset"}

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
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float, complex)):
        return "num"
    if isinstance(value, str):
        return "str"
    if value is None:
        return "none"
    if isinstance(value, bytes):
        return "bytes"
    return "other"


def normalize_node(node, outer: bool = False, fold: bool = True) -> str:
    """序列化一个节点为归一化 S 表达式。outer=True 表示作用域根(不折叠)。"""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        if not outer and fold:
            return "(function)"
    if isinstance(node, ast.ClassDef) and not outer and fold:
        return "(class)"
    if isinstance(node, ast.Name):
        return "ident"
    if isinstance(node, ast.Constant):
        return f"literal/{literal_kind(node.value)}"
    tag = type(node).__name__
    if isinstance(node, ast.BinOp):
        tag = "op/" + _BIN_OPS.get(type(node.op), "binop")
    elif isinstance(node, ast.UnaryOp):
        tag = "op/" + _UNARY_OPS.get(type(node.op), "unaryop")
    elif isinstance(node, ast.BoolOp):
        tag = "boolop/" + ("and" if isinstance(node.op, ast.And) else "or")
    parts = [f"({tag}"]
    if isinstance(node, ast.Attribute):
        parts.append(normalize_node(node.value, False, fold))
        parts.append("ident")
        return " ".join(parts) + ")"
    if isinstance(node, ast.Call):
        parts.append("callee")
        for item in node.args:
            parts.append(normalize_node(item, False, fold))
        for keyword in node.keywords:
            parts.append(normalize_node(keyword, False, fold))
        return " ".join(parts) + ")"
    if isinstance(node, ast.Compare):
        parts.append(normalize_node(node.left, False, fold))
        for op, comparator in zip(node.ops, node.comparators):
            parts.append(f"(op/{_COMPARE_OPS.get(type(op), 'cmp')} "
                         + normalize_node(comparator, False, fold) + ")")
        return " ".join(parts) + ")"
    for field, value in ast.iter_fields(node):
        if field in _META_FIELDS:
            continue
        if isinstance(value, ast.AST):
            parts.append(normalize_node(value, False, fold))
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, ast.AST):
                    parts.append(normalize_node(item, False, fold))
    return " ".join(parts) + ")"


def fnv1a64(text: str) -> str:
    """FNV-1a 64 位哈希,16 位十六进制字符串。"""
    value = 0xCBF29CE484222325
    prime = 0x100000001B3
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * prime) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"
