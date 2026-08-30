"""tools/cli.py —— 工具链唯一对外面。

用法:
  python tools/cli.py <子命令> [args...]
  python tools/cli.py --help | -h

调度机制:顶层静态路由表 COMMANDS(封闭命令集) -> 查表 ->
import tools.packages.<pkg>.cli -> cli.main(args, env) -> 退出码透传。

退出码约定:0 = 成功 / 1 = 业务失败 / 2 = 用法错误(未知子命令、加载失败)。
各子命令自己的退出码见其 cli.py usage()。
"""

from __future__ import annotations

import importlib
import os
import sys

# 以脚本方式运行时仓库根不在 sys.path,先补上,才能 import tools.packages.*
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tools.packages.common import HELP_TOKENS, wants_help  # noqa: E402

COMMANDS = [
    ("verify", "质量门禁: 默认 slim(pytest 硬地板); --coverage"),
    ("crap", "CRAP 热点分析(圈复杂度 x 覆盖率)"),
    ("dry", "结构重复检测(AST 归一化 + Jaccard)"),
    ("mutate", "单文件变异测试(manifest 差分)"),
]

_COMMAND_NAMES = frozenset(name for name, _summary in COMMANDS)


def usage() -> str:
    """顶层用法(封闭命令集)。"""
    lines = ["用法: python tools/cli.py <子命令> [args...]", "", "子命令(封闭命令集):"]
    for name, summary in COMMANDS:
        lines.append(f"  {name:<18} {summary}")
    lines += ["", "  python tools/cli.py <子命令> --help   子命令帮助"]
    return "\n".join(lines) + "\n"


def _load_package(name: str):
    """按约定装载 tools.packages.<name>.cli;形状不合视为加载失败。"""
    module = importlib.import_module(f"tools.packages.{name}.cli")
    if not all(callable(getattr(module, attr, None)) for attr in ("main", "usage")):
        raise AttributeError(f"bad package shape: tools.packages.{name}.cli")
    return module


def _package_for(name: str, packages):
    """packages 为测试注入口;None 时走真实 import。返回 (pkg, 退出码)。"""
    if packages is not None:
        package = packages.get(name)
        if package is None:
            return None, "package not registered\n"
        return package, None
    try:
        return _load_package(name), None
    except Exception as exc:  # noqa: BLE001 - 任何加载失败都归用法错误
        return None, f"{exc}\n"  # 详情自带换行,调用方只补空行


def main(argv=None, env=None, packages=None) -> int:
    tokens = list(argv or [])
    if not tokens:
        sys.stderr.write(usage())
        return 2
    name, rest = tokens[0], tokens[1:]
    if name in HELP_TOKENS:
        sys.stdout.write(usage())
        return 0
    if name not in _COMMAND_NAMES:
        sys.stderr.write(f"未知子命令: {name}\n\n{usage()}")
        return 2
    return _dispatch(name, rest, env, packages)


def _dispatch(name: str, rest, env, packages) -> int:
    package, detail = _package_for(name, packages)
    if detail is not None:
        return _load_failure(name, detail)
    if wants_help(rest):
        sys.stdout.write(package.usage())
        return 0
    return _invoke(package, name, rest, env)


def _load_failure(name: str, detail: str) -> int:
    sys.stderr.write(f"子命令加载失败: {name} (tools.packages.{name}.cli)\n")
    sys.stderr.write(f"{detail}\n{usage()}")
    return 2


def _invoke(package, name: str, rest, env) -> int:
    env = dict(env or {})
    env.setdefault("repo_root", os.getcwd())
    env.setdefault("command", f"python tools/cli.py {name}")
    return int(package.main(rest, env) or 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

# mutate4py-manifest
# version=4
# projectHash=63353a3445f386d9
# scope.0.id=cli.usage
# scope.0.kind=function
# scope.0.startLine=37
# scope.0.endLine=43
# scope.0.semanticHash=c6c1a213b6b23ad9
# scope.1.id=cli._load_package
# scope.1.kind=function
# scope.1.startLine=46
# scope.1.endLine=51
# scope.1.semanticHash=afe85b783cac33e8
# scope.2.id=cli._package_for
# scope.2.kind=function
# scope.2.startLine=54
# scope.2.endLine=64
# scope.2.semanticHash=6863e93dca73ed97
# scope.3.id=cli.main
# scope.3.kind=function
# scope.3.startLine=67
# scope.3.endLine=79
# scope.3.semanticHash=1ab186b8ca030025
# scope.4.id=cli._dispatch
# scope.4.kind=function
# scope.4.startLine=82
# scope.4.endLine=89
# scope.4.semanticHash=73d17113edaf6e5a
# scope.5.id=cli._load_failure
# scope.5.kind=function
# scope.5.startLine=92
# scope.5.endLine=95
# scope.5.semanticHash=d7d686502b04bd9a
# scope.6.id=cli._invoke
# scope.6.kind=function
# scope.6.startLine=98
# scope.6.endLine=102
# scope.6.semanticHash=65a9c6c3b98def86
