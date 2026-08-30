"""mutate 子命令 —— 单文件变异测试。

用法:
  python tools/cli.py mutate <file.py> [--scan|--update-manifest|--since-last-run|
      --mutate-all|--lines N,N|--reuse-coverage|--max-workers N|
      --timeout-factor N|--test-command CMD|--mutation-warning N|--verbose]

退出码:0 无存活 mutant(干净运行后写 manifest)/ 1 用法错误 / 2 baseline 失败 /
3 存在存活 mutant。

测试经项目 pytest 运行(--test-command 为逃生舱,禁用覆盖率过滤);worker 在
.toolcache/ 下的项目副本中运行,原始文件永不在原地变异。
"""

from __future__ import annotations

import ast
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..common import project_python
from . import engine, manifest

run = subprocess.run

_IGNORE_PATTERNS = shutil.ignore_patterns(
    ".git", ".venv", ".venv-win", ".swarmforge", ".worktrees", ".toolcache",
    "__pycache__", "tmp", "node_modules", ".pytest_cache")


def _usage() -> str:
    return (
        "用法: python tools/cli.py mutate <file.py> [options]\n"
        "\n"
        "子命令:\n"
        "  (default)          运行变异测试\n"
        "  --scan             扫描变异位点\n"
        "  --update-manifest  写入 embedded manifest footer\n"
        "\n"
        "选项:\n"
        "  --mutate-all               忽略 manifest 变异所有位点\n"
        "  --since-last-run           只变异与 manifest 不同的 scope\n"
        "  --lines N,N                限制行号\n"
        "  --reuse-coverage           复用覆盖率缓存(按项目哈希判鲜)\n"
        "  --max-workers N            并行 worker 数(默认 CPU 核数一半,1=串行)\n"
        "  --timeout-factor N         超时倍数(默认 10)\n"
        "  --test-command CMD         自定义测试命令\n"
        "  --mutation-warning N       变异数量警告阈值(默认 50)\n"
        "  --verbose                  详细输出\n"
        "  -h, --help                 显示帮助\n"
    )


def usage() -> str:
    return _usage()


def _parse_options(args):
    options = {
        "target": None, "subcommand": "mutate", "scan": False,
        "update_manifest": False, "mutate_all": False, "since_last_run": False,
        "reuse_coverage": False, "line_set": None, "max_workers": None,
        "timeout_factor": 10, "test_command": None, "mutation_warning": 50,
        "verbose": False, "help": False,
    }
    index = 0
    while index < len(args):
        token = args[index]
        if token in ("--help", "-h"):
            options["help"] = True
        elif token == "--scan":
            options["scan"] = True
            options["subcommand"] = "scan"
        elif token == "--update-manifest":
            options["update_manifest"] = True
            options["subcommand"] = "update-manifest"
        elif token == "--mutate-all":
            options["mutate_all"] = True
        elif token == "--since-last-run":
            options["since_last_run"] = True
        elif token == "--reuse-coverage":
            options["reuse_coverage"] = True
        elif token == "--verbose":
            options["verbose"] = True
        elif token == "--lines":
            index += 1
            options["line_set"] = _parse_line_set(args[index] if index < len(args) else "")
        elif token == "--max-workers":
            index += 1
            options["max_workers"] = int(args[index] if index < len(args) else 0)
        elif token == "--timeout-factor":
            index += 1
            options["timeout_factor"] = float(args[index] if index < len(args) else 0)
        elif token == "--test-command":
            index += 1
            options["test_command"] = args[index] if index < len(args) else ""
        elif token == "--mutation-warning":
            index += 1
            options["mutation_warning"] = int(args[index] if index < len(args) else 0)
        elif options["target"] is None and not token.startswith("--"):
            options["target"] = token
        else:
            raise ValueError(f"unknown option: {token}")
        index += 1
    return options


def _parse_line_set(text: str) -> set[int]:
    lines = set()
    for number in text.split(","):
        number = number.strip()
        if not number:
            continue
        lines.add(int(number))
    if not lines:
        raise ValueError("--lines requires a comma-separated list of line numbers")
    return lines


_CONFLICTS = (
    ("scan", "since_last_run", "--scan cannot be combined with --since-last-run"),
    ("scan", "mutate_all", "--scan cannot be combined with --mutate-all"),
    ("scan", "update_manifest", "--scan cannot be combined with --update-manifest"),
    ("scan", "reuse_coverage", "--scan cannot be combined with --reuse-coverage"),
    ("line_set", "since_last_run", "--lines cannot be combined with --since-last-run"),
    ("line_set", "mutate_all", "--lines cannot be combined with --mutate-all"),
    ("line_set", "update_manifest", "--lines cannot be combined with --update-manifest"),
    ("since_last_run", "mutate_all", "--since-last-run cannot be combined with --mutate-all"),
    ("update_manifest", "since_last_run", "--update-manifest cannot be combined with --since-last-run"),
    ("update_manifest", "mutate_all", "--update-manifest cannot be combined with --mutate-all"),
    ("update_manifest", "reuse_coverage", "--update-manifest cannot be combined with --reuse-coverage"),
)


def _conflict(options) -> str | None:
    for first, second, message in _CONFLICTS:
        if options.get(first) and options.get(second):
            return message
    return None


def _read_target(repo_root: str, target: str) -> tuple[str, str]:
    abs_target = target if os.path.isabs(target) else os.path.join(repo_root, target)
    abs_target = os.path.abspath(abs_target)
    with open(abs_target, encoding="utf-8") as handle:
        source = handle.read()
    relative = os.path.relpath(abs_target, repo_root)
    if relative.startswith(".."):
        raise ValueError("target file escapes workspace root")
    return abs_target, source


def _scopes_data(scopes):
    return [{"id": scope.id, "kind": scope.kind, "start_line": scope.start_line,
             "end_line": scope.end_line, "semantic_hash": scope.semantic_hash}
            for scope in scopes]


def _coverage_for_target(repo_root: str, proj_hash: str, target_rel: str,
                         options, run_shell, python, verbose) -> set[int] | None:
    """返回目标文件已覆盖行;失败返回 None(不过滤)。"""
    cache = os.path.join(repo_root, ".toolcache", "mutate4py-coverage.json")
    artifact = os.path.join(repo_root, ".toolcache", "coverage.json")
    import json

    if options.get("reuse_coverage") and os.path.isfile(cache):
        try:
            with open(cache, encoding="utf-8") as handle:
                payload = json.load(handle)
            if payload.get("projectHash") == proj_hash:
                lines = payload.get("covered", {}).get(target_rel)
                if lines is not None:
                    sys.stdout.write("reusing coverage cache\n")
                    return set(lines)
        except (OSError, ValueError):
            pass
    commands = (
        [python, "-m", "coverage", "erase"],
        [python, "-m", "coverage", "run", "--source=src", "-m", "pytest"],
        [python, "-m", "coverage", "json", "-o", artifact],
    )
    for command in commands:
        result = run_shell(command, cwd=repo_root)
        if result.returncode != 0:
            sys.stderr.write("warning: coverage pass failed; treating all "
                             "sites as covered\n")
            return None
    try:
        with open(artifact, encoding="utf-8") as handle:
            payload = json.load(handle)
        files = payload.get("files", {})
        executed: set[int] | None = None
        abs_target = os.path.abspath(os.path.join(repo_root, target_rel))
        for key, entry in files.items():
            key_abs = os.path.abspath(os.path.join(repo_root, key)) if not os.path.isabs(key) else key
            if key_abs == abs_target or key_abs.endswith("/" + target_rel):
                executed = set(entry.get("executed_lines", []))
                break
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w", encoding="utf-8") as handle:
            json.dump({"projectHash": proj_hash,
                       "covered": {target_rel: sorted(executed or [])}}, handle)
        return executed
    except (OSError, ValueError):
        sys.stderr.write("warning: cannot read coverage artifact; treating "
                         "all sites as covered\n")
        return None


def _prepare_workspaces(repo_root: str, count: int) -> list[str]:
    base = os.path.join(repo_root, ".toolcache", "mutate4py")
    workspaces = []
    for index in range(count):
        ws = os.path.join(base, f"ws-{index}")
        if os.path.isdir(ws):
            shutil.rmtree(ws)
        shutil.copytree(repo_root, ws, ignore=_IGNORE_PATTERNS)
        workspaces.append(ws)
    return workspaces


def _test_command(options, python: str):
    if options.get("test_command"):
        return ["/bin/sh", "-c", options["test_command"]]
    return [python, "-m", "pytest"]


def _run_env(ws_root: str) -> dict:
    env = dict(os.environ)
    src = os.path.join(ws_root, "src")
    env["PYTHONPATH"] = src + os.pathsep + env.get("PYTHONPATH", "")
    return env


def _run_trial(ws_root, target_rel, original_source, site, command, timeout,
               run_shell, env) -> tuple[str, float]:
    path = os.path.join(ws_root, target_rel)
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(site.mutated_source(original_source))
        start = time.monotonic()
        try:
            result = run_shell(command, cwd=ws_root, env=env, timeout=timeout)
            outcome = "survived" if result.returncode == 0 else "killed"
        except subprocess.TimeoutExpired:
            outcome = "timeout"
        return outcome, round(time.monotonic() - start, 1)
    finally:
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(original_source)
        except OSError:
            pass


def main(args, env=None, run_shell=run) -> int:
    env = dict(env or {})
    repo_root = env.get("repo_root") or os.getcwd()
    try:
        options = _parse_options(args)
    except ValueError as exc:
        sys.stderr.write(f"error: {exc}\n\n{_usage()}")
        return 1

    if options["help"]:
        sys.stdout.write(_usage())
        return 0
    conflict = _conflict(options)
    if conflict:
        sys.stderr.write(f"error: {conflict}\n\n{_usage()}")
        return 1
    if not options["target"]:
        sys.stderr.write("error: target file required\n\n" + _usage())
        return 1

    try:
        abs_target, source = _read_target(repo_root, options["target"])
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1

    module_name = os.path.splitext(os.path.basename(abs_target))[0]
    stripped = manifest.strip(source)
    try:
        scopes, all_sites, suppressed_sites = engine.scan_module(stripped, module_name)
    except SyntaxError as exc:
        sys.stderr.write(f"error: cannot parse target: {exc}\n")
        return 1

    project_root = engine.find_root(repo_root, abs_target)
    old_manifest = manifest.read(abs_target)
    proj_hash = engine.project_hash(project_root, abs_target, stripped)
    module_hash_changed = old_manifest is None or old_manifest["project_hash"] != proj_hash
    changed_ids = {scope.id for scope in scopes
                   if old_manifest is None or engine.scope_changed(scope, old_manifest)}
    relative = os.path.relpath(abs_target, project_root)
    python = project_python(repo_root)
    verbose = options["verbose"]

    if options["subcommand"] == "scan":
        sys.stdout.write(f"file: {relative}\n")
        sys.stdout.write(f"sites: {len(all_sites)}\n")
        sys.stdout.write(f"suppressed equivalent sites: {suppressed_sites}\n")
        for site in all_sites:
            prefix = "* " if (old_manifest and site.scope_id in changed_ids) else "  "
            sys.stdout.write(f"{prefix}L{site.line} {site.description} "
                             f"(scope: {site.scope_id})\n")
        return 0

    if options["subcommand"] == "update-manifest":
        manifest.write(abs_target, stripped, {
            "version": 4, "project_hash": proj_hash, "scopes": _scopes_data(scopes)})
        sys.stdout.write(f"manifest updated: {relative}\n")
        return 0

    selected = engine.select_sites(all_sites, scopes, old_manifest, options,
                                   module_hash_changed)
    covered = None if options["test_command"] else _coverage_for_target(
        repo_root, proj_hash, relative, options, run_shell, python, verbose)
    if options["test_command"]:
        sys.stderr.write("warning: --test-command disables coverage filtering; "
                         "treating all sites as covered\n")
    filtered = [site for site in selected if covered is None or site.line in covered]
    uncovered = [site for site in selected if site not in filtered]
    differential, violating = engine.surface_areas(selected, scopes, old_manifest)

    sys.stdout.write(f"mutate4py: {relative}\n")
    sys.stdout.write(f"total mutation sites: {len(all_sites)}\n")
    sys.stdout.write(f"covered mutation sites: {len(filtered)}\n")
    sys.stdout.write(f"uncovered mutation sites: {len(uncovered)}\n")
    sys.stdout.write(f"changed mutation sites: {len(selected)}\n")
    sys.stdout.write(f"suppressed equivalent sites: {suppressed_sites}\n")
    sys.stdout.write(f"manifest exists: {'yes' if old_manifest else 'no'}\n")
    sys.stdout.write(f"module hash changed: {'yes' if module_hash_changed else 'no'}\n")
    sys.stdout.write(f"differential surface area: {differential}\n")
    sys.stdout.write(f"manifest-violating surface area: {violating}\n")

    if not filtered:
        sys.stdout.write("no mutation sites to test\n")
        manifest.write(abs_target, stripped, {
            "version": 4, "project_hash": proj_hash, "scopes": _scopes_data(scopes)})
        sys.stdout.write(f"manifest updated: {relative}\n")
        return 0

    if len(filtered) > options["mutation_warning"]:
        sys.stderr.write(f"warning: {len(filtered)} mutations exceed threshold "
                         f"{options['mutation_warning']}\n")

    workers = options["max_workers"] or max(1, (os.cpu_count() or 2) // 2)
    workers = min(workers, len(filtered))
    sys.stdout.write(f"workers: {workers} (parallel)\n")

    workspaces = _prepare_workspaces(project_root, workers)
    command = _test_command(options, python)
    if verbose:
        sys.stderr.write(f"test command: {' '.join(command)}\n")
    try:
        sys.stdout.write("baseline: running...\n")
        start = time.monotonic()
        baseline = run_shell(command, cwd=workspaces[0], env=_run_env(workspaces[0]))
        elapsed = round(time.monotonic() - start, 1)
        if baseline.returncode != 0:
            sys.stderr.write(f"baseline test failed (exit {baseline.returncode})\n")
            return 2
        timeout = max(10.0, elapsed * options["timeout_factor"])
        sys.stdout.write(f"baseline: {elapsed}s (timeout: {timeout:.0f}s)\n")

        results: dict[int, tuple[str, float]] = {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {}
            for index, site in enumerate(filtered):
                ws = workspaces[index % len(workspaces)]
                futures[pool.submit(_run_trial, ws, relative, source, site,
                                    command, timeout, run_shell,
                                    _run_env(ws))] = index
            for future in as_completed(futures):
                try:
                    outcome, seconds = future.result()
                except Exception as exc:  # noqa: BLE001 - treat as killed
                    outcome, seconds = "killed", 0.0
                results[futures[future]] = (outcome, seconds)

        killed = sum(1 for outcome, _ in results.values()
                     if outcome in ("killed", "timeout"))
        survived = sum(1 for outcome, _ in results.values() if outcome == "survived")
        timed_out = sum(1 for outcome, _ in results.values() if outcome == "timeout")
        for index in range(len(filtered)):
            outcome, seconds = results[index]
            site = filtered[index]
            sys.stdout.write(f"[{index + 1}/{len(filtered)}] L{site.line}: "
                             f"{site.description} ... {outcome} ({seconds}s)\n")
        score = (killed / (killed + survived) * 100) if (killed + survived) else 0.0
        line = f"score: {score:.1f}% ({killed}/{killed + survived} killed"
        if timed_out:
            line += f", {timed_out} timeout"
        sys.stdout.write(line + ")\n")
        if survived:
            return 3
        manifest.write(abs_target, stripped, {
            "version": 4, "project_hash": proj_hash, "scopes": _scopes_data(scopes)})
        sys.stdout.write(f"manifest updated: {relative}\n")
        return 0
    finally:
        for ws in workspaces:
            shutil.rmtree(ws, ignore_errors=True)
        shutil.rmtree(os.path.join(project_root, ".toolcache", "mutate4py"),
                      ignore_errors=True)
