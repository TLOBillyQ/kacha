"""发布物安全性检查：扫描文件/目录中的 API 密钥与认证信息。

用于 issue #13 发布验收的“无密钥发布检查”：确认发布包、普通设置、日志、
任务记录与测试数据均不包含 API 密钥。扫描规则与 sanitize 模块共享一致的
敏感形态（sk- 密钥、Authorization/Bearer、X-Api-Key、api_key 等字段赋值），
但对已经被脱敏为 [REDACTED] 的占位符做放行，避免把脱敏结果误报成泄漏。

与 sanitize 的差异（有意为之）：
- sk- 密钥的最短长度与 sanitize._SK_KEY_RE 保持一致（至少 8 位）。
- 不扫描长 base64/图片数据块：发布物包含大量二进制文件，base64 形状会在
  二进制内容上产生海量误报；长数据块的脱敏由 sanitize 在写入日志/记录时
  处理，发布检查只负责凭据形态。

本模块只依赖标准库：build_release.py、verify_release.py 与自动化测试共用，
也提供 SHA-256 校验值核对工具。
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

# 被脱敏的占位符不算泄漏；长度低于阈值的片段（如裸字段名）也不视为密钥。
_REDACTED_PLACEHOLDERS = frozenset({
    "[REDACTED]",
    "[REDACTED_URL]",
    "REDACTED",
    "None",
    "null",
    "true",
    "false",
    "TRUE",
    "FALSE",
})
_TOKEN_MIN_LENGTH = 12

# (类别, 正则)。每个正则以捕获组 1 作为“疑似值”，扫描时对该值做占位符
# 放行与长度判断。规则刻意与 sanitize.sanitize_text 的敏感形态保持一致；
# Bearer/字段赋值取值时排除方括号，避免把 [REDACTED] 误当成令牌。
_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "sk- API 密钥",
        re.compile(r"(?i)\bsk-([A-Za-z0-9_-]{8,})"),
    ),
    (
        "认证头",
        re.compile(r"(?i)\b(?:authorization|proxy-authorization)\s*[:=]\s*([^\s,;}\"]+)"),
    ),
    (
        "Bearer 令牌",
        re.compile(r"(?i)\bbearer\s+([^\s,;}\[\]\"]+)"),
    ),
    (
        "API 密钥赋值",
        re.compile(r"(?i)\b(?:x-api-key|api[_-]?key|apikey|api[_ -]?token)\s*[:=]\s*([^\s,;}\"]+)"),
    ),
    (
        "访问令牌赋值",
        re.compile(r"(?i)\b(?:access[_-]?token|auth[_-]?token)\s*[:=]\s*([^\s,;}\"]+)"),
    ),
    (
        "Cookie 头",
        re.compile(r"(?i)\b(?:set-cookie|cookie)\s*[:=]\s*([^\s,;}\"]+)"),
    ),
)


@dataclass(frozen=True)
class Finding:
    """一次疑似密钥泄漏：文件、类别、上下文片段与字节偏移。"""

    path: Path
    kind: str
    snippet: str
    offset: int


def _plausible_value(value: str) -> bool:
    """把捕获到的疑似值清洗后判断是否像真实密钥。"""
    cleaned = value.strip().strip("'\"")
    if cleaned in _REDACTED_PLACEHOLDERS:
        return False
    return len(cleaned) >= _TOKEN_MIN_LENGTH


def scan_bytes(data: bytes, path: Path | str = Path("<bytes>")) -> list[Finding]:
    """扫描一段字节内容，返回疑似密钥泄漏。"""
    text = _decode(data)
    findings: list[Finding] = []
    for kind, pattern in _PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(1) if match.lastindex else match.group(0)
            if not _plausible_value(value):
                continue
            start = max(0, match.start() - 24)
            end = min(len(text), match.end() + 24)
            snippet = text[start:end].replace("\r", " ").replace("\n", " ")
            findings.append(Finding(Path(path), kind, snippet, match.start()))
    return findings


def scan_file(path: Path) -> list[Finding]:
    """扫描单个文件；读不到（如符号链接）时静默跳过。"""
    try:
        data = path.read_bytes()
    except OSError:
        return []
    return scan_bytes(data, path)


def scan_directory(root: Path) -> list[Finding]:
    """递归扫描目录内所有文件。"""
    findings: list[Finding] = []
    if not root.is_dir():
        return []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            findings.extend(scan_file(path))
    return findings


def scan_tree(*paths: Path) -> list[Finding]:
    """扫描若干文件或目录，按路径排序去重。"""
    findings: list[Finding] = []
    seen: set[Path] = set()
    for path in paths:
        resolved = Path(path)
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.is_dir():
            findings.extend(scan_directory(resolved))
        elif resolved.is_file():
            findings.extend(scan_file(resolved))
    return findings


def _decode(data: bytes) -> str:
    for encoding in ("utf-8", "utf-16-le", "utf-16-be", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore")


def sha256_of(path: Path) -> str:
    """计算单个文件的 SHA-256。"""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checksum_line(path: Path, root: Path | None = None) -> str:
    """一行 SHA256SUMS 格式：<hash>  <相对路径>（无 root 时用文件名）。"""
    relative = path.relative_to(root) if root is not None else Path(path.name)
    return f"{sha256_of(path)}  {relative.as_posix()}"


def parse_checksums_text(text: str) -> dict[str, str]:
    """解析 SHA256SUMS 文本：统一路径分隔符后映射到哈希值。"""
    checksums: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            continue
        digest, name = parts
        if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            continue
        checksums[Path(name).as_posix()] = digest.lower()
    return checksums


def read_checksums(checksums_path: Path) -> dict[str, str]:
    """解析 SHA256SUMS 文件；文件不存在时返回空映射。"""
    if not checksums_path.is_file():
        return {}
    return parse_checksums_text(checksums_path.read_text(encoding="utf-8"))


def verify_sha256(root: Path, checksums_path: Path) -> tuple[bool, list[str], list[str]]:
    """核对 root 下相对路径的 SHA-256；返回 (是否全部一致, 缺失列表, 不一致列表)。"""
    expected = read_checksums(checksums_path)
    missing: list[str] = []
    mismatch: list[str] = []
    for name, expected_digest in expected.items():
        target = root / name
        if not target.is_file():
            missing.append(name)
            continue
        if sha256_of(target) != expected_digest:
            mismatch.append(name)
    verified = bool(expected) and not missing and not mismatch
    return verified, missing, mismatch
