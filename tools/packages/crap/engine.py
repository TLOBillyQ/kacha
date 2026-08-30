"""crap4py —— CRAP(Change Risk Anti-Patterns)热点分析(crap4clj/go/java 的 Python 移植)。

对齐不变量:
- CRAP 公式 CC² × (1 - cov)³ + CC;覆盖率缺失时得分为空(N/A),绝不当作 0
- 风险带 1-5 low / 5-30 moderate / 30+ high
- 五阶段骨架:查找源文件 -> 解析函数边界 -> 计算圈复杂度
  -> 将覆盖率归因到函数 -> 排序输出
- 覆盖率仅来自 coverage.py 的固定产物:coverage json(luacov 的 Python 对应)

圈复杂度基于真实 Python AST 计算:基线 1,每个决策点 +1(if/elif、for/async for、
while、except handler、with/async with、assert、and/or、三元、推导式、match/case)。
"""

from __future__ import annotations

import ast
import dataclasses

from ..common import functions_from_source

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
    return [
        Scope(name=name, kind=kind, start_line=node.lineno,
              end_line=getattr(node, "end_lineno", node.lineno), node=node)
        for name, kind, node in functions_from_source(source)
    ]


def cyclomatic_complexity(scope: Scope) -> int:
    """基 1 + 决策点数;嵌套函数体不计入外层。"""
    count = 1

    def walk(node, in_nested: bool):
        nonlocal count
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if in_nested:
                return
            in_nested = True
        if isinstance(node, _DECISION_NODES):
            count += 1
        for _field, value in ast.iter_fields(node):
            if isinstance(value, ast.AST):
                walk(value, in_nested)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, ast.AST):
                        walk(item, in_nested)

    walk(scope.node, False)
    return count


def _statement_lines(node: ast.AST) -> set[int]:
    """语句节点自身覆盖的行区间。"""
    start = getattr(node, "lineno", None)
    end = getattr(node, "end_lineno", start)
    if start is None:
        return set()
    return set(range(start, end + 1))


def executable_lines(scope: Scope) -> set[int]:
    """函数可执行行:函数体语句行,排除嵌套函数/类定义体。"""
    lines: set[int] = set()
    nested = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
    for stmt in scope.node.body:
        if isinstance(stmt, nested):
            continue
        lines |= _statement_lines(stmt)
    return lines


def crap(cc: int, coverage: float | None) -> float | None:
    """CRAP = CC² × (1 - cov)³ + CC;覆盖率缺失时为 None(N/A)。"""
    if coverage is None:
        return None
    return round(cc * cc * (1 - coverage) ** 3 + cc, 4)


def risk_band(score: float) -> str:
    if score is None or score < 5:
        return "low"
    if score < 30:
        return "moderate"
    return "high"


def _load_coverage_data(path: str) -> dict:
    import json

    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    files = payload.get("files", {})
    return {str(key): value for key, value in files.items()}


def _coverage_for(coverage: dict, file_path: str) -> tuple[set[int], bool]:
    """返回 (executed_lines, 有该文件数据);匹配绝对路径或后缀。"""
    target = file_path
    if target in coverage:
        entry = coverage[target]
        return set(entry.get("executed_lines", [])), True
    tail = "/" + target
    for key, entry in coverage.items():
        if key.endswith(tail):
            return set(entry.get("executed_lines", [])), True
    return set(), False


def build_report(files: list[tuple[str, str]], coverage: dict) -> list[dict]:
    """files: [(path, source)];coverage: coverage json 的 files 字典。

    返回 [{file, name, kind, start, end, cc, coverage, crap, band}],按 CRAP 降序,
    缺失覆盖率(N/A)沉底。
    """
    report: list[dict] = []
    for file_path, source in files:
        try:
            scopes = scopes_from_source(source)
        except SyntaxError:
            continue
        executed, present = _coverage_for(coverage, file_path)
        for scope in scopes:
            executable = executable_lines(scope)
            cc = cyclomatic_complexity(scope)
            if not executable:
                cov = None
            elif not present:
                cov = None
            else:
                cov = len(executed & executable) / len(executable)
            score = crap(cc, cov)
            report.append({
                "file": file_path, "name": scope.name, "kind": scope.kind,
                "start": scope.start_line, "end": scope.end_line,
                "cc": cc, "coverage": (round(cov, 4) if cov is not None else None),
                "crap": score, "band": risk_band(score),
            })
    return sort_report(report)


def sort_report(entries: list[dict]) -> list[dict]:
    scored = sorted((e for e in entries if e["crap"] is not None),
                    key=lambda e: (-(e["crap"] or 0.0), e["file"], e["name"]))
    unscored = sorted((e for e in entries if e["crap"] is None),
                      key=lambda e: (e["file"], e["name"]))
    return scored + unscored
