"""verify 子命令 —— 质量门禁。

用法:
  python tools/cli.py verify [--coverage]

默认 slim: 在项目根跑 pytest(config 由 pyproject.toml 提供)。任一测试失败
即退出码非 0(透传 pytest)。--coverage 在 coverage.py 插桩下运行测试并输出
覆盖率报告;coverage 未安装时业务失败(退出码 1)。

项目解释器优先取仓库 .venv/bin/python,否则当前解释器。
"""

from __future__ import annotations

import os
import subprocess
import sys

run = subprocess.run


def _usage() -> str:
    return (
        "用法: python tools/cli.py verify [--coverage]\n"
        "\n"
        "质量门禁: 默认 slim(pytest)是迭代与 handoff 前唯一硬地板。\n"
        "  --coverage  在 coverage.py 插桩下运行测试并输出 per-file 覆盖率\n"
    )


def usage() -> str:
    return _usage()


def project_python(repo_root: str) -> str:
    venv_python = os.path.join(repo_root, ".venv", "bin", "python")
    if os.path.isfile(venv_python) and os.access(venv_python, os.X_OK):
        return venv_python
    return sys.executable


def main(args, env=None) -> int:
    if any(arg in ("--help", "-h") for arg in args):
        sys.stdout.write(_usage())
        return 0
    env = dict(env or {})
    repo_root = env.get("repo_root") or os.getcwd()
    python = project_python(repo_root)
    coverage = "--coverage" in args

    if coverage:
        result = run([python, "-m", "coverage", "run", "--source=src", "-m", "pytest"],
                     cwd=repo_root)
        if result.returncode != 0:
            return result.returncode
        run([python, "-m", "coverage", "report", "-m"], cwd=repo_root)
        return 0

    result = run([python, "-m", "pytest"], cwd=repo_root)
    return result.returncode
