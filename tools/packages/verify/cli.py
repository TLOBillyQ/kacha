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

HELP_TOKENS = ("--help", "-h")

#: 被测代码目录 —— coverage --source 口径,与 crap4py / mutate4py 的默认一致。
DEFAULT_SOURCE = "src"


def project_python(repo_root: str) -> str:
    """优先取仓库 .venv/bin/python,否则当前解释器。"""
    venv_python = os.path.join(repo_root, ".venv", "bin", "python")
    if os.path.isfile(venv_python) and os.access(venv_python, os.X_OK):
        return venv_python
    return sys.executable


def repo_root_from(env) -> str:
    """工作根:env 里的 repo_root 优先,否则当前目录。"""
    return (env or {}).get("repo_root") or os.getcwd()


def wants_help(args) -> bool:
    """帮助 token 出现在任意位置即生效。"""
    return any(token in HELP_TOKENS for token in args)


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
    source = DEFAULT_SOURCE
    result = run([python, "-m", "coverage", "run", f"--source={source}",
                  "-m", "pytest"], cwd=repo_root)
    if result.returncode != 0:
        return result.returncode
    run([python, "-m", "coverage", "report", "-m"], cwd=repo_root)
    return 0

# mutate4py-manifest
# version=4
# projectHash=246331e79911bcdd
# scope.0.id=cli.project_python
# scope.0.kind=function
# scope.0.startLine=27
# scope.0.endLine=32
# scope.0.semanticHash=2be828b94ebae928
# scope.1.id=cli.repo_root_from
# scope.1.kind=function
# scope.1.startLine=35
# scope.1.endLine=37
# scope.1.semanticHash=b3b81587b468cbca
# scope.2.id=cli.wants_help
# scope.2.kind=function
# scope.2.startLine=40
# scope.2.endLine=42
# scope.2.semanticHash=4c2a9599d93e5b20
# scope.3.id=cli.usage
# scope.3.kind=function
# scope.3.startLine=45
# scope.3.endLine=51
# scope.3.semanticHash=45fee6793c6934d4
# scope.4.id=cli.main
# scope.4.kind=function
# scope.4.startLine=54
# scope.4.endLine=62
# scope.4.semanticHash=08393c75e626df03
# scope.5.id=cli._run_with_coverage
# scope.5.kind=function
# scope.5.startLine=65
# scope.5.endLine=73
# scope.5.semanticHash=5e6a020d968d4087
