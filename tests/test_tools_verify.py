"""verify 子命令：slim 硬地板（pytest）与 --coverage（coverage.py 产物）。"""

from __future__ import annotations

import os
from types import SimpleNamespace

from tools.packages import verify


def fake_run(calls):
    def run(argv, cwd=None, **kwargs):
        calls.append((list(argv), cwd))
        return SimpleNamespace(returncode=0)
    return run


def test_help_prints_usage(capsys):
    code = verify.cli.main(["--help"], {"repo_root": "/r"})
    assert code == 0
    assert "verify" in capsys.readouterr().out


def test_slim_runs_pytest_in_repo_root(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(verify.cli, "run", fake_run(calls))
    (tmp_path / ".venv" / "bin").mkdir(parents=True)
    (tmp_path / ".venv" / "bin" / "python").write_text("#!/bin/sh\n")
    os.chmod(tmp_path / ".venv" / "bin" / "python", 0o755)
    code = verify.cli.main([], {"repo_root": str(tmp_path)})
    assert code == 0
    assert calls[0][0][-2:] == ["-m", "pytest"]
    assert calls[0][1] == str(tmp_path)
    assert calls[0][0][0].endswith(".venv/bin/python")


def test_slim_passes_through_failure(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(
        verify.cli,
        "run",
        lambda argv, cwd=None, **kw: (calls.append((list(argv), cwd)),
                                     SimpleNamespace(returncode=5))[1],
    )
    assert verify.cli.main([], {"repo_root": str(tmp_path)}) == 5


def test_coverage_runs_and_reports(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(
        verify.cli,
        "run",
        lambda argv, cwd=None, **kw: (calls.append((list(argv), cwd)),
                                     SimpleNamespace(returncode=0))[1],
    )
    code = verify.cli.main(["--coverage"], {"repo_root": str(tmp_path)})
    assert code == 0
    assert any("coverage" in a[0] for a in calls)
    assert calls[-1][0][-2:] == ["report", "-m"]


def test_falls_back_to_current_interpreter(monkeypatch, tmp_path):
    calls = []
    run = fake_run(calls)
    monkeypatch.setattr(verify.cli, "run", run)
    monkeypatch.setattr("tools.packages.common.sys.executable", "/usr/bin/python")
    assert verify.cli.main([], {"repo_root": str(tmp_path)}) == 0
    assert not calls[0][0][0].endswith(".venv/bin/python")
