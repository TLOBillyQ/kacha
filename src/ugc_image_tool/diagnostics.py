"""脱敏日志与诊断包。

应用自动把连接检查、生成任务生命周期和结果下载问题写入大小受限的轮转
日志，用于本地定位问题。日志只记录时间、应用版本、任务编号、模型、状态
码、网关请求编号、状态迁移和脱敏错误类别，绝不记录 API 密钥、认证头、
图片内容、完整提示词或仍有效的临时下载地址。

诊断包导出前先向用户列出将包含的文件，导出时对全部内容再次执行脱敏；
导出过程只读日志，不收集任务记录、设置、凭据、图片或提示词，也不会改变
任何任务状态。所有日志写入失败都静默降级，不影响应用功能。
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import zipfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from threading import RLock
from typing import Protocol
from uuid import uuid4

from . import __version__
from .sanitize import redact_value, sanitize_text
from .settings import default_user_data_dir


LOG_FILENAME = "diagnostics.log"
ROTATION_INDEX_FORMAT = "diagnostics.{index}.log"
MANIFEST_FILENAME = "diagnostics-manifest.json"
DEFAULT_MAX_LOG_BYTES = 512 * 1024  # 轮转日志总容量上限：512 KB
DEFAULT_SEGMENT_BYTES = 256 * 1024  # 单段容量上限：256 KB


def app_version() -> str:
    """应用的版本号：优先读取已安装元数据，开发环境回退到包内常量。"""
    try:
        return version("ugc-image-tool")
    except PackageNotFoundError:
        return __version__


class DiagnosticSink(Protocol):
    """诊断事件的只读接收端；实现必须保证不修改任何任务状态。"""

    def task_transition(
        self,
        task_id: str,
        model: str,
        from_status: str | None,
        to_status: str,
        *,
        workflow: str | None = None,
        gateway_request_id: str | None = None,
        category: str | None = None,
        status_code: int | None = None,
        message: str | None = None,
    ) -> None: ...

    def connection(
        self,
        *,
        stage: str | None = None,
        ok: bool | None = None,
        category: str | None = None,
        status_code: int | None = None,
        message: str | None = None,
    ) -> None: ...

    def download(
        self,
        *,
        task_id: str | None = None,
        model: str | None = None,
        ok: bool,
        attempts: int | None = None,
        category: str | None = None,
        status_code: int | None = None,
        message: str | None = None,
    ) -> None: ...

    def system(self, message: str) -> None: ...


@dataclass(frozen=True)
class TaskTransitionEvent:
    """生成任务状态迁移的结构化事件字段。

    status 与 to_status 保持同值，供日志阅读者直接定位终态。
    """

    task_id: str
    model: str
    from_status: str | None
    to_status: str
    status: str
    workflow: str | None = None
    gateway_request_id: str | None = None
    category: str | None = None
    status_code: int | None = None
    message: str | None = None


@dataclass(frozen=True)
class ConnectionEvent:
    """模型发现或连接检查的一个结构化结果。"""

    stage: str | None = None
    ok: bool | None = None
    category: str | None = None
    status_code: int | None = None
    message: str | None = None


@dataclass(frozen=True)
class DownloadEvent:
    """结果下载/保存的结构化事件字段。"""

    task_id: str | None = None
    model: str | None = None
    ok: bool = True
    attempts: int | None = None
    category: str | None = None
    status_code: int | None = None
    message: str | None = None


@dataclass(frozen=True)
class SystemEvent:
    """应用启动、关闭或导出诊断包等系统事件。"""

    message: str


DiagnosticEvent = TaskTransitionEvent | ConnectionEvent | DownloadEvent | SystemEvent


class DiagnosticLogger:
    """大小受限的脱敏轮转日志；最新段为 diagnostics.log，随后依次为 .1、.2…

    所有字符串字段在写入前统一经过 sanitize 模块脱敏；写满单段后整体顺移，
    总量超过上限时删除最旧段。所有写入异常静默降级，不阻塞调用方。
    """

    def __init__(
        self,
        user_data_dir: Path | None = None,
        *,
        max_total_bytes: int = DEFAULT_MAX_LOG_BYTES,
        segment_bytes: int = DEFAULT_SEGMENT_BYTES,
    ) -> None:
        if max_total_bytes < 1 or segment_bytes < 1:
            raise ValueError("日志容量必须为正数")
        if max_total_bytes < segment_bytes:
            raise ValueError("日志总容量必须不小于单段容量")
        self._directory = (
            Path(user_data_dir)
            if user_data_dir is not None
            else default_user_data_dir()
        )
        try:
            self._directory.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass  # 目录不可写时日志静默降级，不阻止应用启动
        self._max_total_bytes = max_total_bytes
        self._segment_bytes = segment_bytes
        self._lock = RLock()

    @property
    def directory(self) -> Path:
        return self._directory

    @property
    def max_total_bytes(self) -> int:
        return self._max_total_bytes

    @property
    def total_bytes(self) -> int:
        with self._lock:
            return sum(_file_size(path) for _, path in self._segment_paths())

    def segments(self) -> tuple[Path, ...]:
        """最新到最旧的日志文件。"""
        with self._lock:
            return tuple(path for _, path in self._segment_paths())

    def log(self, event: str, **fields: object) -> None:
        """写一条脱敏日志；event 为事件类别，字段级脱敏集中在本方法。

        所有字段在写入前统一经过 sanitize 模块的 redact_value，按同一敏感
        字段名单做字段级替换；无法序列化的对象转为脱敏字符串。
        """
        record: dict[str, object] = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "app_version": app_version(),
            "event": event,
        }
        for key, value in fields.items():
            if value is not None:
                record[key] = redact_value(value, str(key))
        try:
            self._write(json.dumps(record, ensure_ascii=False) + "\n")
        except (OSError, TypeError):
            pass

    def _emit(self, event: str, value: DiagnosticEvent) -> None:
        """把结构化事件值展开为字段后写入；仅本处负责把事件转成日志。"""
        self.log(event, **asdict(value))

    def task_transition(
        self,
        task_id: str,
        model: str,
        from_status: str | None,
        to_status: str,
        *,
        workflow: str | None = None,
        gateway_request_id: str | None = None,
        category: str | None = None,
        status_code: int | None = None,
        message: str | None = None,
    ) -> None:
        """记录一次生成任务状态迁移（含提交、运行、终态与取消）。"""
        self._emit(
            "task",
            TaskTransitionEvent(
                task_id=task_id,
                model=model,
                from_status=from_status,
                to_status=to_status,
                status=to_status,
                workflow=workflow,
                gateway_request_id=gateway_request_id,
                category=category,
                status_code=status_code,
                message=message,
            ),
        )

    def connection(
        self,
        *,
        stage: str | None = None,
        ok: bool | None = None,
        category: str | None = None,
        status_code: int | None = None,
        message: str | None = None,
    ) -> None:
        """记录模型发现或连接检查的一个结果。"""
        self._emit(
            "connection",
            ConnectionEvent(
                stage=stage,
                ok=ok,
                category=category,
                status_code=status_code,
                message=message,
            ),
        )

    def download(
        self,
        *,
        task_id: str | None = None,
        model: str | None = None,
        ok: bool,
        attempts: int | None = None,
        category: str | None = None,
        status_code: int | None = None,
        message: str | None = None,
    ) -> None:
        """记录一次结果下载/保存的结果（失败时附带脱敏原因）。"""
        self._emit(
            "download",
            DownloadEvent(
                task_id=task_id,
                model=model,
                ok=ok,
                attempts=attempts,
                category=category,
                status_code=status_code,
                message=message,
            ),
        )

    def system(self, message: str) -> None:
        """记录应用启动、关闭或导出诊断包等系统事件。"""
        self._emit("system", SystemEvent(message=message))

    def _current_path(self) -> Path:
        return self._directory / LOG_FILENAME

    def _segment_paths(self) -> tuple[tuple[int, Path], ...]:
        """按 (序号, 路径) 返回日志段；序号 0 为最新段，段号必须连续。"""
        return tuple(
            (index, path) for index, path in enumerate(_log_segment_paths(self._directory))
        )

    def _write(self, line: str) -> None:
        with self._lock:
            current = self._current_path()
            try:
                size = current.stat().st_size if current.is_file() else 0
                if size + len(line.encode("utf-8")) > self._segment_bytes:
                    self._rotate()
                with current.open("a", encoding="utf-8", newline="") as stream:
                    stream.write(line)
                    stream.flush()
            except OSError:
                return
            self._enforce_capacity()

    def _rotate(self) -> None:
        """把现有段整体顺移一段：diagnostics.log -> .1 -> .2 …"""
        segments = self._segment_paths()
        oldest_index = segments[-1][0] if segments else 0
        for index in range(oldest_index, 0, -1):
            source = self._directory / ROTATION_INDEX_FORMAT.format(index=index)
            target = self._directory / ROTATION_INDEX_FORMAT.format(index=index + 1)
            try:
                source.replace(target)
            except OSError:
                pass
        current = self._current_path()
        try:
            if current.is_file():
                current.replace(self._directory / ROTATION_INDEX_FORMAT.format(index=1))
        except OSError:
            pass

    def _enforce_capacity(self) -> None:
        segments = self._segment_paths()
        total = sum(_file_size(path) for _, path in segments)
        for index, path in reversed(segments):
            if total <= self._max_total_bytes or index == 0:
                break
            size = _file_size(path)
            try:
                path.unlink()
            except OSError:
                continue
            total -= size


@dataclass(frozen=True)
class PackageEntry:
    """诊断包将包含的一个文件；导出前向用户逐项列出。"""

    name: str
    description: str
    size: int


class DiagnosticExporter:
    """按清单导出诊断包；导出时对每个文件再次执行脱敏。

    只包含轮转日志与说明文件。preview() 与 export() 使用同一份清单计算，
    不会夹带清单之外的用户数据。
    """

    SCHEMA_VERSION = 1

    def __init__(self, user_data_dir: Path | None = None) -> None:
        self._directory = (
            Path(user_data_dir)
            if user_data_dir is not None
            else default_user_data_dir()
        )

    @property
    def directory(self) -> Path:
        return self._directory

    def preview(self) -> tuple[PackageEntry, ...]:
        """导出前列出将包含的全部文件及其大小。"""
        entries: list[PackageEntry] = []
        for index, path in enumerate(self._log_files()):
            if index == 0:
                description = "脱敏轮转日志（最新）"
            else:
                description = f"脱敏轮转日志（较早，第 {index + 1} 段）"
            entries.append(PackageEntry(path.name, description, _file_size(path)))
        entries.append(
            PackageEntry(
                MANIFEST_FILENAME,
                "诊断包说明与文件清单（导出时生成）",
                0,
            )
        )
        return tuple(entries)

    def export(self, target: Path) -> tuple[PackageEntry, ...]:
        """把诊断包写入 target，返回实际包含的文件清单。

        导出过程再次执行脱敏；只包含 preview() 列出的文件，不读取任何其他
        用户数据，也不修改任务或设置状态。
        """
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        entries = self.preview()
        log_entries = [entry for entry in entries if entry.name != MANIFEST_FILENAME]
        manifest = {
            "schema_version": self.SCHEMA_VERSION,
            "app_version": app_version(),
            "exported_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "note": (
                "本诊断包仅包含下方列出的脱敏轮转日志与说明文件；"
                "不包含任务记录、设置、凭据、图片内容、提示词或临时地址。"
                "导出时已对全部内容再次执行脱敏。"
            ),
            "files": [
                {
                    "name": entry.name,
                    "size": entry.size,
                    "description": entry.description,
                }
                for entry in entries
            ],
        }
        staging = Path(
            tempfile.mkdtemp(prefix=".ugc-diag-", dir=str(self._directory))
        )
        temporary_zip: Path | None = None
        try:
            for entry in log_entries:
                (staging / entry.name).write_text(
                    _sanitize_file(self._directory / entry.name),
                    encoding="utf-8",
                    newline="",
                )
            (staging / MANIFEST_FILENAME).write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="",
            )
            temporary_zip = target.parent / f".{target.name}.{uuid4().hex}.tmp"
            with zipfile.ZipFile(
                temporary_zip, "w", compression=zipfile.ZIP_DEFLATED
            ) as archive:
                for entry in entries:
                    archive.write(staging / entry.name, arcname=entry.name)
            os.replace(temporary_zip, target)
        finally:
            if temporary_zip is not None:
                temporary_zip.unlink(missing_ok=True)
            shutil.rmtree(staging, ignore_errors=True)
        return entries

    def _log_files(self) -> tuple[Path, ...]:
        return _log_segment_paths(self._directory)


def _log_segment_paths(directory: Path) -> tuple[Path, ...]:
    """最新到最旧的日志段；段号必须连续，出现空洞即停止。

    记录器与导出器共用同一套段枚举，保证两者对日志清单的理解一致。
    """
    files: list[Path] = []
    index = 0
    while True:
        path = (
            directory / LOG_FILENAME
            if index == 0
            else directory / ROTATION_INDEX_FORMAT.format(index=index)
        )
        if not path.is_file():
            break
        files.append(path)
        index += 1
    return tuple(files)


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _sanitize_file(path: Path) -> str:
    """整份日志再次脱敏：按行解析字段级清洁后拼接。

    与 DiagnosticLogger.log 使用同一个递归脱敏器与同一敏感字段名单；
    无法解析为结构化记录的残行退回到整行字符串脱敏，保证导出包不会
    明显泄漏密钥或临时地址。
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    lines: list[str] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        lines.append(_sanitize_record_line(line))
    return "\n".join(lines) + "\n"


def _sanitize_record_line(line: str) -> str:
    """把一行日志按结构化记录做字段级脱敏；非 JSON 残行做整行脱敏。"""
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        return sanitize_text(line)
    if not isinstance(record, dict):
        return sanitize_text(line)
    cleaned = redact_value(record)
    if not isinstance(cleaned, dict):
        return sanitize_text(line)
    return json.dumps(cleaned, ensure_ascii=False)