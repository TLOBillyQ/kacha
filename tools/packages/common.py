"""工具包共享小工具:项目解释器解析、源文件读取、函数作用域提取与选项走查。"""

from __future__ import annotations

import dataclasses
import os
import sys
from typing import Callable

HELP_TOKENS = ("--help", "-h")

#: positional 语义:0 不允许位置参数;1 至多一个;-1 收集任意未知 token。
POSITIONAL_NONE, POSITIONAL_SINGLE, POSITIONAL_ANY = 0, 1, -1


def project_python(repo_root: str) -> str:
    """优先取仓库 .venv/bin/python,否则当前解释器。"""
    venv_python = os.path.join(repo_root, ".venv", "bin", "python")
    if os.path.isfile(venv_python) and os.access(venv_python, os.X_OK):
        return venv_python
    return sys.executable


def repo_root_from(env) -> str:
    """子命令工作根:env 里的 repo_root 优先,否则当前目录。"""
    return (env or {}).get("repo_root") or os.getcwd()


def wants_help(args) -> bool:
    """帮助 token 出现在任意位置即生效(顶层调度器已先拦截,这里是直调兜底)。"""
    return any(token in HELP_TOKENS for token in args)


def escapes_root(path: str, root: str) -> bool:
    """path 是否落在 root 之外。"""
    return os.path.relpath(path, root).startswith("..")


def relative_path(path: str, root: str) -> str:
    """相对 root 的展示路径;越出 root 时退回原路径。"""
    return path if escapes_root(path, root) else os.path.relpath(path, root)


def python_files(paths) -> list[str]:
    """展开目录中的 .py 文件;非目录路径原样保留;整体按路径排序。"""
    files: list[str] = []
    for path in paths:
        files.extend(_python_paths_under(path))
    return sorted(files)


def _python_paths_under(path: str) -> list[str]:
    if not os.path.isdir(path):
        return [str(path)]
    return [os.path.join(root, name)
            for root, _dirs, names in os.walk(path)
            for name in names if name.endswith(".py")]


def read_sources(paths) -> list[tuple[str, str]]:
    """读取 paths 下的源文件,跳过不可读文件;返回 [(路径, 源码)]。"""
    documents: list[tuple[str, str]] = []
    for file_path in python_files(paths):
        try:
            with open(file_path, encoding="utf-8") as handle:
                documents.append((file_path, handle.read()))
        except OSError:
            continue
    return documents


@dataclasses.dataclass(frozen=True)
class Option:
    """一个命令行选项:token -> dest;convert 为 None 表示布尔旗标。"""

    token: str
    dest: str
    convert: Callable[[str], object] | None = None
    value: object = True

    @property
    def takes_value(self) -> bool:
        return self.convert is not None


def Flag(token: str, dest: str, value: object = True) -> Option:
    """旗标选项:命中即置 value。"""
    return Option(token=token, dest=dest, value=value)


def Value(token: str, dest: str, convert: Callable[[str], object] = str) -> Option:
    """取值选项:吃掉下一个 token 并转换。"""
    return Option(token=token, dest=dest, convert=convert)


def as_float(text: str) -> float:
    """浮点选项转换器;坏值抛空消息,由走查器给出统一的 numeric 文案。"""
    return _converted(float, text)


def as_int(text: str) -> int:
    """整数选项转换器;坏值走同一条空消息约定。"""
    return _converted(int, text)


def _converted(cast: Callable[[str], object], text: str):
    try:
        return cast(text)
    except ValueError:
        raise ValueError("") from None


def parse_tokens(args, *, flags, values, positional: int = POSITIONAL_NONE,
                 unknown_verb: str = "未知参数"):
    """共享选项走查 —— 三个子命令的解析循环在此收敛为一份机制 + 各自数据表。

    返回 (options, paths, error):error 为 None 表示解析成功,否则是错误正文
    (调用方决定退出码、前缀与输出流)。缺值按空串交给转换器;自定义转换器可抛
    带正文的 ValueError(如 --lines),坏数值则统一报 "requires a numeric value"。
    """
    table = _option_table(flags, values)
    options: dict = {}
    paths: list[str] = []
    index = 0
    while index < len(args):
        token = args[index]
        index += 1
        option = table.get(token)
        if option is None:
            if not _accepts_positional(token, paths, positional):
                return options, paths, f"{unknown_verb}: {token}"
            paths.append(token)
            continue
        failure = _apply_option(option, args, index, options)
        index += 1 if option.takes_value else 0
        if failure:
            return options, paths, failure
    return options, paths, None


def _option_table(flags, values) -> dict[str, Option]:
    """token -> Option 查询表(旗标与取值项同一张表)。"""
    return {option.token: option for option in (*flags, *values)}


def _apply_option(option: Option, args, index: int, options: dict) -> str | None:
    """落一个选项的值;返回错误正文或 None。"""
    if not option.takes_value:
        options[option.dest] = option.value
        return None
    raw = args[index] if index < len(args) else ""
    try:
        options[option.dest] = option.convert(raw)
    except ValueError as exc:
        # 转换器可自带正文(如 --lines);空正文回落为统一 numeric 文案
        return str(exc) or f"{option.token} requires a numeric value"
    return None


def _accepts_positional(token: str, paths: list[str], positional: int) -> bool:
    """位置参数额度:任意收串、单个(不得以 -- 开头)、或不收。"""
    if positional == POSITIONAL_ANY:
        return True
    return (positional == POSITIONAL_SINGLE and len(paths) < positional
            and not token.startswith("--"))

# mutate4py-manifest
# version=4
# projectHash=c89f04499c1d1dbd
# scope.0.id=common.project_python
# scope.0.kind=function
# scope.0.startLine=16
# scope.0.endLine=21
# scope.0.semanticHash=2be828b94ebae928
# scope.1.id=common.repo_root_from
# scope.1.kind=function
# scope.1.startLine=24
# scope.1.endLine=26
# scope.1.semanticHash=b3b81587b468cbca
# scope.2.id=common.wants_help
# scope.2.kind=function
# scope.2.startLine=29
# scope.2.endLine=31
# scope.2.semanticHash=4c2a9599d93e5b20
# scope.3.id=common.escapes_root
# scope.3.kind=function
# scope.3.startLine=34
# scope.3.endLine=36
# scope.3.semanticHash=5e5d4cc143cb684e
# scope.4.id=common.relative_path
# scope.4.kind=function
# scope.4.startLine=39
# scope.4.endLine=41
# scope.4.semanticHash=162afd6bec7cbca1
# scope.5.id=common.python_files
# scope.5.kind=function
# scope.5.startLine=44
# scope.5.endLine=49
# scope.5.semanticHash=23cfd97ed423331c
# scope.6.id=common._python_paths_under
# scope.6.kind=function
# scope.6.startLine=52
# scope.6.endLine=57
# scope.6.semanticHash=8e51d14b3bdf621d
# scope.7.id=common.read_sources
# scope.7.kind=function
# scope.7.startLine=60
# scope.7.endLine=69
# scope.7.semanticHash=b6588705bdc3dd96
# scope.8.id=common.Option.takes_value
# scope.8.kind=method
# scope.8.startLine=82
# scope.8.endLine=83
# scope.8.semanticHash=866b3480c164094f
# scope.9.id=common.Flag
# scope.9.kind=function
# scope.9.startLine=86
# scope.9.endLine=88
# scope.9.semanticHash=f42bd362813ae348
# scope.10.id=common.Value
# scope.10.kind=function
# scope.10.startLine=91
# scope.10.endLine=93
# scope.10.semanticHash=8795095019d9afee
# scope.11.id=common.as_float
# scope.11.kind=function
# scope.11.startLine=96
# scope.11.endLine=98
# scope.11.semanticHash=a2bb47deb8c2cab6
# scope.12.id=common.as_int
# scope.12.kind=function
# scope.12.startLine=101
# scope.12.endLine=103
# scope.12.semanticHash=a2bb47deb8c2cab6
# scope.13.id=common._converted
# scope.13.kind=function
# scope.13.startLine=106
# scope.13.endLine=110
# scope.13.semanticHash=0e377220b90c1123
# scope.14.id=common.parse_tokens
# scope.14.kind=function
# scope.14.startLine=113
# scope.14.endLine=138
# scope.14.semanticHash=aa23b3a707c21ed7
# scope.15.id=common._option_table
# scope.15.kind=function
# scope.15.startLine=141
# scope.15.endLine=143
# scope.15.semanticHash=f0847ef613066bb8
# scope.16.id=common._apply_option
# scope.16.kind=function
# scope.16.startLine=146
# scope.16.endLine=157
# scope.16.semanticHash=36711a731fbdecab
# scope.17.id=common._accepts_positional
# scope.17.kind=function
# scope.17.startLine=160
# scope.17.endLine=165
# scope.17.semanticHash=8ba6f646c270c3ea
