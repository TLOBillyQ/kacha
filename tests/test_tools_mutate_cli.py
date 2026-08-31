"""mutate CLI：scan / update-manifest / 退出码 2(baseline)/ 3(存活)/ 干净运行写 manifest。"""

from __future__ import annotations

import json
import os
import queue
from types import SimpleNamespace

import subprocess

from tools.packages.mutate import cli, engine, manifest

TARGET = "src/m.py"


def make_project(tmp_path, source):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "m.py").write_text(source)
    (tmp_path / "pyproject.toml").write_text("[project]\nname='p'\n")
    return str(tmp_path)


def fake_shell(plan):
    """按调用顺序返回 plan 中的退出码,最后一个重复使用。"""
    calls = []

    def run_shell(argv, cwd=None, **kwargs):
        calls.append((list(argv), cwd, kwargs))
        code = plan[min(len(plan) - 1, len(calls) - 1)]
        return SimpleNamespace(returncode=code)

    return run_shell, calls


def write_coverage(tmp_path, lines, rel="src/m.py"):
    artifact = tmp_path / ".toolcache" / "coverage.json"
    artifact.parent.mkdir(exist_ok=True)
    artifact.write_text(json.dumps(
        {"files": {rel: {"executed_lines": lines}}}))


def test_scan_lists_sites(tmp_path, capsys):
    root = make_project(tmp_path, "def f(x):\n    if x > 0:\n        return x + 1\n")
    code = cli.main(["src/m.py", "--scan"], {"repo_root": root})
    out = capsys.readouterr().out
    assert code == 0
    assert "file: src/m.py" in out
    assert "sites: " in out
    assert "L2 " in out and "(scope: m.f)" in out


def test_update_manifest_writes_footer(tmp_path, capsys):
    source = "def f(x):\n    return x + 1\n"
    root = make_project(tmp_path, source)
    code = cli.main(["src/m.py", "--update-manifest"], {"repo_root": root})
    assert code == 0
    assert "manifest updated: src/m.py" in capsys.readouterr().out
    assert manifest.read(os.path.join(root, "src/m.py")) is not None


def test_help_short_circuits_everything(tmp_path, capsys):
    root = make_project(tmp_path, "def f():\n    return 1\n")
    assert cli.main(["--help"], {"repo_root": root}) == 0
    assert "变异" not in capsys.readouterr().err
    assert "usage" in cli.usage().lower() or "用法" in cli.usage()
    assert cli.main(["-h"], {"repo_root": root}) == 0
    assert "选项:" in capsys.readouterr().out


def test_conflict_and_missing_target(tmp_path, capsys):
    root = make_project(tmp_path, "def f():\n    return 1\n")
    code = cli.main(["src/m.py", "--scan", "--mutate-all"], {"repo_root": root})
    err = capsys.readouterr().err
    assert code == 1 and "cannot be combined" in err
    assert cli.main(["--scan"], {"repo_root": root}) == 1
    assert "target file required" in capsys.readouterr().err


def test_baseline_failure_exits_2(tmp_path, capsys):
    root = make_project(tmp_path,
                        "def f(x):\n    result = x + 1\n    return result\n")
    write_coverage(tmp_path, [1, 2, 3])
    plan = [0, 0, 0, 7]
    run_shell, _ = fake_shell(plan)
    assert cli.main(["src/m.py"], {"repo_root": root}, run_shell=run_shell) == 2
    assert "baseline test failed" in capsys.readouterr().err


def test_survivors_exit_3_and_no_manifest(tmp_path, capsys):
    source = "def f(x):\n    result = x + 1\n    return result\n"
    root = make_project(tmp_path, source)
    write_coverage(tmp_path, [1, 2, 3])
    run_shell, _ = fake_shell([0, 0, 0, 0, 0])
    code = cli.main(["src/m.py"], {"repo_root": root}, run_shell=run_shell)
    out = capsys.readouterr().out
    assert code == 3
    assert "score: 0.0% (0/" in out
    assert "manifest updated" not in out
    assert manifest.read(os.path.join(root, "src/m.py")) is None


def test_clean_run_writes_manifest(tmp_path, capsys):
    source = "def f(x):\n    result = x + 1\n    return result\n"
    root = make_project(tmp_path, source)
    write_coverage(tmp_path, [1, 2, 3])
    run_shell, _ = fake_shell([0, 0, 0, 0, 1])
    code = cli.main(["src/m.py"], {"repo_root": root}, run_shell=run_shell)
    out = capsys.readouterr().out
    assert code == 0
    assert "score: 100.0%" in out
    assert "manifest updated: src/m.py" in out
    assert manifest.read(os.path.join(root, "src/m.py")) is not None
    # workspace 副本已清理
    assert not os.path.isdir(os.path.join(root, ".toolcache", "mutate4py"))


def test_scan_shows_changed_scope_prefix(tmp_path, capsys):
    source = "def f(x):\n    return x + 1\n"
    root = make_project(tmp_path, source)
    target = os.path.join(root, "src/m.py")
    manifest.write(target, source, {"version": 4, "project_hash": "old", "scopes": [
        {"id": "m.f", "kind": "function", "start_line": 1, "end_line": 2,
         "semantic_hash": "stale"}]})
    cli.main(["src/m.py", "--scan"], {"repo_root": root})
    out = capsys.readouterr().out
    assert "* L2 " in out  # scope 语义哈希失配 -> 标星


# --- 选项、覆盖率过滤与 worker 路径 -----------------------------------------

def test_lines_option_filters_sites_and_validates_input(tmp_path, capsys):
    root = make_project(tmp_path,
                        "def f(x):\n    result = x + 1\n    return result\n")
    write_coverage(tmp_path, [1, 2, 3])
    run_shell, calls = fake_shell([0, 0, 0, 0, 1])
    code = cli.main(["src/m.py", "--lines", "2"], {"repo_root": root},
                    run_shell=run_shell)
    out = capsys.readouterr().out
    assert code == 0
    assert "L2: binop/add->sub ... killed" in out
    assert "changed mutation sites: 3" in out
    assert len(calls) == 7  # 3 步覆盖率流水线 + baseline + L2 的 3 个位点

    assert cli.main(["src/m.py", "--lines", "99"], {"repo_root": root}) == 0
    assert "no mutation sites to test" in capsys.readouterr().out

    assert cli.main(["src/m.py", "--lines", ""], {"repo_root": root}) == 1
    assert "--lines requires a comma-separated" in capsys.readouterr().err
    assert cli.main(["src/m.py", "--max-workers", "x"], {"repo_root": root}) == 1
    assert "--max-workers requires a numeric value" in capsys.readouterr().err
    assert cli.main(["src/m.py", "--bogus"], {"repo_root": root}) == 1
    assert "unknown option: --bogus" in capsys.readouterr().err
    assert cli.main(["src/m.py", "extra.py"], {"repo_root": root}) == 1
    assert "unknown option: extra.py" in capsys.readouterr().err


def test_target_read_failures(tmp_path, capsys):
    project = tmp_path / "proj"
    project.mkdir()
    root = make_project(project, "def f():\n    return 1\n")
    (tmp_path / "outside.py").write_text("def g():\n    return 1\n")
    assert cli.main(["../outside.py"], {"repo_root": root}) == 1
    assert "escapes workspace root" in capsys.readouterr().err
    assert cli.main(["src/missing.py"], {"repo_root": root}) == 1
    assert "No such file" in capsys.readouterr().err

    (project / "src" / "broken.py").write_text("def f(:\n    return 1\n")
    assert cli.main(["src/broken.py"], {"repo_root": root}) == 1
    assert "cannot parse target" in capsys.readouterr().err


def test_test_command_escape_hatch_skips_coverage(tmp_path, capsys):
    root = make_project(tmp_path, "def f(x):\n    return x + 1\n")
    run_shell, calls = fake_shell([0, 0, 1])
    code = cli.main(["src/m.py", "--test-command", "pytest -q", "--verbose"],
                    {"repo_root": root}, run_shell=run_shell)
    captured = capsys.readouterr()
    assert code == 3
    assert "--test-command disables coverage filtering" in captured.err
    assert "uncovered mutation sites: 0" in captured.out
    assert "test command: /bin/sh -c pytest -q" in captured.err
    assert calls[0][0] == ["/bin/sh", "-c", "pytest -q"]  # 无 coverage 三步流水线


def test_coverage_failures_treat_every_site_as_covered(tmp_path, capsys):
    root = make_project(tmp_path, "def f(x):\n    return x + 1\n")
    write_coverage(tmp_path, [1, 2, 3])

    run_shell, _ = fake_shell([0, 1, 0, 0, 0])  # 插桩跑测试失败 -> 不过滤
    assert cli.main(["src/m.py"], {"repo_root": root}, run_shell=run_shell) == 3
    assert "coverage pass failed" in capsys.readouterr().err

    os.remove(tmp_path / ".toolcache" / "coverage.json")  # 产物缺失 -> 不过滤
    run_shell, _ = fake_shell([0, 0, 0, 0, 0])
    assert cli.main(["src/m.py"], {"repo_root": root}, run_shell=run_shell) == 3
    assert "cannot read coverage artifact" in capsys.readouterr().err


def test_reuse_coverage_cache_hit_and_stale(tmp_path, capsys):
    source = "def f(x):\n    return x > 1\n"
    root = make_project(tmp_path, source)
    write_coverage(tmp_path, [1, 2])
    abs_target = os.path.join(root, "src/m.py")
    cache = tmp_path / ".toolcache" / "mutate4py-coverage.json"
    cache.parent.mkdir(exist_ok=True)

    def run_with_cache(project_hash):
        cache.write_text(json.dumps({"projectHash": project_hash,
                                     "covered": {"src/m.py": [2]}}))
        run_shell, calls = fake_shell([0])
        code = cli.main(["src/m.py", "--reuse-coverage"], {"repo_root": root},
                        run_shell=run_shell)
        return code, calls, capsys.readouterr().out

    assert run_with_cache(engine.project_hash(root, abs_target, source))[0] == 3
    code, calls, out = run_with_cache(engine.project_hash(root, abs_target, source))
    assert "reusing coverage cache" in out
    assert len(calls) == 3  # 命中缓存:baseline + 2 个位点,不再跑覆盖率

    code, calls, out = run_with_cache("stale")
    assert "reusing coverage cache" not in out
    assert len(calls) == 6  # 哈希不符:3 步覆盖率流水线 + baseline + 2 个位点

    cache.write_text("{broken")
    run_shell, calls = fake_shell([0])
    assert cli.main(["src/m.py", "--reuse-coverage"], {"repo_root": root},
                    run_shell=run_shell) == 3
    assert len(calls) == 6  # 缓存不可解析 -> 重新取数


def test_workers_timeout_and_trial_errors(tmp_path, capsys, monkeypatch):
    root = make_project(tmp_path, "def f(x):\n    return x > 1\n")
    write_coverage(tmp_path, [1, 2, 3])

    run_shell, _ = fake_shell([0, 0, 0, 0, 0])
    code = cli.main(["src/m.py", "--max-workers", "2", "--mutation-warning", "1"],
                    {"repo_root": root}, run_shell=run_shell)
    captured = capsys.readouterr()
    assert code == 3
    assert "workers: 2 (parallel)" in captured.out
    assert "2 mutations exceed threshold 1" in captured.err

    def time_out(argv, cwd=None, env=None, timeout=None):
        raise subprocess.TimeoutExpired(argv, timeout or 1)

    run_shell, _ = fake_shell([0])
    assert cli.main(["src/m.py", "--mutate-all"], {"repo_root": root},
                    run_shell=run_shell) == 3
    assert "manifest updated" not in capsys.readouterr().out

    code = cli.main(["src/m.py", "--timeout-factor", "1", "--mutate-all"],
                    {"repo_root": root}, run_shell=shell_for(time_out))
    captured = capsys.readouterr()
    assert code == 0  # 超时按已击杀计 -> 干净运行写 manifest
    assert "2 timeout)" in captured.out
    assert "timeout (" in captured.out  # 逐位点也标注 timeout

    def explode(*args, **kwargs):
        raise RuntimeError("worker died")

    # 上一步干净运行写入了 manifest 且模块未变 -> 差分选择为空跑
    run_shell, _ = fake_shell([0])
    assert cli.main(["src/m.py"], {"repo_root": root}, run_shell=run_shell) == 0
    differential_run = capsys.readouterr().out
    assert "no mutation sites to test" in differential_run
    assert "module hash changed: no" in differential_run

    # --mutate-all 绕过 manifest;worker 抛异常按已击杀计
    monkeypatch.setattr(cli, "_run_trial", explode)
    run_shell, _ = fake_shell([0])
    assert cli.main(["src/m.py", "--mutate-all"], {"repo_root": root},
                    run_shell=run_shell) == 0
    assert "score: 100.0%" in capsys.readouterr().out


def shell_for(behavior):
    """baseline 用普通 fake,位点执行用注入的 behavior。"""
    def run_shell(argv, cwd=None, **kwargs):
        if "timeout" in kwargs:
            return behavior(argv, cwd=cwd, timeout=kwargs["timeout"])
        return SimpleNamespace(returncode=0)

    return run_shell


# --- worker 副本的字节码与 manifest 登记范围 --------------------------------

TWO_SCOPES = "def a(x):\n    return x + 1\n\n\ndef b(y):\n    return y * 2\n"


def killed_shell():
    """baseline 绿、每个位点都让测试失败 -> 全部击杀。"""
    return shell_for(lambda argv, cwd=None, timeout=None: SimpleNamespace(returncode=1))


def recorded_scope_ids(root):
    data = manifest.read(os.path.join(root, "src/m.py"))
    return [scope["id"] for scope in (data or {}).get("scopes", [])]


def test_trial_purges_stale_bytecode_of_target_package(tmp_path):
    ws = tmp_path / "ws"
    package = ws / "pkg"
    package.mkdir(parents=True)
    source = "def f():\n    return 1\n"
    (package / "m.py").write_text(source)
    stale = package / "__pycache__" / "m.cpython-314.pyc"
    stale.parent.mkdir()
    stale.write_text("stale")
    state = SimpleNamespace(relative=os.path.join("pkg", "m.py"), source=source)
    site = SimpleNamespace(mutated_source=lambda _src: "def f():\n    return 2\n")
    seen = {}

    def run_shell(argv, cwd=None, **kwargs):
        seen["purged"] = not stale.exists()
        seen["written"] = (package / "m.py").read_text()
        return SimpleNamespace(returncode=0)

    outcome, _seconds = cli._run_trial(str(ws), state, site, ["true"], 1, run_shell)
    assert outcome == "survived"
    assert seen["purged"] is True
    assert "return 2" in seen["written"]
    assert (package / "m.py").read_text() == source


def test_discard_stale_bytecode_tolerates_missing_cache(tmp_path):
    cli._discard_stale_bytecode(str(tmp_path), "m.py")
    assert not (tmp_path / "__pycache__").exists()


def test_partial_line_run_records_only_verified_scope(tmp_path):
    root = make_project(tmp_path, TWO_SCOPES)
    code = cli.main(["src/m.py", "--lines", "2", "--test-command", "true"],
                    {"repo_root": root}, run_shell=killed_shell())
    assert code == 0
    assert recorded_scope_ids(root) == ["m.a"]


def test_untouched_scope_keeps_its_record(tmp_path):
    root = make_project(tmp_path, TWO_SCOPES)
    assert cli.main(["src/m.py", "--test-command", "true"], {"repo_root": root},
                    run_shell=killed_shell()) == 0
    assert recorded_scope_ids(root) == ["m.a", "m.b"]
    assert cli.main(["src/m.py", "--lines", "2", "--test-command", "true"],
                    {"repo_root": root}, run_shell=killed_shell()) == 0
    assert recorded_scope_ids(root) == ["m.a", "m.b"]


def test_changed_scope_not_fully_run_loses_its_record(tmp_path):
    root = make_project(tmp_path, TWO_SCOPES)
    assert cli.main(["src/m.py", "--test-command", "true"], {"repo_root": root},
                    run_shell=killed_shell()) == 0
    assert recorded_scope_ids(root) == ["m.a", "m.b"]
    (tmp_path / "src" / "m.py").write_text(TWO_SCOPES.replace("y * 2", "y * 3"))
    assert cli.main(["src/m.py", "--lines", "2", "--test-command", "true"],
                    {"repo_root": root}, run_shell=killed_shell()) == 0
    assert recorded_scope_ids(root) == ["m.a"]


def test_update_manifest_records_every_scope(tmp_path):
    root = make_project(tmp_path, TWO_SCOPES)
    assert cli.main(["src/m.py", "--update-manifest"], {"repo_root": root}) == 0
    assert recorded_scope_ids(root) == ["m.a", "m.b"]


def test_run_env_isolates_tmp_and_pythonpath(tmp_path):
    env = cli._run_env(str(tmp_path))
    assert env["PYTHONPATH"].startswith(str(tmp_path / "src"))
    assert env["TMPDIR"] == env["TEMP"] == env["TMP"]
    assert os.path.isdir(env["TMPDIR"])
    assert "mutate4py" not in env["TMPDIR"] or str(tmp_path) in env["TMPDIR"]


def test_run_env_isolates_user_data_dirs(tmp_path, monkeypatch):
    # 变异体会把“注入的用户数据目录”改写成默认目录；若默认目录指向真实 HOME，
    # 被杀死的变异体仍会把测试值写进真实 settings.json（2026-08-31 实测事故）。
    monkeypatch.setenv("XDG_DATA_HOME", "/real/home/.local/share")
    monkeypatch.setenv("LOCALAPPDATA", "C:\\real\\AppData\\Local")
    env = cli._run_env(str(tmp_path))
    assert str(tmp_path) in env["XDG_DATA_HOME"]
    assert str(tmp_path) in env["LOCALAPPDATA"]


# --- worker 副本租约:同一副本同一时刻只能跑一个位点 --------------------------


def test_leased_trial_holds_workspace_until_it_finishes(monkeypatch):
    slots = queue.Queue()
    slots.put("ws-0")
    seen = []

    def watch(ws_root, state, site, command, timeout, run_shell):
        seen.append(ws_root)
        assert slots.empty()          # 租约未还,别人拿不到副本
        return "killed", 0.1

    monkeypatch.setattr(cli, "_run_trial", watch)
    assert cli._leased_trial(slots, None, None, None, None, None) == ("killed", 0.1)
    assert seen == ["ws-0"]
    assert slots.get_nowait() == "ws-0"


def test_run_trials_keys_results_by_site_index(monkeypatch):
    slots = queue.Queue()
    slots.put("ws-0")
    monkeypatch.setattr(cli, "_run_trial",
                        lambda ws_root, state, site, command, timeout, run_shell:
                        ("killed", site.line))
    sites = [SimpleNamespace(line=index) for index in range(4)]

    results = cli._run_trials(["ws-0"], None, sites, ["true"], 1, None)
    assert {index: outcome for index, (outcome, _seconds) in results.items()} == {
        0: "killed", 1: "killed", 2: "killed", 3: "killed"}
    assert [results[index][1] for index in range(4)] == [0, 1, 2, 3]


# --- 位点选择、计数与判定的口径(变异补测) ----------------------------------


def test_state_or_error_pairs_state_with_zero_exit(tmp_path):
    root = make_project(tmp_path, "def f(x):\n    return x + 1\n")
    state, code = cli._state_or_error(root, "src/m.py")
    assert code == 0 and state is not None
    missing, code = cli._state_or_error(root, "src/nope.py")
    assert missing is None and code == 1


def test_scan_stars_only_changed_scopes(tmp_path, capsys):
    source = "def f(x):\n    return x + 1\n\n\ndef g(y):\n    return y - 1\n"
    root = make_project(tmp_path, source)
    assert cli.main(["src/m.py", "--scan"], {"repo_root": root}) == 0
    assert "* " not in capsys.readouterr().out  # 无 manifest -> 没有一条该标星

    inner, outer = engine.scan_module(source)[0]  # 占位模块名:按顺序取 scope
    manifest.write(os.path.join(root, "src/m.py"), source, {
        "version": 4, "project_hash": "p",
        "scopes": [{"id": "m.f", "kind": "function", "start_line": 1, "end_line": 2,
                    "semantic_hash": inner.semantic_hash},
                   {"id": "m.g", "kind": "function", "start_line": 5, "end_line": 6,
                    "semantic_hash": "stale"}]})
    assert cli.main(["src/m.py", "--scan"], {"repo_root": root}) == 0
    out = capsys.readouterr().out
    assert "  L2 binop/add->sub (scope: m.f)" in out  # 哈希一致 -> 不标星
    assert "* L6 binop/sub->add (scope: m.g)" in out  # 哈希失配 -> 标星


def test_site_counts_tallies_sites_per_scope():
    sites = [SimpleNamespace(scope_id="m.f"), SimpleNamespace(scope_id="m.f"),
             SimpleNamespace(scope_id="m.g")]
    assert cli._site_counts(sites) == {"m.f": 2, "m.g": 1}
    assert cli._site_counts([]) == {}


def test_scope_is_recordable_requires_full_or_untouched_coverage():
    scope = SimpleNamespace(id="m.f", semantic_hash="h")
    recorded = {"m.f": {"semantic_hash": "h"}}
    assert cli._scope_is_recordable(scope, {}, {}, {})            # 无位点
    assert cli._scope_is_recordable(scope, {"m.f": 2}, {"m.f": 2}, {})  # 全跑完
    assert not cli._scope_is_recordable(scope, {"m.f": 2}, {"m.f": 1}, {})  # 半程
    assert cli._scope_is_recordable(scope, {"m.f": 2}, {}, recorded)  # 未触及且旧记录有效
    assert not cli._scope_is_recordable(scope, {"m.f": 2}, {},
                                        {"m.f": {"semantic_hash": "other"}})
    assert not cli._scope_is_recordable(scope, {"m.f": 2}, {}, {})  # 未触及无旧记录


def test_split_covered_partitions_on_covered_lines():
    sites = [SimpleNamespace(line=2), SimpleNamespace(line=9)]
    covered, uncovered = cli._split_covered(sites, {2})
    assert [site.line for site in covered] == [2]
    assert [site.line for site in uncovered] == [9]
    assert cli._split_covered(sites, None) == (sites, [])  # 不过滤 -> 全部入选


def test_match_covered_prefers_absolute_key_then_relative_suffix():
    state = SimpleNamespace(repo_root="/proj", relative="sub/src/m.py")
    assert cli._match_covered({"/proj/sub/src/m.py": {"executed_lines": [2, 3]}},
                              state) == {2, 3}
    # 绝对键命中时不得退到后缀查法:否则另一个项目的同名后缀会顶替结果
    both = {"/elsewhere/sub/src/m.py": {"executed_lines": [9]},
            "/proj/sub/src/m.py": {"executed_lines": [2]}}
    assert cli._match_covered(both, state) == {2}
    assert cli._match_covered({"sub/src/m.py": {"executed_lines": [4]}}, state) == {4}
    assert cli._match_covered({}, state) is None


def test_write_cache_rewrites_in_place_and_keeps_lines(tmp_path):
    cache = str(tmp_path / ".toolcache" / "mutate4py-coverage.json")
    cli._write_cache(cache, "h1", "src/m.py", {3, 1})
    assert cli._read_cache(cache, "h1", "src/m.py") == {1, 3}
    cli._write_cache(cache, "h2", "src/m.py", None)  # 目录已存在也必须写得出
    assert cli._read_cache(cache, "h2", "src/m.py") == set()
    assert cli._read_cache(cache, "h1", "src/m.py") is None  # 整份覆盖,不是追加


def test_worker_count_defaults_and_limits(monkeypatch):
    monkeypatch.setattr(cli.os, "cpu_count", lambda: 8)
    assert cli._worker_count(None, 10) == 4  # 默认 CPU 一半
    assert cli._worker_count(3, 10) == 3     # 显式请求优先
    assert cli._worker_count(None, 2) == 2   # 绝不超过位点数
    monkeypatch.setattr(cli.os, "cpu_count", lambda: 16)
    assert cli._worker_count(None, 10) == 4  # 默认封顶 4(worker 越多越易超时误判)
    assert cli._worker_count(8, 10) == 8     # 显式请求不受封顶影响
    monkeypatch.setattr(cli.os, "cpu_count", lambda: 1)
    assert cli._worker_count(None, 10) == 1  # 下限 1,不能算出 0 个 worker
    monkeypatch.setattr(cli.os, "cpu_count", lambda: None)
    assert cli._worker_count(None, 0) == 0   # cpu_count 不可用 -> 兜底 2 核


def test_discard_workspaces_tolerates_missing_trees(tmp_path):
    workspace = tmp_path / ".toolcache" / "mutate4py" / "ws-0"
    workspace.mkdir(parents=True)
    cli._discard_workspaces(str(tmp_path), [str(workspace)])
    assert not (tmp_path / ".toolcache" / "mutate4py").exists()
    assert (tmp_path / ".toolcache").exists()  # 只回收自己的目录
    cli._discard_workspaces(str(tmp_path), [str(workspace)])  # 再删一次不抛


def test_baseline_returns_exit_code_and_elapsed(tmp_path, monkeypatch):
    stamps = iter([100.0, 100.25])
    monkeypatch.setattr(cli, "time", SimpleNamespace(monotonic=lambda: next(stamps)))
    seen = []

    def run_shell(argv, cwd=None, **kwargs):
        seen.append(cwd)
        return SimpleNamespace(returncode=7)

    assert cli._baseline(str(tmp_path), ["pytest"], run_shell) == (7, 0.2)
    assert seen == [str(tmp_path)]


def test_run_suite_baselines_first_workspace_and_scales_timeout(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "_baseline", lambda ws, command, run_shell:
                        (calls.append(("baseline", ws)), (0, 3.0))[1])
    monkeypatch.setattr(cli, "_run_trials",
                        lambda workspaces, state, filtered, command, timeout, run_shell:
                        (calls.append(("trials", timeout)), {})[1])
    monkeypatch.setattr(cli, "_report_results",
                        lambda results, filtered: calls.append(("report",)) or False)
    monkeypatch.setattr(cli, "_write_manifest",
                        lambda state, filtered: calls.append(("manifest",)))
    assert cli._run_suite("state", {"timeout_factor": 10}, [], ["ws-0", "ws-1"],
                          ["pytest"], None) == 0
    assert calls == [("baseline", "ws-0"), ("trials", 30.0), ("report",),
                     ("manifest",)]


def test_run_trial_reports_elapsed_of_the_test_run(tmp_path, monkeypatch):
    stamps = iter([100.0, 100.25])
    monkeypatch.setattr(cli, "time", SimpleNamespace(monotonic=lambda: next(stamps)))
    workspace = tmp_path / "ws"
    (workspace / "pkg").mkdir(parents=True)
    source = "def f():\n    return 1\n"
    state = SimpleNamespace(relative=os.path.join("pkg", "m.py"), source=source)
    site = SimpleNamespace(mutated_source=lambda _src: "def f():\n    return 2\n")
    run_shell = lambda *args, **kwargs: SimpleNamespace(returncode=1)

    assert cli._run_trial(str(workspace), state, site, ["true"], 1, run_shell) \
        == ("killed", 0.2)


def test_report_results_numbers_sites_from_one_and_counts_timeouts(capsys):
    sites = [SimpleNamespace(line=2, description="int-swap"),
             SimpleNamespace(line=5, description="rhs->none")]
    results = {0: ("killed", 0.5), 1: ("timeout", 1.5)}
    assert cli._report_results(results, sites) is False
    out = capsys.readouterr().out
    assert out.startswith("[1/2] L2: int-swap ... killed (0.5s)")
    assert "[2/2] L5: rhs->none ... timeout (1.5s)" in out
    assert "score: 100.0% (2/2 killed, 1 timeout)" in out
