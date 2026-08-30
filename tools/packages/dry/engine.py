"""dry4py —— Python 源码的结构性重复检测器(上游 dry4clj/go/java 的 Python 移植)。

工作原理:
1. ast 解析每个 Python 源文件
2. 从 AST 提取函数作用域(模块级函数 + 类方法)
3. 对每个作用域的子树做归一化:标识符 -> ident,字面量 -> literal/<KIND>,
   函数调用的被调用者 -> callee,运算符保留在标签中(如 op/add),节点类型即标签
4. 构建结构指纹:作用域内所有归一化子树序列化结果的集合
5. 对候选对做指纹集合的 Jaccard 相似度比较
6. 报告超过阈值的配对

嵌套函数在归一化期间折叠为 (function) 叶节点;同一文件中行号范围重叠的
条目(父函数与其嵌套子函数)从成对比较中排除(对齐 dry4java overlaps 语义)。
"""

from __future__ import annotations

import ast
import dataclasses
import os

# ast 字段中不属于结构语义的元数据,归一化时剔除
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


@dataclasses.dataclass
class Scope:
    name: str
    kind: str  # function | method
    start_line: int
    end_line: int
    nodes: int
    fingerprint: frozenset


@dataclasses.dataclass
class Duplicate:
    score: float
    lhs_file: str
    lhs: Scope
    rhs_file: str
    rhs: Scope


def _literal_kind(value) -> str:
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


def _normalize_node(node, outer: bool) -> str:
    """序列化一个节点为归一化 S 表达式。outer=True 表示作用域根(不折叠)。"""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not outer:
        return "(function)"
    if isinstance(node, ast.ClassDef) and not outer:
        return "(class)"
    if isinstance(node, ast.Name):
        return "ident"
    if isinstance(node, ast.Constant):
        return f"literal/{_literal_kind(node.value)}"
    tag = type(node).__name__
    if isinstance(node, ast.BinOp):
        tag = "op/" + _BIN_OPS.get(type(node.op), "binop")
    elif isinstance(node, ast.UnaryOp):
        tag = "op/" + _UNARY_OPS.get(type(node.op), "unaryop")
    elif isinstance(node, ast.BoolOp):
        tag = "boolop/" + ("and" if isinstance(node.op, ast.And) else "or")
    parts = [f"({tag}"]
    if isinstance(node, ast.Attribute):
        parts.append(_normalize_node(node.value, False))
        parts.append("ident")
        return " ".join(parts) + ")"
    if isinstance(node, ast.Call):
        parts.append("callee")
        for item in node.args:
            parts.append(_normalize_node(item, False))
        for keyword in node.keywords:
            parts.append(_normalize_node(keyword, False))
        return " ".join(parts) + ")"
    if isinstance(node, ast.Compare):
        parts.append(_normalize_node(node.left, False))
        for op, comparator in zip(node.ops, node.comparators):
            parts.append(f"(op/{_COMPARE_OPS.get(type(op), 'cmp')} "
                         + _normalize_node(comparator, False) + ")")
        return " ".join(parts) + ")"
    for field, value in ast.iter_fields(node):
        if field in _META_FIELDS:
            continue
        if isinstance(value, ast.AST):
            parts.append(_normalize_node(value, False))
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, ast.AST):
                    parts.append(_normalize_node(item, False))
    return " ".join(parts) + ")"


def _scope_fingerprint(function_node: ast.FunctionDef) -> tuple[frozenset, int]:
    """作用域内所有归一化子树序列化结果的集合,以及遍历节点总数。"""
    fingerprints = set()
    count = 0

    def visit(node, outer=False):
        nonlocal count
        count += 1
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not outer:
            fingerprints.add("(function)")
            return
        if isinstance(node, ast.ClassDef) and not outer:
            fingerprints.add("(class)")
            return
        fingerprints.add(_normalize_node(node, outer))
        for field, value in ast.iter_fields(node):
            if field in _META_FIELDS:
                continue
            if isinstance(value, ast.AST):
                visit(value)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, ast.AST):
                        visit(item)

    visit(function_node, outer=True)
    return frozenset(fingerprints), count


def _make_scope(node: ast.FunctionDef, kind: str) -> Scope:
    fingerprint, count = _scope_fingerprint(node)
    return Scope(
        name=node.name,
        kind=kind,
        start_line=node.lineno,
        end_line=getattr(node, "end_lineno", node.lineno),
        nodes=count,
        fingerprint=fingerprint,
    )


def scopes_from_source(source: str) -> list[Scope]:
    tree = ast.parse(source)
    scopes: list[Scope] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            scopes.append(_make_scope(node, "function"))
        elif isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    scopes.append(_make_scope(item, "method"))
    return scopes


def normalize_scope(scope: Scope) -> str:
    return " ".join(sorted(scope.fingerprint))


def scope_nodes(scope: Scope) -> int:
    return scope.nodes


def jaccard(lhs: set, rhs: set) -> float:
    if not lhs and not rhs:
        return 0.0
    union = lhs | rhs
    return len(lhs & rhs) / len(union)


def _overlaps(lhs: Scope, rhs: Scope) -> bool:
    return not (lhs.end_line < rhs.start_line or rhs.end_line < lhs.start_line)


def _collect_files(paths) -> list[str]:
    files: list[str] = []
    for path in paths:
        if os.path.isdir(path):
            for root, _dirs, names in os.walk(path):
                for name in sorted(names):
                    if name.endswith(".py"):
                        files.append(os.path.join(root, name))
        else:
            files.append(str(path))
    return sorted(files)


def find_duplicates(paths, threshold: float = 0.82, min_lines: int = 4,
                    min_nodes: int = 20) -> list[Duplicate]:
    scopes: list[tuple[str, Scope]] = []
    for file in _collect_files(paths):
        try:
            with open(file, encoding="utf-8") as handle:
                source = handle.read()
        except OSError:
            continue
        try:
            for scope in scopes_from_source(source):
                if scope.end_line - scope.start_line + 1 < min_lines:
                    continue
                if scope.nodes < min_nodes:
                    continue
                scopes.append((file, scope))
        except SyntaxError:
            continue

    pairs: list[Duplicate] = []
    for index, (lhs_file, lhs) in enumerate(scopes):
        for rhs_file, rhs in scopes[index + 1:]:
            if lhs_file == rhs_file and _overlaps(lhs, rhs):
                continue
            score = jaccard(lhs.fingerprint, rhs.fingerprint)
            if score >= threshold:
                pairs.append(Duplicate(score=score, lhs_file=lhs_file, lhs=lhs,
                                       rhs_file=rhs_file, rhs=rhs))
    pairs.sort(key=lambda pair: (-pair.score,
                                 pair.lhs.start_line, pair.rhs.start_line))
    return pairs
