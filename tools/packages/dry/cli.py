"""dry 子命令 —— 结构重复检测。

用法:
  python tools/cli.py dry [options] [file-or-directory ...]

options:
  --threshold N    相似度阈值(默认 0.82)
  --min-lines N    作用域最小行数(默认 4)
  --min-nodes N    作用域最小归一化节点数(默认 20)
  --format FMT     text | json(默认 text);未知格式退出码 2
  --limit N        最多输出的配对数量

无路径参数时扫描 <repo_root>/src(不存在则整个 repo_root)。
退出码:0 成功 / 2 用法错误(未知格式、坏数值选项)。
"""

from __future__ import annotations

import json
import os
import sys

from ..common import (POSITIONAL_ANY, Value, as_float, as_int, parse_tokens,
                      relative_path, repo_root_from, wants_help)
from . import engine

DEFAULT_THRESHOLD = engine.DEFAULT_THRESHOLD
DEFAULT_MIN_LINES = engine.DEFAULT_MIN_LINES
DEFAULT_MIN_NODES = engine.DEFAULT_MIN_NODES

_FORMATS = ("text", "json")

_VALUES = (Value("--threshold", "threshold", as_float),
           Value("--min-lines", "min_lines", as_int),
           Value("--min-nodes", "min_nodes", as_int),
           Value("--format", "output_format"),
           Value("--limit", "limit", as_int))


def usage() -> str:
    return (
        "用法: python tools/cli.py dry [options] [file-or-directory ...]\n"
        "\n"
        "结构重复检测:AST 归一化指纹 + Jaccard 相似度。\n"
        "  --threshold N    similarity threshold (default 0.82)\n"
        "  --min-lines N    minimum scope lines (default 4)\n"
        "  --min-nodes N    minimum normalized nodes (default 20)\n"
        "  --format FMT     text | json (default text)\n"
        "  --limit N        cap reported pairs\n"
    )


def main(args, env=None) -> int:
    repo_root = repo_root_from(env)
    if wants_help(args):
        sys.stdout.write(usage())
        return 0
    options, paths, failure = _parse(args)
    if failure:
        sys.stderr.write(f"{failure}\n\n{usage()}")
        return 2
    pairs = engine.find_duplicates(paths or _default_paths(repo_root),
                                   **_limits(options))
    _print_pairs(pairs[:options.get("limit")], options["output_format"],
                 repo_root)
    return 0


def _parse(args):
    """共享走查 + 输出格式校验;返回 (options, paths, 错误正文)。"""
    options, paths, error = parse_tokens(args, flags=(), values=_VALUES,
                                         positional=POSITIONAL_ANY)
    output_format = options.get("output_format", "text")
    options["output_format"] = output_format
    return options, paths, (error
                            or (None if output_format in _FORMATS
                                else f"未知格式: {output_format}"))


def _limits(options) -> dict:
    """引擎阈值参数(缺省沿用 dry 默认值)。"""
    return {"threshold": options.get("threshold", DEFAULT_THRESHOLD),
            "min_lines": options.get("min_lines", DEFAULT_MIN_LINES),
            "min_nodes": options.get("min_nodes", DEFAULT_MIN_NODES)}


def _default_paths(repo_root: str) -> list[str]:
    src = os.path.join(repo_root, "src")
    return [src if os.path.isdir(src) else repo_root]


def _print_pairs(pairs, output_format: str, repo_root: str) -> None:
    if output_format == "json":
        payload = {"pairs": [_pair_view(pair, repo_root) for pair in pairs]}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return
    if not pairs:
        sys.stdout.write("No duplicate candidates found.\n")
        return
    for pair in pairs:
        _print_pair(pair, repo_root)


def _pair_view(pair, repo_root: str) -> dict:
    return {"score": round(pair.score, 4),
            "a": _scope_view(pair.lhs_file, pair.lhs, repo_root),
            "b": _scope_view(pair.rhs_file, pair.rhs, repo_root)}


def _scope_view(path: str, scope: engine.Scope, repo_root: str) -> dict:
    return {"file": relative_path(path, repo_root),
            "start": scope.start_line, "end": scope.end_line, "name": scope.name}


def _print_pair(pair, repo_root: str) -> None:
    lhs = _scope_view(pair.lhs_file, pair.lhs, repo_root)
    rhs = _scope_view(pair.rhs_file, pair.rhs, repo_root)
    sys.stdout.write(f"DUPLICATE score={pair.score:.2f}\n")
    for side in (lhs, rhs):
        sys.stdout.write(f"  {side['file']}:{side['start']}-{side['end']}\n")
