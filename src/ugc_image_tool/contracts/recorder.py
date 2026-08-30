from __future__ import annotations

import json
import os
import re
import stat
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

KEY_ENVIRONMENT_VARIABLE = "UGC_IMAGE_TOOL_GATEWAY_API_KEY"
SENSITIVE_FIELDS = {
    "prompt",
    "text",
    "negative_prompt",
    "image",
    "images",
    "b64_json",
    "input_image",
    "reference_image",
}
URL_RE = re.compile(r"https?://[^\s\"']+")


class MissingGatewayKeyError(ValueError):
    pass


class InsecureGatewayKeyError(ValueError):
    pass


def load_gateway_key(key_file: Path | None = None) -> str:
    if key_file is not None:
        if os.name != "nt" and stat.S_IMODE(key_file.stat().st_mode) & 0o077:
            raise InsecureGatewayKeyError(f"密钥文件权限过宽：{key_file}")
        key = key_file.read_text(encoding="utf-8").strip()
    else:
        key = os.environ.get(KEY_ENVIRONMENT_VARIABLE, "").strip()
    if not key or key == "[密钥]":
        raise MissingGatewayKeyError(
            f"请通过 {KEY_ENVIRONMENT_VARIABLE} 或 --key-file 提供临时密钥"
        )
    return key


def record_exchange(
    *,
    base_url: str,
    interface: str,
    path: str,
    method: str,
    key: str,
    body_file: Path | None,
    content_type: str,
    timeout: float,
) -> dict[str, Any]:
    body = body_file.read_bytes() if body_file is not None else None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {key}",
    }
    if body is not None:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/{path.lstrip('/')}",
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            response_headers = dict(response.headers.items())
            response_body = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        response_headers = dict(error.headers.items())
        response_body = error.read()
    return {
        "interface": interface,
        "recorded_at": datetime.now(UTC).isoformat(),
        "request": {
            "method": method,
            "path": path,
            "headers": _sanitize_headers(headers),
            "body": _decode_and_sanitize(body, content_type),
        },
        "response": {
            "status": status,
            "headers": _sanitize_headers(response_headers),
            "body": _decode_and_sanitize(response_body, response_headers.get("Content-Type", "")),
        },
    }


def write_exchange(exchange: dict[str, Any], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(exchange, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _decode_and_sanitize(body: bytes | None, content_type: str) -> Any:
    if body is None:
        return None
    normalized_content_type = content_type.lower()
    if "json" in normalized_content_type:
        try:
            return _sanitize_value(json.loads(body.decode("utf-8")))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return "[REDACTED_INVALID_JSON_BODY]"
    if "multipart/" in normalized_content_type:
        return "[REDACTED_MULTIPART_BODY]"
    return "[REDACTED_NON_JSON_BODY]"


def _sanitize_headers(headers: dict[str, str]) -> dict[str, str]:
    sensitive_headers = {
        "authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
        "x-dashscope-apikeyid",
        "x-dashscope-bwid",
        "x-dashscope-uid",
        "x-dashscope-workspace",
    }
    return {
        name: "[REDACTED]" if name.lower() in sensitive_headers else _sanitize_text(value)
        for name, value in headers.items()
    }


def _sanitize_value(value: Any, key: str = "") -> Any:
    normalized_key = key.lower().replace("-", "_")
    if normalized_key in SENSITIVE_FIELDS:
        if normalized_key in {"prompt", "text", "negative_prompt"}:
            return "[REDACTED_PROMPT]"
        return "[REDACTED_IMAGE]"
    if isinstance(value, dict):
        return {child_key: _sanitize_value(child, child_key) for child_key, child in value.items()}
    if isinstance(value, list):
        return [_sanitize_value(child) for child in value]
    if isinstance(value, str):
        return _sanitize_text(value)
    return value


def _sanitize_text(value: str) -> str:
    return URL_RE.sub("https://example.invalid/redacted", value)
