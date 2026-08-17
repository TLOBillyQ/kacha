from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

INTERFACES = {
    "models": ("GET",),
    "text_to_image": ("POST",),
    "image_edit": ("POST",),
}
BEHAVIORS = {
    "partial_failure",
    "idempotency_key",
    "running_cancellation",
    "task_query",
    "retry_after",
}
ERROR_CATEGORIES = {
    "authentication",
    "invalid_request",
    "rate_limit",
    "server_error",
}
SENSITIVE_KEYS = {
    "authorization",
    "api_key",
    "apikey",
    "x-api-key",
    "x_api_key",
    "prompt",
    "text",
    "negative_prompt",
    "image",
    "images",
    "b64_json",
    "input_image",
    "reference_image",
}
REDACTED_VALUES = {"[REDACTED]", "[REDACTED_PROMPT]", "[REDACTED_IMAGE]"}
BEARER_RE = re.compile(r"\bbearer\s+\S+", re.IGNORECASE)
URL_RE = re.compile(r"https?://[^\s\"']+")


def validate_fixture_directory(directory: Path) -> list[str]:
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        return [f"缺少契约清单：{manifest_path}"]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return [f"无法读取 manifest.json：{error}"]
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return ["manifest.json 必须是 JSON 对象"]
    if manifest.get("schema_version") != 1:
        errors.append("schema_version 必须为 1")
    if not isinstance(manifest.get("verified_at"), str) or not manifest["verified_at"].strip():
        errors.append("verified_at 必须记录实测时间")
    interfaces = manifest.get("interfaces")
    if not isinstance(interfaces, dict):
        errors.append("interfaces 必须是对象")
    else:
        for name, methods in INTERFACES.items():
            interface = interfaces.get(name)
            if not isinstance(interface, dict):
                errors.append(f"缺少接口：interfaces.{name}")
                continue
            if interface.get("method") not in methods:
                errors.append(f"接口 {name} 的 method 不受支持")
            if not isinstance(interface.get("path"), str) or not interface["path"].startswith("/"):
                errors.append(f"接口 {name} 必须记录绝对路径")
            exchanges = interface.get("exchanges")
            if not isinstance(exchanges, list) or not exchanges:
                errors.append(f"接口 {name} 必须至少包含一个交互样例")
            else:
                for index, exchange in enumerate(exchanges):
                    if not isinstance(exchange, dict) or not {"request", "response"} <= exchange.keys():
                        errors.append(f"接口 {name} 的交互样例 {index} 缺少 request/response")
                        continue
                    request = exchange["request"]
                    response = exchange["response"]
                    if not isinstance(request, dict):
                        errors.append(f"接口 {name} 的交互样例 {index} request 必须是对象")
                    else:
                        if request.get("method") != interface.get("method"):
                            errors.append(f"接口 {name} 的交互样例 {index} method 不一致")
                        if request.get("path") != interface.get("path"):
                            errors.append(f"接口 {name} 的交互样例 {index} path 不一致")
                        if not isinstance(request.get("headers"), dict):
                            errors.append(f"接口 {name} 的交互样例 {index} 缺少 headers")
                        if "body" not in request:
                            errors.append(f"接口 {name} 的交互样例 {index} 缺少 body")
                    if not isinstance(response, dict) or not isinstance(response.get("status"), int):
                        errors.append(f"接口 {name} 的交互样例 {index} 缺少 HTTP status")
                    elif "body" not in response:
                        errors.append(f"接口 {name} 的交互样例 {index} 缺少 response body")
            if name == "image_edit":
                request_shape = interface.get("request_shape")
                fields = request_shape.get("fields") if isinstance(request_shape, dict) else None
                has_image_file = isinstance(fields, list) and any(
                    isinstance(field, dict)
                    and field.get("name") == "image"
                    and field.get("kind") == "file"
                    for field in fields
                )
                if not has_image_file:
                    errors.append("图片编辑必须记录 image 文件字段的编码证据")
    behaviors = manifest.get("behaviors")
    if not isinstance(behaviors, dict):
        errors.append("behaviors 必须是对象")
    else:
        for name in BEHAVIORS:
            behavior = behaviors.get(name)
            if not isinstance(behavior, dict):
                errors.append(f"缺少行为结论：behaviors.{name}")
                continue
            if behavior.get("status") not in {"supported", "unsupported", "unknown"}:
                errors.append(f"行为 {name} 的 status 无效")
            if not isinstance(behavior.get("evidence"), str) or not behavior["evidence"].strip():
                errors.append(f"行为 {name} 必须有可复现结论")
    mappings = manifest.get("error_mappings")
    if not isinstance(mappings, dict) or set(mappings) != ERROR_CATEGORIES:
        errors.append("error_mappings 必须覆盖四类主要错误")
    else:
        for category, mapping in mappings.items():
            if not isinstance(mapping, dict):
                errors.append(f"错误映射 {category} 必须是对象")
                continue
            status_is_unknown = mapping.get("status") is None and mapping.get("verified") is False
            if not isinstance(mapping.get("status"), int) and not status_is_unknown:
                errors.append(f"错误映射 {category} 必须记录 HTTP 状态码或明确标记未验证")
            evidence = mapping.get("evidence")
            if not isinstance(evidence, str) or not evidence.strip():
                errors.append(f"错误映射 {category} 必须记录证据")
            elif evidence.endswith(".json"):
                evidence_path = directory / evidence
                if not evidence_path.resolve().is_relative_to(directory.resolve()):
                    errors.append(f"错误映射 {category} 的证据路径越界：{evidence}")
                elif not evidence_path.is_file():
                    errors.append(f"错误映射 {category} 的证据文件不存在：{evidence}")
    for field in ("verified_models", "unsafe_to_enable"):
        if not isinstance(manifest.get(field), list) or not manifest[field]:
            errors.append(f"{field} 必须是非空数组")
    errors.extend(_validate_sensitive_values(manifest))
    return errors


def _validate_sensitive_values(value: Any, path: str = "manifest") -> list[str]:
    errors: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            key_path = f"{path}.{key}"
            normalized_key = key.lower().replace("-", "_")
            if normalized_key in SENSITIVE_KEYS and child not in REDACTED_VALUES:
                errors.append(f"{key_path} 必须脱敏")
            errors.extend(_validate_sensitive_values(child, key_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            errors.extend(_validate_sensitive_values(child, f"{path}[{index}]"))
    elif isinstance(value, str):
        if BEARER_RE.search(value):
            errors.append(f"{path} 包含鉴权令牌")
        for url in URL_RE.findall(value):
            if path == "manifest.gateway.base_url":
                continue
            if "example.invalid" not in url and "[REDACTED" not in url:
                errors.append(f"{path} 包含未脱敏 URL")
    return errors
