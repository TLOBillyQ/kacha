"""crap 子命令 —— CRAP 热点分析。

用法:
  python tools/cli.py crap [--top N] [--json] [--gate] [--gate-threshold N]
                           [--source PATH]

流程(collect + report 单趟,相对 lua 版 collect/report/summary 拆分的有意收敛):
1. coverage erase(清残留产物)
2. coverage run --source=src -m pytest(插桩跑全套测试)
3. coverage json -o .toolcache/coverage.json(标准产物)
4. 解析产物 -> 圈复杂度 -> 覆盖率归因 -> CRAP 公式 -> 排序输出

退出码:0 成功 / 1 业务失败(无 coverage 产物、coverage 未安装)/ 2 门禁失败或用法错误。
门禁(--gate):任一非空 CRAP 超过 --gate-threshold(默认 5.0)即退出码 2。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

from ..common import project_python
from . import engine

run = subprocess.run


def _usage() -> str:
    return (
        "用法: python tools/cli.py crap [options] [--source PATH]\n"
        "\n"
        "CRAP = CC^2 x (1 - cov)^3 + CC;风险带 1-5 low / 5-30 moderate / 30+ high。\n"
        "  --top N               只显示 CRAP 最高的 N 个条目\n"
        "  --json                输出 JSON 报告\n"
        "  --gate                任一 CRAP 超过阈值即退出码 2\n"
        "  --gate-threshold N    门禁阈值(默认 5.0)\n"
    )


def usage() -> str:
    return _usage()


def _collect(python: str, repo_root: str, source: str, run_shell=run):
    """插桩跑测试并产出 .toolcache/coverage.json;失败返回退出码。"""
    for argv in (
        [python, "-m", "coverage", "erase"],
        [python, "-m", "coverage", "run", f"--source={source}", "-m", "pytest"],
        [python, "-m", "coverage", "json", "-o",
         os.path.join(repo_root, ".toolcache", "coverage.json")],
    ):
        result = run_shell(argv, cwd=repo_root)
        if result.returncode != 0:
            return result.returncode
    return 0


def _scan_files(source_path: str) -> list[tuple[str, str]]:
    files: list[tuple[str, str]] = []
    for root, _dirs, names in os.walk(source_path):
        for name in sorted(names):
            if not name.endswith(".py"):
                continue
            file_path = os.path.join(root, name)
            try:
                with open(file_path, encoding="utf-8") as handle:
                    files.append((os.path.abspath(file_path), handle.read()))
            except OSError:
                continue
    return files


def _print_report(entries: list[dict], top: int | None, as_json: bool,
                  repo_root: str) -> None:
    shown = entries if top is None else entries[:top]
    if as_json:
        payload = {"entries": [{
            "file": os.path.relpath(e["file"], repo_root), "name": e["name"],
            "kind": e["kind"], "start": e["start"], "end": e["end"],
            "cc": e["cc"], "coverage": e["coverage"], "crap": e["crap"],
            "band": e["band"],
        } for e in shown]}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return
    if not shown:
        sys.stdout.write("No CRAP hotspots.\n")
        return
    for entry in shown:
        cov = "N/A" if entry["coverage"] is None else f"{entry['coverage']:.0%}"
        score = "N/A" if entry["crap"] is None else f"{entry['crap']:.2f}"
        relative = os.path.relpath(entry["file"], repo_root)
        sys.stdout.write(
            f"{relative}:{entry['start']}:{entry['name']} "
            f"CC={entry['cc']} cov={cov} CRAP={score} ({entry['band']})\n")


def main(args, env=None, run_shell=run) -> int:
    if any(arg in ("--help", "-h") for arg in args):
        sys.stdout.write(_usage())
        return 0
    env = dict(env or {})
    repo_root = env.get("repo_root") or os.getcwd()
    top, as_json, gate = None, False, False
    gate_threshold, source = 5.0, os.path.join(repo_root, "src")

    index = 0
    while index < len(args):
        token = args[index]
        if token == "--top":
            top = int(args[index + 1]); index += 2
        elif token == "--json":
            as_json = True; index += 1
        elif token == "--gate":
            gate = True; index += 1
        elif token == "--gate-threshold":
            gate_threshold = float(args[index + 1]); index += 2
        elif token == "--source":
            source = args[index + 1]; index += 2
        else:
            sys.stderr.write(f"未知参数: {token}\n\n{_usage()}")
            return 2

    if not os.path.isdir(source):
        sys.stderr.write(f"error: source directory not found: {source}\n")
        return 1

    python = project_python(repo_root)
    code = _collect(python, repo_root, source, run_shell)
    if code != 0:
        sys.stderr.write("error: coverage run failed "
                         "(is coverage installed in the project python?)\n")
        return 1

    artifact = os.path.join(repo_root, ".toolcache", "coverage.json")
    if not os.path.isfile(artifact):
        sys.stderr.write(f"error: coverage artifact missing: {artifact}\n")
        return 1
    try:
        coverage = engine._load_coverage_data(artifact)
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"error: cannot read coverage artifact: {exc}\n")
        return 1
    # coverage json 的键是相对 cwd(仓库根)的路径,统一归一化为绝对路径
    coverage = {
        (os.path.abspath(os.path.join(repo_root, key)) if not os.path.isabs(key)
         else key): value
        for key, value in coverage.items()
    }

    entries = engine.build_report(_scan_files(source), coverage)
    _print_report(entries, top, as_json, repo_root)

    if gate:
        max_crap = max((e["crap"] for e in entries if e["crap"] is not None),
                       default=0.0)
        if max_crap > gate_threshold:
            sys.stderr.write(
                f"crap gate failed: max CRAP {max_crap:.2f} > "
                f"{gate_threshold:.2f}\n")
            return 2
    return 0
