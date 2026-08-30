"""verify 子命令 —— 质量门禁。

用法:
  python tools/cli.py verify [--coverage]

默认 slim: 在项目根跑 pytest(config 由 pyproject.toml 提供)。任一测试失败
即退出码非 0(透传 pytest)。--coverage 在 coverage.py 插桩下运行测试并输出
覆盖率报告;coverage 未安装时业务失败(退出码 1)。

项目解释器优先取仓库 .venv/bin/python,否则当前解释器。
"""

from __future__ import annotations

import subprocess
import sys

from .. import covdata
from ..common import project_python, repo_root_from, wants_help

run = subprocess.run


def usage() -> str:
    return (
        "用法: python tools/cli.py verify [--coverage]\n"
        "\n"
        "质量门禁: 默认 slim(pytest)是迭代与 handoff 前唯一硬地板。\n"
        "  --coverage  在 coverage.py 插桩下运行测试并输出 per-file 覆盖率\n"
    )


def main(args, env=None) -> int:
    if wants_help(args):
        sys.stdout.write(usage())
        return 0
    repo_root = repo_root_from(env)
    python = project_python(repo_root)
    if "--coverage" in args:
        return _run_with_coverage(python, repo_root)
    return run([python, "-m", "pytest"], cwd=repo_root).returncode


def _run_with_coverage(python: str, repo_root: str) -> int:
    """coverage.py 插桩跑测试:测试失败即透传退出码,不跑报告。"""
    source = covdata.DEFAULT_SOURCE
    result = run([python, "-m", "coverage", "run", f"--source={source}",
                  "-m", "pytest"], cwd=repo_root)
    if result.returncode != 0:
        return result.returncode
    run([python, "-m", "coverage", "report", "-m"], cwd=repo_root)
    return 0
