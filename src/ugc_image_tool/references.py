from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

MAX_REFERENCE_BYTES = 10 * 1024 * 1024
MIN_REFERENCE_DIMENSION = 384
MAX_REFERENCE_DIMENSION = 2048
_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


@dataclass(frozen=True)
class ReferenceImage:
    path: Path
    media_type: str
    width: int
    height: int
    size_bytes: int
    warnings: tuple[str, ...] = ()
    content: bytes = b""


def inspect_reference_image(path: Path, *, max_bytes: int = MAX_REFERENCE_BYTES) -> ReferenceImage:
    if not path.is_file():
        raise ValueError(f"参考图不存在：{path.name}")
    media_type = _MEDIA_TYPES.get(path.suffix.lower())
    if media_type is None:
        raise ValueError("参考图仅支持 PNG 或 JPEG")
    size_bytes = path.stat().st_size
    if size_bytes > max_bytes:
        raise ValueError(f"单张参考图不能超过 {max_bytes // (1024 * 1024)} MB")
    content = path.read_bytes()
    width, height = (_png_dimensions(content) if media_type == "image/png" else _jpeg_dimensions(content))
    warnings = tuple(
        message
        for value, label in ((width, "宽度"), (height, "高度"))
        if not MIN_REFERENCE_DIMENSION <= value <= MAX_REFERENCE_DIMENSION
        for message in (f"参考图{label} {value}px 超出建议范围 {MIN_REFERENCE_DIMENSION}～{MAX_REFERENCE_DIMENSION}px",)
    )
    return ReferenceImage(path, media_type, width, height, size_bytes, warnings, content)


def _png_dimensions(content: bytes) -> tuple[int, int]:
    if len(content) < 24 or content[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("参考图不是有效的 PNG 文件")
    return struct.unpack(">II", content[16:24])


def _jpeg_dimensions(content: bytes) -> tuple[int, int]:
    if not content.startswith(b"\xff\xd8"):
        raise ValueError("参考图不是有效的 JPEG 文件")
    offset = 2
    while offset + 9 < len(content):
        if content[offset] != 0xFF:
            offset += 1
            continue
        marker = content[offset + 1]
        offset += 2
        if marker in {0xD8, 0xD9}:
            continue
        if offset + 2 > len(content):
            break
        segment_size = struct.unpack(">H", content[offset:offset + 2])[0]
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            if offset + 7 > len(content):
                break
            height, width = struct.unpack(">HH", content[offset + 3:offset + 7])
            return width, height
        offset += segment_size
    raise ValueError("参考图不是有效的 JPEG 文件")
