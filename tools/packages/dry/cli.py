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
退出码:0 成功 / 2 用法错误(未知格式)。
"""

from __future__ import annotations

import json
import os
import sys

from . import engine


def _usage() -> str:
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


def usage() -> str:
    return _usage()


def _parse_number(name, value):
    try:
        return float(value)
    except ValueError:
        sys.stderr.write(f"error: {name} requires a numeric value\n")
        raise SystemExit(2)


def main(args, env=None) -> int:
    env = dict(env or {})
    repo_root = env.get("repo_root") or os.getcwd()
    threshold, min_lines, min_nodes, output_format, limit = 0.82, 4, 20, "text", None
    paths: list[str] = []

    index = 0
    while index < len(args):
        token = args[index]
        if token in ("--help", "-h"):
            sys.stdout.write(_usage())
            return 0
        if token == "--threshold":
            threshold = _parse_number(token, args[index + 1]); index += 2
        elif token == "--min-lines":
            min_lines = int(_parse_number(token, args[index + 1])); index += 2
        elif token == "--min-nodes":
            min_nodes = int(_parse_number(token, args[index + 1])); index += 2
        elif token == "--format":
            output_format = args[index + 1]; index += 2
        elif token == "--limit":
            limit = int(_parse_number(token, args[index + 1])); index += 2
        else:
            paths.append(token); index += 1

    if output_format not in ("text", "json"):
        sys.stderr.write(f"未知格式: {output_format}\n\n{_usage()}")
        return 2

    if not paths:
        src = os.path.join(repo_root, "src")
        paths = [src if os.path.isdir(src) else repo_root]

    pairs = engine.find_duplicates(paths, threshold=threshold,
                                   min_lines=min_lines, min_nodes=min_nodes)
    if limit is not None:
        pairs = pairs[:limit]

    def show(path: str, scope: engine.Scope) -> dict:
        relative = os.path.relpath(path, repo_root)
        if relative.startswith(".."):
            relative = path
        return {"file": relative, "start": scope.start_line, "end": scope.end_line,
                "name": scope.name}

    if output_format == "json":
        payload = {"pairs": [
            {"score": round(pair.score, 4),
             "a": show(pair.lhs_file, pair.lhs), "b": show(pair.rhs_file, pair.rhs)}
            for pair in pairs]}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    if not pairs:
        sys.stdout.write("No duplicate candidates found.\n")
        return 0
    for pair in pairs:
        lhs = show(pair.lhs_file, pair.lhs)
        rhs = show(pair.rhs_file, pair.rhs)
        sys.stdout.write(f"DUPLICATE score={pair.score:.2f}\n")
        sys.stdout.write(f"  {lhs['file']}:{lhs['start']}-{lhs['end']}\n")
        sys.stdout.write(f"  {rhs['file']}:{rhs['start']}-{rhs['end']}\n")
    return 0
