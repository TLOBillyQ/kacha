"""mutate 子命令 —— 单文件变异测试。

用法:
  python tools/cli.py mutate <file.py> [--scan|--update-manifest|--since-last-run|
      --mutate-all|--lines N,N|--reuse-coverage|--max-workers N|
      --timeout-factor N|--test-command CMD|--mutation-warning N|--verbose]

退出码:0 无存活 mutant(干净运行后写 manifest)/ 1 用法错误 / 2 baseline 失败 /
3 存在存活 mutant。

测试经项目 pytest 运行(--test-command 为逃生舱,禁用覆盖率过滤);worker 在
.toolcache/ 下的项目副本中运行,原始文件永不在原地变异。每个位点写文件前先清掉
目标包目录的 __pycache__,并给 worker 私有 TMPDIR —— 这两条是判定可信的前提
(.pyc 按秒+字节数判鲜、并发 pytest 的 tmp_path 会串台,否则 mutant 会被误判为
存活)。覆盖率取数走 ..covdata 适配层(与 crap 共用同一条 coverage.py 流水线)。

模块结构:main 只做参数与路由,_prepare 建一次"目标状态",三个子命令处理函数
(_scan / _update_manifest / _mutate)消费该状态;跑位点的机制在 _execute 以下。
"""

from __future__ import annotations

import dataclasses
import json
import os
import queue
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from .. import covdata
from ..common import (POSITIONAL_SINGLE, Flag, Value, as_float, as_int,
                      escapes_root, parse_tokens, project_python,
                      repo_root_from, wants_help)
from . import engine, manifest

run = subprocess.run

#: mutate 的覆盖率目标范围固定为项目被测目录(与上游内置构建工具的口径一致)。
COVERAGE_SOURCE = covdata.DEFAULT_SOURCE
MANIFEST_VERSION = 4
DEFAULT_TIMEOUT_FACTOR = 10.0
DEFAULT_MIN_TIMEOUT = 10.0
DEFAULT_MUTATION_WARNING = 50
WORKSPACE_RELPATH = (".toolcache", "mutate4py")
WORKSPACE_TMP_RELPATH = (".toolcache", "tmp")
CACHE_RELPATH = (".toolcache", "mutate4py-coverage.json")

_FLAGS = (Flag("--scan", "scan"), Flag("--update-manifest", "update_manifest"),
          Flag("--mutate-all", "mutate_all"),
          Flag("--since-last-run", "since_last_run"),
          Flag("--reuse-coverage", "reuse_coverage"), Flag("--verbose", "verbose"))

def _parse_line_set(text: str) -> set[int]:
    """行号串 "1,2,5" -> 行号集合;空集抛 ValueError(带正文的用法错误)。"""
    lines = {int(number) for number in text.replace(",", " ").split()}
    if not lines:
        raise ValueError("--lines requires a comma-separated list of line numbers")
    return lines


_VALUES = (Value("--lines", "line_set", _parse_line_set),
           Value("--max-workers", "max_workers", as_int),
           Value("--timeout-factor", "timeout_factor", as_float),
           Value("--test-command", "test_command"),
           Value("--mutation-warning", "mutation_warning", as_int))

_DEFAULTS = {"scan": False, "update_manifest": False, "mutate_all": False,
             "since_last_run": False, "reuse_coverage": False, "verbose": False,
             "line_set": None, "max_workers": None,
             "timeout_factor": DEFAULT_TIMEOUT_FACTOR, "test_command": None,
             "mutation_warning": DEFAULT_MUTATION_WARNING}

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


def usage() -> str:
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


def _conflict(options) -> str | None:
    """互斥选项检查(表驱动;首条命中即报错正文)。"""
    for first, second, message in _CONFLICTS:
        if options.get(first) and options.get(second):
            return message
    return None


def _options_or_error(args) -> tuple[dict, str | None]:
    """解析 + 互斥检查 + 目标必填;返回 (options, 用法错误正文)。"""
    options, paths, error = parse_tokens(args, flags=_FLAGS, values=_VALUES,
                                         positional=POSITIONAL_SINGLE,
                                         unknown_verb="unknown option")
    if error:
        return {}, error
    merged = {**_DEFAULTS, **options, "target": paths[0] if paths else None}
    conflict = _conflict(merged)
    if conflict:
        return merged, conflict
    if not merged["target"]:
        return merged, "target file required"
    return merged, None


def _usage_failure(body: str) -> int:
    sys.stderr.write(f"error: {body}\n\n{usage()}")
    return 1


def _read_target(repo_root: str, target: str) -> tuple[str, str]:
    """读取目标源码;越出仓库根即报错(调用方给 1 号退出码)。"""
    abs_target = os.path.abspath(target if os.path.isabs(target)
                                 else os.path.join(repo_root, target))
    with open(abs_target, encoding="utf-8") as handle:
        source = handle.read()
    if escapes_root(abs_target, repo_root):
        raise ValueError("target file escapes workspace root")
    return abs_target, source


@dataclasses.dataclass
class _TargetState:
    """一次 mutate 运行所需的目标快照(避免在各处理函数间传十个参数)。"""

    repo_root: str
    abs_target: str
    relative: str          # 相对 project_root:worker 副本内定位用
    project_root: str
    python: str
    source: str
    stripped: str
    scopes: list
    sites: list
    suppressed: int
    old_manifest: dict | None
    proj_hash: str
    module_hash_changed: bool
    changed_ids: set


def _prepare(repo_root: str, abs_target: str, source: str) -> _TargetState:
    """解析目标、算哈希与 manifest 差分(语法错误由调用方处理)。"""
    module_name = os.path.splitext(os.path.basename(abs_target))[0]
    stripped = manifest.strip(source)
    scopes, sites, suppressed = engine.scan_module(stripped, module_name)
    project_root = engine.find_root(repo_root, abs_target)
    old_manifest = manifest.read(abs_target)
    proj_hash = engine.project_hash(project_root, abs_target, stripped)
    return _TargetState(
        repo_root=repo_root, abs_target=abs_target, python=project_python(repo_root),
        relative=os.path.relpath(abs_target, project_root),
        project_root=project_root, source=source, stripped=stripped, scopes=scopes,
        sites=sites, suppressed=suppressed, old_manifest=old_manifest,
        proj_hash=proj_hash,
        module_hash_changed=(old_manifest is None
                             or old_manifest["project_hash"] != proj_hash),
        changed_ids=engine.changed_scope_ids(scopes, old_manifest))


def main(args, env=None, run_shell=run) -> int:
    repo_root = repo_root_from(env)
    if wants_help(args):
        sys.stdout.write(usage())
        return 0
    options, failure = _options_or_error(args)
    if failure:
        return _usage_failure(failure)
    state, code = _state_or_error(repo_root, options["target"])
    if state is None:
        return code
    for dest, handler in _SUBCOMMANDS:
        if options[dest]:
            return handler(state)
    return _mutate(state, options, run_shell)


def _state_or_error(repo_root: str, target: str) -> tuple[_TargetState | None, int]:
    """读目标并建状态;沿用既有错误文案,失败返回退出码 1。"""
    try:
        abs_target, source = _read_target(repo_root, target)
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"error: {exc}\n")
        return None, 1
    try:
        return _prepare(repo_root, abs_target, source), 0
    except SyntaxError as exc:
        sys.stderr.write(f"error: cannot parse target: {exc}\n")
        return None, 1


def _scan(state: _TargetState) -> int:
    sys.stdout.write(f"file: {state.relative}\n")
    sys.stdout.write(f"sites: {len(state.sites)}\n")
    sys.stdout.write(f"suppressed equivalent sites: {state.suppressed}\n")
    for site in state.sites:
        prefix = "* " if state.old_manifest and site.scope_id in state.changed_ids \
            else "  "
        sys.stdout.write(f"{prefix}L{site.line} {site.description} "
                         f"(scope: {site.scope_id})\n")
    return 0


def _update_manifest(state: _TargetState) -> int:
    """显式登记当前状态:整份 manifest 按现有 scope 重写(bootstrap 用)。"""
    _write_manifest(state)
    return 0


#: 子命令 -> 处理函数(与顶层 COMMANDS 同样的查表调度风格)
_SUBCOMMANDS = (("scan", _scan), ("update_manifest", _update_manifest))


def _write_manifest(state: _TargetState, executed=None) -> None:
    """写 manifest;executed 为 None 表示全量登记,否则只登记"够格"的 scope。"""
    payload = {"version": MANIFEST_VERSION, "project_hash": state.proj_hash,
               "scopes": _scopes_data(_recordable_scopes(state, executed))}
    manifest.write(state.abs_target, state.stripped, payload)
    sys.stdout.write(f"manifest updated: {state.relative}\n")


def _recordable_scopes(state: _TargetState, executed):
    """本次全量跑过的 scope,加上整体未触及且旧记录仍有效的 scope。

    旧记录只在语义哈希未变时沿用:被 --lines/覆盖率过滤切走的位点没有被验证,
    不能因为一次局部运行就被记成"已验证"。
    """
    if executed is None:
        return list(state.scopes)
    totals = _site_counts(state.sites)
    tested = _site_counts(executed)
    recorded = {scope.get("id"): scope for scope in
                (state.old_manifest or {}).get("scopes", [])}
    return [scope for scope in state.scopes
            if _scope_is_recordable(scope, totals, tested, recorded)]


def _site_counts(sites) -> dict:
    counts: dict[str, int] = {}
    for site in sites:
        counts[site.scope_id] = counts.get(site.scope_id, 0) + 1
    return counts


def _scope_is_recordable(scope, totals: dict, tested: dict, recorded: dict) -> bool:
    """位点为空 / 位点全部跑完 / 整体未触及且旧记录哈希一致 —— 才有资格登记。"""
    total = totals.get(scope.id, 0)
    done = tested.get(scope.id, 0)
    if done == total:
        return True
    previous = recorded.get(scope.id)
    return (done == 0 and previous is not None
            and previous.get("semantic_hash", "") == scope.semantic_hash)


def _scopes_data(scopes) -> list[dict]:
    return [{"id": scope.id, "kind": scope.kind, "start_line": scope.start_line,
             "end_line": scope.end_line, "semantic_hash": scope.semantic_hash}
            for scope in scopes]


def _mutate(state: _TargetState, options, run_shell) -> int:
    selected = engine.select_sites(state.sites, state.scopes, state.old_manifest,
                                   options, state.module_hash_changed)
    filtered, uncovered = _split_covered(selected,
                                         _covered_lines(state, options, run_shell))
    _report_overview(state, selected, filtered, uncovered)
    if not filtered:
        sys.stdout.write("no mutation sites to test\n")
        _write_manifest(state, filtered)
        return 0
    _warn_if_many(filtered, options["mutation_warning"])
    return _execute(state, options, filtered, run_shell)


def _split_covered(selected, covered) -> tuple[list, list]:
    """covered 为 None(不过滤)时全部入选,否则按覆盖行切分。"""
    if covered is None:
        return list(selected), []
    return ([site for site in selected if site.line in covered],
            [site for site in selected if site.line not in covered])


def _report_overview(state: _TargetState, selected, filtered, uncovered) -> None:
    differential, violating = engine.surface_areas(selected, state.scopes,
                                                   state.old_manifest)
    lines = [f"mutate4py: {state.relative}",
             f"total mutation sites: {len(state.sites)}",
             f"covered mutation sites: {len(filtered)}",
             f"uncovered mutation sites: {len(uncovered)}",
             f"changed mutation sites: {len(selected)}",
             f"suppressed equivalent sites: {state.suppressed}",
             f"manifest exists: {'yes' if state.old_manifest else 'no'}",
             f"module hash changed: {'yes' if state.module_hash_changed else 'no'}",
             f"differential surface area: {differential}",
             f"manifest-violating surface area: {violating}"]
    sys.stdout.write("\n".join(lines) + "\n")


def _warn_if_many(filtered, warning_threshold: int) -> None:
    if len(filtered) > warning_threshold:
        sys.stderr.write(f"warning: {len(filtered)} mutations exceed threshold "
                         f"{warning_threshold}\n")


def _covered_lines(state: _TargetState, options, run_shell):
    """目标文件的已覆盖行;取数失败或 --test-command 逃生舱都不过滤。"""
    if options["test_command"]:
        sys.stderr.write("warning: --test-command disables coverage filtering; "
                         "treating all sites as covered\n")
        return None
    cache = os.path.join(state.repo_root, *CACHE_RELPATH)
    if options["reuse_coverage"]:
        cached = _read_cache(cache, state.proj_hash, state.relative)
        if cached is not None:
            return cached
    return _collect_covered(state, cache, run_shell)


def _collect_covered(state: _TargetState, cache: str, run_shell):
    """跑覆盖率流水线并写缓存;产物不可用(或测试失败)时返回 None 不过滤。"""
    collection = covdata.collect(state.python, state.repo_root, COVERAGE_SOURCE,
                                 run_shell)
    if not collection.artifact_ok or collection.tests_failed:
        sys.stderr.write("warning: coverage pass failed; treating all sites as "
                         "covered\n")
        return None
    try:
        executed = _match_covered(covdata.load(state.repo_root), state)
        _write_cache(cache, state.proj_hash, state.relative, executed)
        return executed
    except (OSError, ValueError):
        sys.stderr.write("warning: cannot read coverage artifact; treating all "
                         "sites as covered\n")
        return None


def _match_covered(files: dict, state: _TargetState) -> set[int] | None:
    target = os.path.abspath(os.path.join(state.repo_root, state.relative))
    lines = covdata.covered_lines(files, target)
    # 目标属于上层子项目时,产物键只能按 relative 后缀对上
    return lines if lines is not None else covdata.covered_lines(files,
                                                                state.relative)


def _read_cache(cache: str, proj_hash: str, target_rel: str):
    """覆盖率缓存命中即返回行集(并播报);缺失/坏档/哈希不符都回 None。"""
    lines = _cache_entry(_load_json(cache), target_rel, proj_hash)
    if lines is None:
        return None
    sys.stdout.write("reusing coverage cache\n")
    return lines


def _cache_entry(payload, target_rel: str, proj_hash: str) -> set[int] | None:
    if payload is None or payload.get("projectHash") != proj_hash:
        return None
    lines = payload.get("covered", {}).get(target_rel)
    return None if lines is None else set(lines)


def _load_json(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _write_cache(cache: str, proj_hash: str, target_rel: str, executed) -> None:
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "w", encoding="utf-8") as handle:
        json.dump({"projectHash": proj_hash,
                   "covered": {target_rel: sorted(executed or [])}}, handle)


def _execute(state: _TargetState, options, filtered, run_shell) -> int:
    workspaces = _prepare_workspaces(state.project_root,
                                     _worker_count(options["max_workers"],
                                                   len(filtered)))
    command = _test_command(options, state.python)
    sys.stdout.write(f"workers: {len(workspaces)} (parallel)\n")
    if options["verbose"]:
        sys.stderr.write(f"test command: {' '.join(command)}\n")
    try:
        return _run_suite(state, options, filtered, workspaces, command, run_shell)
    finally:
        _discard_workspaces(state.project_root, workspaces)


def _worker_count(requested, site_count: int) -> int:
    workers = requested or max(1, (os.cpu_count() or 2) // 2)
    return min(workers, site_count)


def _prepare_workspaces(project_root: str, count: int) -> list[str]:
    ignored = shutil.ignore_patterns(*engine.IGNORED_DIRECTORIES)
    workspaces = []
    for index in range(count):
        ws = os.path.join(project_root, *WORKSPACE_RELPATH, f"ws-{index}")
        if os.path.isdir(ws):
            shutil.rmtree(ws)
        shutil.copytree(project_root, ws, ignore=ignored)
        workspaces.append(ws)
    return workspaces


def _discard_workspaces(project_root: str, workspaces) -> None:
    for ws in workspaces:
        shutil.rmtree(ws, ignore_errors=True)
    shutil.rmtree(os.path.join(project_root, *WORKSPACE_RELPATH),
                  ignore_errors=True)


def _test_command(options, python: str):
    if options["test_command"]:
        return ["/bin/sh", "-c", options["test_command"]]
    return [python, "-m", "pytest"]


def _run_env(ws_root: str) -> dict:
    """worker 副本的运行环境:私有 PYTHONPATH + 私有临时目录。

    并发 pytest 的 tmp_path 编号在同一条系统临时目录上会串台:一个 worker 写的
    临时文件被另一个 worker 读走,mutant 的行为被顶替,位点被误判为存活。
    所以每个 worker 必须有私有 TMPDIR(POSIX 与 Windows 变量都设)。
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = (os.path.join(ws_root, "src") + os.pathsep
                         + env.get("PYTHONPATH", ""))
    tmp = os.path.join(ws_root, *WORKSPACE_TMP_RELPATH)
    os.makedirs(tmp, exist_ok=True)
    env["TMPDIR"] = tmp
    env["TEMP"] = tmp
    env["TMP"] = tmp
    return env


def _baseline(ws_root: str, command, run_shell) -> tuple[int, float]:
    """未变异基线:副本里整套测试必须绿,否则变异结果无意义。"""
    sys.stdout.write("baseline: running...\n")
    start = time.monotonic()
    result = run_shell(command, cwd=ws_root, env=_run_env(ws_root))
    return result.returncode, round(time.monotonic() - start, 1)


def _run_suite(state, options, filtered, workspaces, command, run_shell) -> int:
    exit_code, elapsed = _baseline(workspaces[0], command, run_shell)
    if exit_code:
        sys.stderr.write(f"baseline test failed (exit {exit_code})\n")
        return 2
    timeout = max(DEFAULT_MIN_TIMEOUT, elapsed * options["timeout_factor"])
    sys.stdout.write(f"baseline: {elapsed}s (timeout: {timeout:.0f}s)\n")
    results = _run_trials(workspaces, state, filtered, command, timeout, run_shell)
    if _report_results(results, filtered):
        return 3
    _write_manifest(state, filtered)
    return 0


def _run_trials(workspaces, state, filtered, command, timeout, run_shell) -> dict:
    """位点租用副本运行;副本编号 % worker 数分配并不可靠(见 _leased_trial)。"""
    slots = queue.Queue()
    for workspace in workspaces:
        slots.put(workspace)
    with ThreadPoolExecutor(max_workers=len(workspaces)) as pool:
        futures = {pool.submit(_leased_trial, slots, state, site, command,
                               timeout, run_shell): index
                   for index, site in enumerate(filtered)}
        return {futures[future]: _trial_outcome(future)
                for future in as_completed(futures)}


def _leased_trial(slots, state, site, command, timeout, run_shell):
    """同一份副本同一时刻只跑一个位点:取不到租约就不开工,跑完归还。

    按 "位点序号 % 副本数" 直接分副本会打架:慢位点(超时)占着 worker,后面的
    位点会在同一个目录里同时改写/恢复同一个目标文件,pytest 读到别人的版本,
    存活/击杀判定就不可信了。
    """
    ws_root = slots.get()
    try:
        return _run_trial(ws_root, state, site, command, timeout, run_shell)
    finally:
        slots.put(ws_root)


def _trial_outcome(future) -> tuple[str, float]:
    try:
        return future.result()
    except Exception:  # noqa: BLE001 - 跑不起来的位点按已击杀计
        return "killed", 0.0


def _run_trial(ws_root, state, site, command, timeout, run_shell) -> tuple[str, float]:
    path = os.path.join(ws_root, state.relative)
    try:
        _discard_stale_bytecode(ws_root, state.relative)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(site.mutated_source(state.source))
        start = time.monotonic()
        outcome = _trial_status(path, command, timeout, run_shell, ws_root, state)
        return outcome, round(time.monotonic() - start, 1)
    finally:
        _restore(path, state.source)


def _discard_stale_bytecode(ws_root: str, relative: str) -> None:
    """清掉副本里目标模块的旧字节码。

    .pyc 以 (mtime 秒, 字节数) 判鲜;同尺寸同秒的 mutant(如 `==` -> `!=`)会被
    上一次运行(基线或前一个位点)留下的字节码顶替,tests 跑到的是旧代码,
    位点被误判为存活。每个位点写文件前先删同目录的 __pycache__。
    """
    cache = os.path.join(ws_root, os.path.dirname(relative), "__pycache__")
    shutil.rmtree(cache, ignore_errors=True)


def _trial_status(path, command, timeout, run_shell, ws_root, state) -> str:
    try:
        result = run_shell(command, cwd=ws_root, env=_run_env(ws_root),
                           timeout=timeout)
        return "survived" if result.returncode == 0 else "killed"
    except subprocess.TimeoutExpired:
        return "timeout"


def _restore(path: str, source: str) -> None:
    """副本恢复原文件:原始文件从不在原地被变异。"""
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(source)
    except OSError:
        pass


def _report_results(results: dict, filtered) -> bool:
    """逐位点打印并汇总;返回是否存在存活 mutant。"""
    for index, site in enumerate(filtered):
        outcome, seconds = results[index]
        sys.stdout.write(f"[{index + 1}/{len(filtered)}] L{site.line}: "
                         f"{site.description} ... {outcome} ({seconds}s)\n")
    killed = _count_outcome(results, "killed") + _count_outcome(results, "timeout")
    survived = _count_outcome(results, "survived")
    timed_out = _count_outcome(results, "timeout")
    total = killed + survived
    score = (killed / total * 100) if total else 0.0
    summary = f"score: {score:.1f}% ({killed}/{total} killed"
    if timed_out:
        summary += f", {timed_out} timeout"
    sys.stdout.write(summary + ")\n")
    return survived > 0


def _count_outcome(results: dict, outcome: str) -> int:
    return sum(1 for name, _ in results.values() if name == outcome)
