"""dry4py —— Python 源码的结构性重复检测器(上游 dry4clj/go/java 的 Python 移植)。

工作原理:
1. ast 解析每个 Python 源文件
2. 从 AST 提取函数作用域(模块级函数 + 类方法,复用 ..common 的作用域模型)
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
from itertools import combinations

from ..astnorm import META_FIELDS, child_nodes, folded_label, function_scopes, \
    normalize_node
from ..common import read_sources


#: 默认参数(与上游 dry4lua 一致)
DEFAULT_THRESHOLD = 0.82
DEFAULT_MIN_LINES = 4
DEFAULT_MIN_NODES = 20


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


def _scope_fingerprint(function_node: ast.FunctionDef) -> tuple[frozenset, int]:
    """作用域内所有归一化子树序列化结果的集合,以及遍历节点总数。"""
    fingerprints: set[str] = set()
    nodes = _collect_fingerprints(function_node, fingerprints, outer=True)
    return frozenset(fingerprints), nodes


def _collect_fingerprints(node, fingerprints: set[str], outer: bool = False) -> int:
    """收集 node 及其后代的指纹,返回访问到的节点数(折叠叶也计 1)。"""
    folded = folded_label(node, outer)
    if folded is not None:
        fingerprints.add(folded)
        return 1
    fingerprints.add(normalize_node(node, outer))
    return 1 + sum(_collect_fingerprints(child, fingerprints)
                   for _field, _index, child in child_nodes(node, META_FIELDS))


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
    """检测单位 = 函数作用域(模块级函数 + 类方法),与 common 的作用域模型一致。"""
    return [_make_scope(node, kind)
            for _name, kind, node in function_scopes(source)]


def normalize_scope(scope: Scope) -> str:
    return " ".join(sorted(scope.fingerprint))


def scope_nodes(scope: Scope) -> int:
    return scope.nodes


def jaccard(lhs: set, rhs: set) -> float:
    """Jaccard 相似度;两个空集合的并集为空,按 0 分处理(无相似性可言)。"""
    union = lhs | rhs
    if not union:
        return 0.0
    return len(lhs & rhs) / len(union)


def _overlaps(lhs: Scope, rhs: Scope) -> bool:
    return not (lhs.end_line < rhs.start_line or rhs.end_line < lhs.start_line)


def find_duplicates(paths, threshold: float = DEFAULT_THRESHOLD,
                    min_lines: int = DEFAULT_MIN_LINES,
                    min_nodes: int = DEFAULT_MIN_NODES) -> list[Duplicate]:
    """报告指纹相似度达到阈值的配对(按相似度降序,同行域并列按行号)。"""
    return _compare_scopes(candidate_scopes(paths, min_lines, min_nodes), threshold)


def candidate_scopes(paths, min_lines: int, min_nodes: int) -> list[tuple[str, Scope]]:
    """参与成对比较的作用域:跳过不可读/不可解析文件与过小作用域。"""
    return [(file, scope)
            for file, source in read_sources(paths)
            for scope in _scopes_in(source)
            if _large_enough(scope, min_lines, min_nodes)]


def _scopes_in(source: str) -> list[Scope]:
    try:
        return scopes_from_source(source)
    except SyntaxError:
        return []


def _large_enough(scope: Scope, min_lines: int, min_nodes: int) -> bool:
    return (scope.end_line - scope.start_line + 1 >= min_lines
            and scope.nodes >= min_nodes)


def _compare_scopes(scopes, threshold: float) -> list[Duplicate]:
    """上三角成对比较;结果按相似度降序、并列按两侧行号。"""
    pairs: list[Duplicate] = []
    for (lhs_file, lhs), (rhs_file, rhs) in combinations(scopes, 2):
        if not _excluded_pair(lhs_file, rhs_file, lhs, rhs):
            _record_pair(pairs, lhs_file, lhs, rhs_file, rhs, threshold)
    pairs.sort(key=lambda pair: (-pair.score, pair.lhs.start_line,
                                 pair.rhs.start_line))
    return pairs


def _excluded_pair(lhs_file: str, rhs_file: str, lhs: Scope, rhs: Scope) -> bool:
    """同文件且行域重叠(父作用域与其嵌套子作用域)不成对比较。"""
    return lhs_file == rhs_file and _overlaps(lhs, rhs)


def _record_pair(pairs, lhs_file, lhs, rhs_file, rhs, threshold: float) -> None:
    score = jaccard(lhs.fingerprint, rhs.fingerprint)
    if score >= threshold:
        pairs.append(Duplicate(score=score, lhs_file=lhs_file, lhs=lhs,
                               rhs_file=rhs_file, rhs=rhs))

# mutate4py-manifest
# version=4
# projectHash=027d9eb00fd93a06
# scope.0.id=engine._scope_fingerprint
# scope.0.kind=function
# scope.0.startLine=52
# scope.0.endLine=56
# scope.0.semanticHash=20132480b057daf8
# scope.1.id=engine._collect_fingerprints
# scope.1.kind=function
# scope.1.startLine=59
# scope.1.endLine=67
# scope.1.semanticHash=dcf33ca481c52cd6
# scope.2.id=engine._make_scope
# scope.2.kind=function
# scope.2.startLine=70
# scope.2.endLine=79
# scope.2.semanticHash=8398a531204f3be4
# scope.3.id=engine.scopes_from_source
# scope.3.kind=function
# scope.3.startLine=82
# scope.3.endLine=85
# scope.3.semanticHash=9efa758c19d1849f
# scope.4.id=engine.normalize_scope
# scope.4.kind=function
# scope.4.startLine=88
# scope.4.endLine=89
# scope.4.semanticHash=903ef0bec65d2f99
# scope.5.id=engine.scope_nodes
# scope.5.kind=function
# scope.5.startLine=92
# scope.5.endLine=93
# scope.5.semanticHash=8e3c18dcf9ae37cb
# scope.6.id=engine.jaccard
# scope.6.kind=function
# scope.6.startLine=96
# scope.6.endLine=101
# scope.6.semanticHash=9b5af12acf576a49
# scope.7.id=engine._overlaps
# scope.7.kind=function
# scope.7.startLine=104
# scope.7.endLine=105
# scope.7.semanticHash=5f0b855a035fb613
# scope.8.id=engine.find_duplicates
# scope.8.kind=function
# scope.8.startLine=108
# scope.8.endLine=112
# scope.8.semanticHash=4870fb389a53042a
# scope.9.id=engine.candidate_scopes
# scope.9.kind=function
# scope.9.startLine=115
# scope.9.endLine=120
# scope.9.semanticHash=7bd7f70bc8f7e6e7
# scope.10.id=engine._scopes_in
# scope.10.kind=function
# scope.10.startLine=123
# scope.10.endLine=127
# scope.10.semanticHash=72070dd71b6bafb7
# scope.11.id=engine._large_enough
# scope.11.kind=function
# scope.11.startLine=130
# scope.11.endLine=132
# scope.11.semanticHash=b6612f3749513bc3
# scope.12.id=engine._compare_scopes
# scope.12.kind=function
# scope.12.startLine=135
# scope.12.endLine=143
# scope.12.semanticHash=6f3d81f7eafeae57
# scope.13.id=engine._excluded_pair
# scope.13.kind=function
# scope.13.startLine=146
# scope.13.endLine=148
# scope.13.semanticHash=557b580b6c4636ce
# scope.14.id=engine._record_pair
# scope.14.kind=function
# scope.14.startLine=151
# scope.14.endLine=155
# scope.14.semanticHash=bbc384b26dc9cb70
