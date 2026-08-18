from __future__ import annotations

import json
import os
import re
import struct
from urllib.parse import urlparse
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Protocol
from uuid import uuid4

import httpx

from .generation import GeneratedImage, GenerationTask
from .references import ReferenceImage


MAX_RESULT_DOWNLOAD_ATTEMPTS = 3
_DOWNLOAD_CHUNK_BYTES = 64 * 1024
_TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
_MEDIA_FORMATS = {
    "png": ("image/png", ".png"),
    "jpeg": ("image/jpeg", ".jpg"),
    "jpg": ("image/jpeg", ".jpg"),
    "webp": ("image/webp", ".webp"),
    "gif": ("image/gif", ".gif"),
    "bmp": ("image/bmp", ".bmp"),
    "tiff": ("image/tiff", ".tiff"),
}


@dataclass(frozen=True)
class DownloadedImage:
    content: bytes
    media_type: str | None = None


class ImageFetcher(Protocol):
    def fetch(self, url: str) -> DownloadedImage: ...


class UrlImageFetcher:
    """下载临时图片地址；不携带网关认证信息。"""

    def __init__(self, timeout_seconds: float = 60.0) -> None:
        if timeout_seconds <= 0:
            raise ValueError("图片下载超时必须大于 0 秒")
        self._client = httpx.Client(
            timeout=timeout_seconds,
            follow_redirects=True,
            headers={"Accept": "image/*"},
        )

    def fetch(self, url: str) -> DownloadedImage:
        if urlparse(url).scheme.lower() not in {"http", "https"}:
            raise ValueError("图片临时地址仅支持 HTTP 或 HTTPS")
        with self._client.stream("GET", url) as response:
            response.raise_for_status()
            chunks: list[bytes] = []
            for chunk in response.iter_bytes(_DOWNLOAD_CHUNK_BYTES):
                chunks.append(chunk)
            content = b"".join(chunks)
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    expected_length = int(content_length)
                except ValueError as error:
                    raise OSError("图片下载响应的 Content-Length 无效") from error
                if expected_length != len(content):
                    raise OSError("图片下载不完整")
            return DownloadedImage(content, response.headers.get("Content-Type"))

    def fetch_to(self, url: str, target: Path) -> str | None:
        if urlparse(url).scheme.lower() not in {"http", "https"}:
            raise ValueError("图片临时地址仅支持 HTTP 或 HTTPS")
        with self._client.stream("GET", url) as response:
            response.raise_for_status()
            total = 0
            with target.open("xb") as stream:
                for chunk in response.iter_bytes(_DOWNLOAD_CHUNK_BYTES):
                    stream.write(chunk)
                    total += len(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    expected_length = int(content_length)
                except ValueError as error:
                    raise OSError("图片下载响应的 Content-Length 无效") from error
                if expected_length != total:
                    raise OSError("图片下载不完整")
            return response.headers.get("Content-Type")

    def close(self) -> None:
        self._client.close()


class ResultSaveError(OSError):
    pass


class FileResultRepository:
    def __init__(
        self,
        output_root: Path,
        *,
        image_fetcher: ImageFetcher | None = None,
    ) -> None:
        self._output_root = output_root
        self._image_fetcher = image_fetcher or UrlImageFetcher()
        self._lock = RLock()

    def save(self, task: GenerationTask, image: GeneratedImage) -> Path:
        task_directory = self._task_directory(task)
        task_directory.mkdir(parents=True, exist_ok=True)
        attempts = MAX_RESULT_DOWNLOAD_ATTEMPTS if image.url else 1
        last_error: Exception | None = None
        last_media_type: str | None = None

        with self._lock:
            for _ in range(attempts):
                temporary: Path | None = None
                reserved_result: Path | None = None
                try:
                    temporary = task_directory / f".result-{uuid4().hex}.tmp"
                    fetch_to = getattr(self._image_fetcher, "fetch_to", None)
                    if image.url and callable(fetch_to):
                        declared_media_type = fetch_to(image.url, temporary)
                    else:
                        content, declared_media_type = self._image_payload(image)
                        with temporary.open("xb") as stream:
                            stream.write(content)
                            stream.flush()
                            os.fsync(stream.fileno())

                    media_type, suffix = _validate_image(temporary, declared_media_type)
                    last_media_type = media_type
                    reserved_result = self._reserve_result_path(task_directory, suffix)
                    temporary.replace(reserved_result)
                    result = reserved_result
                    reserved_result = None
                    return result
                except Exception as error:
                    last_error = error
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)
                    if reserved_result is not None:
                        reserved_result.unlink(missing_ok=True)

        assert last_error is not None
        raise ResultSaveError(
            f"结果下载或保存失败（已尝试 {attempts} 次，格式 {last_media_type or '未知'}）：{last_error}"
        ) from last_error

    def save_record(self, task: GenerationTask) -> None:
        task_directory = self._task_directory(task)
        task_directory.mkdir(parents=True, exist_ok=True)
        request = task.request
        size = request.size
        record = {
            "task_id": task.task_id,
            "workflow": task.workflow.value,
            "status": task.status.value,
            "submitted_at": task.submitted_at.isoformat(),
            "gateway_request_id": task.gateway_request_id,
            "model": request.model_id,
            "capability_version": request.capability_version,
            "prompt": request.prompt,
            "negative_prompt": request.negative_prompt,
            "size": {
                "mode": size.mode.value,
                "width": size.width,
                "height": size.height,
            },
            "image_count": request.image_count,
            "params": _redact_record_value(dict(request.params)),
            "result_files": [path.name for path in task.result_paths],
            "error": _redact_error(task.error),
            "reference_files": [
                reference.path.name for reference in getattr(request, "references", ())
            ],
            "reference_metadata": [
                {
                    "file": reference.path.name,
                    "media_type": reference.media_type,
                    "width": reference.width,
                    "height": reference.height,
                    "size_bytes": reference.size_bytes,
                    "warnings": list(reference.warnings),
                }
                for reference in getattr(request, "references", ())
            ],
        }
        content = json.dumps(record, ensure_ascii=False, indent=2) + "\n"
        with self._lock:
            temporary = task_directory / f".task-{uuid4().hex}.tmp"
            try:
                with temporary.open("x", encoding="utf-8", newline="") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                temporary.replace(task_directory / "task.json")
            finally:
                temporary.unlink(missing_ok=True)

    def save_reference_snapshot(
        self, task_id: str, submitted_at: datetime, reference: ReferenceImage, index: int
    ) -> ReferenceImage:
        if not _TASK_ID_PATTERN.fullmatch(task_id):
            raise ValueError("任务编号包含不安全字符")
        if index < 1:
            raise ValueError("参考图编号必须从 1 开始")
        task_directory = self._output_root / submitted_at.astimezone(UTC).date().isoformat() / task_id
        task_directory.mkdir(parents=True, exist_ok=True)
        suffix = _suffix_for_media_type(reference.media_type)
        path = task_directory / f"reference-{index}{suffix}"
        with self._lock:
            temporary = task_directory / f".reference-{index}-{uuid4().hex}.tmp"
            try:
                with temporary.open("xb") as stream:
                    stream.write(reference.content)
                    stream.flush()
                    os.fsync(stream.fileno())
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        return ReferenceImage(
            path=path,
            media_type=reference.media_type,
            width=reference.width,
            height=reference.height,
            size_bytes=reference.size_bytes,
            warnings=reference.warnings,
            content=reference.content,
        )

    def close(self) -> None:
        close = getattr(self._image_fetcher, "close", None)
        if callable(close):
            close()

    def _image_payload(self, image: GeneratedImage) -> tuple[bytes, str | None]:
        if image.content is not None:
            if not isinstance(image.content, bytes):
                raise TypeError("生成结果内容必须是字节")
            return image.content, image.media_type
        if not image.url:
            raise ValueError("生成结果既没有图片字节也没有临时地址")
        downloaded = self._image_fetcher.fetch(image.url)
        if not isinstance(downloaded, DownloadedImage):
            raise TypeError("图片下载器返回了无法识别的结果")
        return downloaded.content, downloaded.media_type or image.media_type

    def _reserve_result_path(self, task_directory: Path, suffix: str) -> Path:
        index = 1
        while True:
            candidate = task_directory / f"result-{index}{suffix}"
            try:
                candidate.touch(exist_ok=False)
            except FileExistsError:
                index += 1
            else:
                return candidate

    def _task_directory(self, task: GenerationTask) -> Path:
        if not _TASK_ID_PATTERN.fullmatch(task.task_id):
            raise ValueError("任务编号包含不安全字符")
        date = task.submitted_at.astimezone(UTC).date().isoformat()
        return self._output_root / date / task.task_id


def _validate_image(path: Path, declared_media_type: str | None) -> tuple[str, str]:
    content = path.read_bytes()
    format_name = _detect_format(content)
    if format_name is None or format_name not in _MEDIA_FORMATS:
        raise ValueError("生成结果不是受支持的图片格式")
    _decode_image(content, format_name)
    media_type, suffix = _MEDIA_FORMATS[format_name]
    return media_type, suffix


def _decode_image(content: bytes, format_name: str) -> None:
    if format_name == "png":
        _validate_png(content)
    elif format_name in {"jpeg", "jpg"}:
        _validate_jpeg(content)
    try:
        from PySide6.QtGui import QImage
    except ImportError:
        if format_name not in {"png", "jpeg", "jpg"}:
            raise ValueError(f"无法校验 {format_name} 图片")
        return
    if QImage.fromData(content).isNull():
        raise ValueError("生成结果无法解码")


def _detect_format(content: bytes) -> str | None:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if content.startswith(b"\xff\xd8"):
        return "jpeg"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp"
    if content[:6] in {b"GIF87a", b"GIF89a"}:
        return "gif"
    if content.startswith(b"BM"):
        return "bmp"
    if content[:4] in {b"II*\x00", b"MM\x00*"}:
        return "tiff"
    return None


def _validate_png(content: bytes) -> None:
    if len(content) < 33:
        raise ValueError("生成结果不是完整的 PNG 文件")
    offset = 8
    seen_header = False
    seen_data = False
    seen_end = False
    compressed = bytearray()
    width = height = bit_depth = color_type = interlace = 0

    while offset + 12 <= len(content):
        length = struct.unpack(">I", content[offset:offset + 4])[0]
        end = offset + 12 + length
        if end > len(content):
            raise ValueError("生成结果 PNG 数据不完整")
        chunk_type = content[offset + 4:offset + 8]
        chunk_data = content[offset + 8:offset + 8 + length]
        expected_crc = struct.unpack(">I", content[offset + 8 + length:end])[0]
        if zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF != expected_crc:
            raise ValueError("生成结果 PNG 校验失败")
        if chunk_type == b"IHDR":
            if seen_header or length != 13:
                raise ValueError("生成结果 PNG 头无效")
            width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
                ">IIBBBBB", chunk_data
            )
            if (
                width == 0
                or height == 0
                or compression != 0
                or filter_method != 0
                or bit_depth not in {1, 2, 4, 8, 16}
                or color_type not in {0, 2, 3, 4, 6}
                or interlace not in {0, 1}
            ):
                raise ValueError("生成结果 PNG 参数无效")
            seen_header = True
        elif chunk_type == b"IDAT":
            if not seen_header:
                raise ValueError("生成结果 PNG 缺少文件头")
            seen_data = True
            compressed.extend(chunk_data)
        elif chunk_type == b"IEND":
            if length != 0 or not seen_data:
                raise ValueError("生成结果 PNG 缺少图像数据")
            seen_end = True
            offset = end
            break
        offset = end

    if not seen_header or not seen_end or offset != len(content):
        raise ValueError("生成结果 PNG 结构不完整")
    try:
        decompressed = zlib.decompress(bytes(compressed))
    except zlib.error as error:
        raise ValueError("生成结果 PNG 图像数据无法解码") from error
    if interlace == 0:
        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
        row_bytes = (width * channels * bit_depth + 7) // 8
        expected_length = (row_bytes + 1) * height
        if len(decompressed) != expected_length:
            raise ValueError("生成结果 PNG 图像数据不完整")
    elif not decompressed:
        raise ValueError("生成结果 PNG 图像数据为空")


def _validate_jpeg(content: bytes) -> None:
    if len(content) < 4 or not content.startswith(b"\xff\xd8"):
        raise ValueError("生成结果不是完整的 JPEG 文件")
    offset = 2
    found_frame = False
    found_end = False
    frame_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    while offset < len(content):
        if content[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(content) and content[offset] == 0xFF:
            offset += 1
        if offset >= len(content):
            break
        marker = content[offset]
        offset += 1
        if marker == 0xD9:
            found_end = True
            break
        if marker == 0xDA:
            if offset + 2 > len(content):
                break
            segment_length = struct.unpack(">H", content[offset:offset + 2])[0]
            if segment_length < 2 or offset + segment_length > len(content):
                break
            offset += segment_length
            end_marker = content.find(b"\xff\xd9", offset)
            if end_marker == -1:
                break
            found_end = True
            break
        if marker in {0xD8, 0xD9, 0x01} or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 2 > len(content):
            break
        segment_length = struct.unpack(">H", content[offset:offset + 2])[0]
        if segment_length < 2 or offset + segment_length > len(content):
            break
        if marker in frame_markers:
            if segment_length < 8:
                break
            height, width = struct.unpack(">HH", content[offset + 3:offset + 7])
            if width == 0 or height == 0:
                break
            found_frame = True
        offset += segment_length
    if not found_frame or not found_end:
        raise ValueError("生成结果 JPEG 结构不完整")


def _suffix_for_media_type(media_type: str) -> str:
    normalized = media_type.split(";", 1)[0].strip().lower()
    for format_name, (known_media_type, suffix) in _MEDIA_FORMATS.items():
        if normalized == known_media_type:
            return suffix
    raise ValueError(f"不支持的图片格式：{media_type}")


def _redact_record_value(value: object, key: str = "") -> object:
    normalized_key = key.lower().replace("-", "_").replace(" ", "_")
    if _is_sensitive_key(normalized_key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {
            str(child_key): _redact_record_value(child, str(child_key))
            for child_key, child in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_redact_record_value(child, key) for child in value]
    if isinstance(value, str):
        return _redact_error(value)
    return _json_safe(value)


def _json_safe(value: object) -> object:
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return _redact_error(str(value))
    return value


def _is_sensitive_key(normalized_key: str) -> bool:
    compact_key = normalized_key.replace("_", "")
    return compact_key in {"token", "secret", "password"} or any(
        fragment in compact_key
        for fragment in (
            "authorization",
            "proxyauthorization",
            "apikey",
            "accesstoken",
            "authtoken",
            "cookie",
        )
    )


_AUTH_RE = re.compile(
    r"(?i)[\"']?(authorization|proxy-authorization|x-api-key|api[_ -]?key|x-access-token|access-token|auth-token|token|cookie|set-cookie)[\"']?"
    r"(?:\s+header)?\s*[:=]\s*[\"']?(?:(?:[A-Za-z][A-Za-z0-9_-]*)\s+)?[^\s,;}\"']+[\"']?"
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
_URL_RE = re.compile(r"https?://[^\s\"']+")


def _redact_error(error: str | None) -> str | None:
    if error is None:
        return None
    redacted = _AUTH_RE.sub("[REDACTED]", error)
    redacted = _BEARER_RE.sub("Bearer [REDACTED]", redacted)
    return _URL_RE.sub("[REDACTED_URL]", redacted)
