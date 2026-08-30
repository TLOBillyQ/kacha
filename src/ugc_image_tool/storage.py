"""共享原子写入与原子替换工具。

所有把用户数据落到磁盘的调用点都复用本模块，保证统一的
“临时文件 + 完整写入 + fsync + 原子替换”语义：普通设置、模型列表缓存、
个人预设、生成结果与任务记录都不再各自实现这套流程。

写入失败时清理临时文件并向上抛出 OSError，由调用方决定如何降级；
成功替换后不留下任何 .tmp 残留。
"""

from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4


def atomic_write_text(
    path: Path,
    text: str,
    *,
    encoding: str = "utf-8",
    newline: str = "",
) -> None:
    """把文本完整写入临时文件并 fsync 后原子替换到 path。"""
    _atomic_write(path, text.encode(encoding), encoding=encoding, newline=newline)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """把字节完整写入临时文件并 fsync 后原子替换到 path。"""
    _atomic_write(path, data, encoding=None, newline=None)


def atomic_replace(source: Path, target: Path) -> None:
    """原子替换目标文件；源文件必须已经完整写入并 fsync。"""
    os.replace(source, target)


def _atomic_write(
    path: Path,
    data: bytes,
    *,
    encoding: str | None,
    newline: str | None,
) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.parent / f".{target.name}.{uuid4().hex}.tmp"
    try:
        if encoding is None:
            with temporary.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        else:
            with temporary.open("x", encoding=encoding, newline=newline) as stream:
                stream.write(data.decode(encoding))
                stream.flush()
                os.fsync(stream.fileno())
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
