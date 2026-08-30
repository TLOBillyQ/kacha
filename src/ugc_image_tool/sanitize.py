"""敏感内容脱敏：任务记录与脱敏日志共享的字符串、字段与结构清洁规则。

所有可能落到磁盘或诊断包的内容都必须经过本模块处理。规则覆盖：
API 密钥与认证头（Authorization / X-Api-Key / Cookie 等）、Bearer 令牌、
OpenAI 风格 sk- 密钥以及 http(s) 临时地址。完整提示词、图片内容等不该
出现在日志中的字段由调用方根本不写入。
"""

from __future__ import annotations

import json
import re


_AUTH_RE = re.compile(
    r"(?i)[\"']?(authorization|proxy-authorization|x-api-key|api[_ -]?key|x-access-token|access-token|auth-token|token|cookie|set-cookie)[\"']?"
    r"(?:\s+header)?\s*[:=]\s*[\"']?(?:(?:[A-Za-z][A-Za-z0-9_-]*)\s+)?[^\s,;}\"']+[\"']?"
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
_URL_RE = re.compile(r"https?://[^\s\"']+")
_SK_KEY_RE = re.compile(r"(?i)\bsk-[A-Za-z0-9_-]{8,}")
# 图片内容等长 base64 数据块：任何 64 字符以上的 base64 串都按敏感内容整体替换。
_BASE64_RE = re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/])")


def sanitize_text(text: str) -> str:
    """清洁一段文本，替换认证信息、网络地址与长数据块，绝不保留其内容。"""
    redacted = _AUTH_RE.sub("[REDACTED]", text)
    redacted = _SK_KEY_RE.sub("[REDACTED]", redacted)
    redacted = _BEARER_RE.sub("Bearer [REDACTED]", redacted)
    redacted = _URL_RE.sub("[REDACTED_URL]", redacted)
    return _BASE64_RE.sub("[REDACTED]", redacted)


def is_sensitive_key(key: str) -> bool:
    """按规范化后的字段名判断其是否携带凭据信息。"""
    compact_key = key.replace("_", "").replace("-", "").replace(" ", "").lower()
    return compact_key in {"token", "secret", "password"} or any(
        fragment in compact_key
        for fragment in (
            "authorization",
            "proxyauthorization",
            "apikey",
            "accesstoken",
            "authtoken",
            "cookie",
            "setcookie",
        )
    )


def redact_value(value: object, key: str = "") -> object:
    """递归清洁结构化的记录值；敏感字段整体替换，字符串再过一次脱敏。"""
    if is_sensitive_key(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {
            str(child_key): redact_value(child, str(child_key))
            for child_key, child in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_value(child, key) for child in value]
    if isinstance(value, str):
        return sanitize_text(value)
    return json_safe(value)


def json_safe(value: object) -> object:
    """确保值可以被 JSON 序列化；不能序列化时转为脱敏字符串。"""
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return sanitize_text(str(value))
    return value