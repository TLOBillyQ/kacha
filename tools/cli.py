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

# 以脚本方式运行时仓库根不在 sys.path,补上以便 import tools.packages.*
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

COMMANDS = [
    ("verify", "质量门禁: 默认 slim(pytest 硬地板); --coverage"),
    ("crap", "CRAP 热点分析(圈复杂度 x 覆盖率)"),
    ("dry", "结构重复检测(AST 归一化 + Jaccard)"),
    ("mutate", "单文件变异测试(manifest 差分)"),
]


def _usage() -> str:
    lines = ["用法: python tools/cli.py <子命令> [args...]", "", "子命令(封闭命令集):"]
    for name, summary in COMMANDS:
        lines.append(f"  {name:<18} {summary}")
    lines += ["", "  python tools/cli.py <子命令> --help   子命令帮助"]
    return "\n".join(lines) + "\n"


def _load_package(name: str):
    module = importlib.import_module(f"tools.packages.{name}.cli")
    main = getattr(module, "main", None)
    usage = getattr(module, "usage", None)
    if not callable(main) or not callable(usage):
        raise AttributeError(f"bad package shape: tools.packages.{name}.cli")
    return module


def main(argv=None, env=None, packages=None) -> int:
    argv = list(argv or [])
    if argv and argv[0] in ("--help", "-h"):
        sys.stdout.write(_usage())
        return 0
    if not argv:
        sys.stderr.write(_usage())
        return 2

    name, rest = argv[0], argv[1:]
    entry = next((c for c in COMMANDS if c[0] == name), None)
    if entry is None:
        sys.stderr.write(f"未知子命令: {name}\n\n{_usage()}")
        return 2

    if packages is None:
        packages = {}
    pkg = packages.get(name) if packages else None
    if pkg is None:
        try:
            pkg = _load_package(name)
        except Exception as exc:  # noqa: BLE001 - report any load failure
            sys.stderr.write(f"子命令加载失败: {name} (tools.packages.{name}.cli)\n")
            sys.stderr.write(f"{exc}\n\n{_usage()}")
            return 2

    if any(arg in ("--help", "-h") for arg in rest):
        sys.stdout.write(pkg.usage())
        return 0

    env = dict(env or {})
    env.setdefault("repo_root", os.getcwd())
    env.setdefault("command", f"python tools/cli.py {name}")
    return int(pkg.main(rest, env) or 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
