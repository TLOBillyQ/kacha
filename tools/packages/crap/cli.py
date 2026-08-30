"""crap 子命令 —— CRAP 热点分析。

用法:
  python tools/cli.py crap [--top N] [--json] [--gate] [--gate-threshold N]
                           [--source PATH]

流程(collect + report 单趟,相对 lua 版 collect/report/summary 拆分的有意收敛):
1. coverage erase(清残留产物)
2. coverage run --source=src -m pytest(插桩跑全套测试)
3. coverage json -o .toolcache/coverage.json(标准产物)
4. 解析产物 -> 圈复杂度 -> 覆盖率归因 -> CRAP 公式 -> 排序输出

步骤 1-3 由 ..covdata 适配层持有(与 mutate 共用),本模块只做参数、策略与报告。

退出码:0 成功 / 1 业务失败(无 coverage 产物、coverage 未安装)/ 2 门禁失败或用法错误。
门禁(--gate):任一非空 CRAP 超过 --gate-threshold(默认 5.0)即退出码 2。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

from .. import covdata
from ..common import Flag, Value, as_float, as_int, parse_tokens, project_python, \
    read_sources, relative_path, repo_root_from, wants_help
from . import engine

run = subprocess.run

DEFAULT_GATE_THRESHOLD = 5.0

_FLAGS = (Flag("--json", "json"), Flag("--gate", "gate"))
_VALUES = (Value("--top", "top", as_int),
           Value("--gate-threshold", "gate_threshold", as_float),
           Value("--source", "source"))


def usage() -> str:
    return (
        "用法: python tools/cli.py crap [options] [--source PATH]\n"
        "\n"
        "CRAP = CC^2 x (1 - cov)^3 + CC;风险带 1-5 low / 5-30 moderate / 30+ high。\n"
        "  --top N               只显示 CRAP 最高的 N 个条目\n"
        "  --json                输出 JSON 报告\n"
        "  --gate                任一 CRAP 超过阈值即退出码 2\n"
        "  --gate-threshold N    门禁阈值(默认 5.0)\n"
    )


def main(args, env=None, run_shell=run) -> int:
    repo_root = repo_root_from(env)
    if wants_help(args):
        sys.stdout.write(usage())
        return 0
    options, _paths, error = parse_tokens(args, flags=_FLAGS, values=_VALUES)
    if error:
        sys.stderr.write(f"{error}\n\n{usage()}")
        return 2
    source, code = _source_dir(options, repo_root)
    if source is None:
        return code
    entries, code = _analyze(repo_root, source, run_shell)
    if code:
        return code
    _print_report(entries, options.get("top"), bool(options.get("json")), repo_root)
    return _apply_gate(options, entries)


def _source_dir(options, repo_root: str) -> tuple[str | None, int]:
    """--source 指定的被测目录;缺省 <repo_root>/src;不存在即业务失败(1)。"""
    source = options.get("source") or os.path.join(repo_root,
                                                   covdata.DEFAULT_SOURCE)
    if not os.path.isdir(source):
        sys.stderr.write(f"error: source directory not found: {source}\n")
        return None, 1
    return source, 0


def _apply_gate(options, entries) -> int:
    if not options.get("gate"):
        return 0
    return _gate(entries, options.get("gate_threshold", DEFAULT_GATE_THRESHOLD))


def _analyze(repo_root: str, source: str, run_shell) -> tuple[list[dict], int]:
    """插桩跑测试 -> 读标准产物 -> 构建报告;返回 (条目, 退出码)。"""
    collection = covdata.collect(project_python(repo_root), repo_root, source,
                                 run_shell)
    if not collection.artifact_ok:
        sys.stderr.write("error: coverage run failed "
                         "(is coverage installed in the project python?)\n")
        return [], 1
    if collection.tests_failed:
        sys.stderr.write("warning: tests failed under coverage; "
                         "continuing with partial coverage data\n")
    artifact = covdata.artifact_path(repo_root)
    if not os.path.isfile(artifact):
        sys.stderr.write(f"error: coverage artifact missing: {artifact}\n")
        return [], 1
    try:
        coverage = covdata.load(repo_root)
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"error: cannot read coverage artifact: {exc}\n")
        return [], 1
    return engine.build_report(_scan_files(source), coverage), 0


def _scan_files(source_path: str) -> list[tuple[str, str]]:
    """报告按绝对路径归因覆盖率,故在此把读取结果提升为绝对路径。"""
    return [(os.path.abspath(path), source)
            for path, source in read_sources([source_path])]


def _print_report(entries: list[dict], top: int | None, as_json: bool,
                  repo_root: str) -> None:
    shown = entries[:top]
    if as_json:
        _print_json(shown, repo_root)
        return
    if not shown:
        sys.stdout.write("No CRAP hotspots.\n")
        return
    for entry in shown:
        sys.stdout.write(_entry_line(entry, repo_root) + "\n")


def _print_json(shown, repo_root: str) -> None:
    payload = {"entries": [_entry_view(entry, repo_root) for entry in shown]}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _entry_view(entry: dict, repo_root: str) -> dict:
    return {
        "file": relative_path(entry["file"], repo_root), "name": entry["name"],
        "kind": entry["kind"], "start": entry["start"], "end": entry["end"],
        "cc": entry["cc"], "coverage": entry["coverage"], "crap": entry["crap"],
        "band": entry["band"],
    }


def _entry_line(entry: dict, repo_root: str) -> str:
    cov = "N/A" if entry["coverage"] is None else f"{entry['coverage']:.0%}"
    score = "N/A" if entry["crap"] is None else f"{entry['crap']:.2f}"
    return (f"{relative_path(entry['file'], repo_root)}:{entry['start']}:"
            f"{entry['name']} CC={entry['cc']} cov={cov} CRAP={score} "
            f"({entry['band']})")


def _gate(entries: list[dict], threshold: float) -> int:
    """任一非空 CRAP 超阈值即门禁失败(退出码 2)。"""
    max_crap = max((entry["crap"] for entry in entries if entry["crap"] is not None),
                   default=0.0)
    if max_crap > threshold:
        sys.stderr.write(f"crap gate failed: max CRAP {max_crap:.2f} > "
                         f"{threshold:.2f}\n")
        return 2
    return 0
