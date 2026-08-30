"""coverage.py 产物适配层 —— crap 与 mutate 共用的唯一覆盖率入口。

不变量:覆盖率只来自生态标准工具的固定产物 `coverage json`(绝不虚构数字)。
三步流水线固定为 erase -> run --source=<source> -m pytest -> json -o <artifact>。

本模块只做"取数与读文件":测试失败还是继续、缺数据算不算 0,由各子命令自己决定
(crap 以部分数据继续并告警,mutate 放弃行过滤并告警)。
"""

from __future__ import annotations

import dataclasses
import json
import os
import subprocess
from typing import Callable

run = subprocess.run

STEP_TESTS = 1

#: 被测代码的默认目录 —— coverage --source 的统一口径(crap/verify/mutate 共用)。
DEFAULT_SOURCE = "src"

#: coverage json 产物在项目内的固定位置(相对仓库根)。
ARTIFACT_RELPATH = (".toolcache", "coverage.json")


def artifact_path(repo_root: str) -> str:
    return os.path.join(repo_root, *ARTIFACT_RELPATH)


def pipeline(python: str, source: str, artifact: str) -> list[list[str]]:
    """三步流水线的命令行(单一事实来源)。"""
    return [
        [python, "-m", "coverage", "erase"],
        [python, "-m", "coverage", "run", f"--source={source}", "-m", "pytest"],
        [python, "-m", "coverage", "json", "-o", artifact],
    ]


@dataclasses.dataclass(frozen=True)
class Collection:
    """流水线结果:产物是否可用、被测测试是否失败、首个失败退出码。"""

    artifact_ok: bool
    tests_failed: bool
    returncode: int = 0


def collect(python: str, repo_root: str, source: str,
            run_shell: Callable = run) -> Collection:
    """跑完整流水线;除测试外的任一步失败都使产物不可用。"""
    artifact = artifact_path(repo_root)
    tests_failed = False
    for index, command in enumerate(pipeline(python, source, artifact)):
        result = run_shell(command, cwd=repo_root)
        if result.returncode == 0:
            continue
        if index == STEP_TESTS:
            tests_failed = True
            continue
        return Collection(artifact_ok=False, tests_failed=tests_failed,
                          returncode=result.returncode)
    return Collection(artifact_ok=True, tests_failed=tests_failed)


def load(repo_root: str) -> dict:
    """读取产物;coverage 未安装/产物缺失时抛出 OSError 或 ValueError。"""
    with open(artifact_path(repo_root), encoding="utf-8") as handle:
        payload = json.load(handle)
    return normalize_files(payload.get("files", {}), repo_root)


def normalize_files(files: dict, repo_root: str) -> dict:
    """coverage json 的键相对 cwd(仓库根),统一归一化为绝对路径键。"""
    return {_as_absolute(key, repo_root): value for key, value in files.items()}


@dataclasses.dataclass(frozen=True)
class FileData:
    """单个文件在 coverage 产物里的行级事实。

    measured = executed ∪ missing,即 coverage.py 自己认定的语句行:续行、docstring
    与 pragma: no cover 排除行都不在其中。归因覆盖率必须用它作分母,否则把多行语句
    的每一行都当成未执行,CRAP 会被系统性高估。
    """

    executed: set[int]
    measured: set[int]


def file_data(files: dict, target: str) -> FileData | None:
    """目标文件的行级事实;产物里没有该文件时返回 None。"""
    entry = _entry_for(files, target)
    if entry is None:
        return None
    executed = set(entry.get("executed_lines", []))
    return FileData(executed=executed,
                    measured=executed | set(entry.get("missing_lines", [])))


def covered_lines(files: dict, target: str) -> set[int] | None:
    """目标文件的已执行行;无该文件数据返回 None(匹配绝对路径或路径后缀)。"""
    data = file_data(files, target)
    return None if data is None else data.executed


def _entry_for(files: dict, target: str) -> dict | None:
    entry = files.get(target)
    if entry is not None:
        return entry
    tail = "/" + target
    return next((value for key, value in files.items() if key.endswith(tail)), None)


def _as_absolute(key: str, repo_root: str) -> str:
    return key if os.path.isabs(key) else os.path.abspath(
        os.path.join(repo_root, key))

# mutate4py-manifest
# version=4
# projectHash=0e2f67c71932c902
# scope.0.id=covdata.artifact_path
# scope.0.kind=function
# scope.0.startLine=29
# scope.0.endLine=30
# scope.0.semanticHash=32435710ba161d5b
# scope.1.id=covdata.pipeline
# scope.1.kind=function
# scope.1.startLine=33
# scope.1.endLine=39
# scope.1.semanticHash=87ddd6b164bb0167
# scope.2.id=covdata.collect
# scope.2.kind=function
# scope.2.startLine=51
# scope.2.endLine=65
# scope.2.semanticHash=301945816ccf59ca
# scope.3.id=covdata.load
# scope.3.kind=function
# scope.3.startLine=68
# scope.3.endLine=72
# scope.3.semanticHash=49245cd852094e52
# scope.4.id=covdata.normalize_files
# scope.4.kind=function
# scope.4.startLine=75
# scope.4.endLine=77
# scope.4.semanticHash=3f31327381d0e204
# scope.5.id=covdata.file_data
# scope.5.kind=function
# scope.5.startLine=93
# scope.5.endLine=100
# scope.5.semanticHash=466635e4b405e3b2
# scope.6.id=covdata.covered_lines
# scope.6.kind=function
# scope.6.startLine=103
# scope.6.endLine=106
# scope.6.semanticHash=6238e64d0b219314
# scope.7.id=covdata._entry_for
# scope.7.kind=function
# scope.7.startLine=109
# scope.7.endLine=114
# scope.7.semanticHash=669bd4b055012130
# scope.8.id=covdata._as_absolute
# scope.8.kind=function
# scope.8.startLine=117
# scope.8.endLine=119
# scope.8.semanticHash=75525e51adf3601f
