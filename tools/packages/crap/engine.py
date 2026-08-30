"""crap4py —— CRAP(Change Risk Anti-Patterns)热点分析(crap4clj/go/java 的 Python 移植)。

对齐不变量:
- CRAP 公式 CC² × (1 - cov)³ + CC;覆盖率缺失时得分为空(N/A),绝不当作 0
- 风险带 1-5 low / 5-30 moderate / 30+ high
- 五阶段骨架:查找源文件 -> 解析函数边界 -> 计算圈复杂度
  -> 将覆盖率归因到函数 -> 排序输出
- 覆盖率仅来自 coverage.py 的固定产物:coverage json(luacov 的 Python 对应),
  取数与读文件由 ..covdata 适配层承担,本模块只做纯分析
- 分母 = 作用域行域 ∩ coverage 实测语句行(executed ∪ missing):续行、docstring
  与 pragma 排除行都不计入,否则多行语句会被当成未执行而虚高 CRAP

圈复杂度基于真实 Python AST 计算:基线 1,每个决策点 +1(if/elif、for/async for、
while、except handler、with/async with、assert、and/or、三元、推导式、match/case)。
"""

from __future__ import annotations

import ast
import dataclasses

from .. import covdata
from ..astnorm import FUNCTION_NODES, child_nodes, function_scopes

_DECISION_NODES = (ast.If, ast.For, ast.AsyncFor, ast.While,
                   ast.ExceptHandler, ast.With, ast.AsyncWith, ast.Assert,
                   ast.BoolOp, ast.IfExp, ast.ListComp, ast.SetComp,
                   ast.DictComp, ast.GeneratorExp, ast.Match,
                   getattr(ast, "match_case", ast.Match))


@dataclasses.dataclass
class Scope:
    name: str
    kind: str  # function | method
    start_line: int
    end_line: int
    node: ast.FunctionDef


def scopes_from_source(source: str) -> list[Scope]:
    """作用域边界取自共享作用域模型(模块级函数 + 类方法)。"""
    return [Scope(name=name, kind=kind, start_line=node.lineno,
                  end_line=getattr(node, "end_lineno", node.lineno), node=node)
            for name, kind, node in function_scopes(source)]


def cyclomatic_complexity(scope: Scope) -> int:
    """基 1 + 决策点数;嵌套函数体不计入外层。"""
    return 1 + _decisions_in(scope.node)


def _decisions_in(node, is_scope_root: bool = True) -> int:
    """统计本作用域的决策点;再次遇到函数/协程定义即视为嵌套,整体跳过。"""
    if not is_scope_root and isinstance(node, FUNCTION_NODES):
        return 0
    own = 1 if isinstance(node, _DECISION_NODES) else 0
    return own + sum(_decisions_in(child, False)
                     for _field, _index, child in child_nodes(node))


def _statement_lines(node: ast.AST) -> set[int]:
    """语句节点自身覆盖的行区间。"""
    start = getattr(node, "lineno", None)
    end = getattr(node, "end_lineno", start)
    if start is None:
        return set()
    return set(range(start, end + 1))


#: 嵌套定义不属于本作用域的执行体
_NESTED_DEFINITIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def executable_lines(scope: Scope) -> set[int]:
    """函数行域:函数体顶层语句覆盖的行,排除嵌套函数/类定义体。

    这只是"候选"行域;真正的分母还要与 coverage 实测语句行求交(见 build_report),
    多行语句的续行与 pragma 排除行都不在实测集合里。
    """
    lines: set[int] = set()
    for stmt in scope.node.body:
        if isinstance(stmt, _NESTED_DEFINITIONS):
            continue
        lines |= _statement_lines(stmt)
    return lines


def crap(cc: int, coverage: float | None) -> float | None:
    """CRAP = CC² × (1 - cov)³ + CC;覆盖率缺失时为 None(N/A)。"""
    if coverage is None:
        return None
    return round(cc * cc * (1 - coverage) ** 3 + cc, 4)


def risk_band(score: float | None) -> str:
    if score is None or score < 5:
        return "low"
    if score < 30:
        return "moderate"
    return "high"


def build_report(files: list[tuple[str, str]], coverage: dict) -> list[dict]:
    """files: [(path, source)];coverage: 已归一化的 coverage json files 字典。

    返回 [{file, name, kind, start, end, cc, coverage, crap, band}],按 CRAP 降序,
    缺失覆盖率(N/A)沉底。
    """
    report: list[dict] = []
    for file_path, source in files:
        try:
            scopes = scopes_from_source(source)
        except SyntaxError:
            continue
        data = covdata.file_data(coverage, file_path)
        report.extend(_file_entries(file_path, data, scopes))
    return sort_report(report)


def _file_entries(file_path: str, data, scopes: list[Scope]) -> list[dict]:
    """单文件的作用域条目:覆盖率 = 实测语句行里的已执行占比。"""
    entries = []
    for scope in scopes:
        cc = cyclomatic_complexity(scope)
        cov = _scope_coverage(scope, data)
        score = crap(cc, cov)
        entries.append({
            "file": file_path, "name": scope.name, "kind": scope.kind,
            "start": scope.start_line, "end": scope.end_line, "cc": cc,
            "coverage": (round(cov, 4) if cov is not None else None),
            "crap": score, "band": risk_band(score),
        })
    return entries


def _scope_coverage(scope: Scope, data) -> float | None:
    """无该文件数据或没有可归因语句时为 None(N/A),绝不当作 0。"""
    if data is None:
        return None
    measured = data.measured & executable_lines(scope)
    if not measured:
        return None
    return len(data.executed & measured) / len(measured)


def sort_report(entries: list[dict]) -> list[dict]:
    scored = sorted((e for e in entries if e["crap"] is not None),
                    key=lambda e: (-e["crap"], e["file"], e["name"]))
    unscored = sorted((e for e in entries if e["crap"] is None),
                      key=lambda e: (e["file"], e["name"]))
    return scored + unscored
