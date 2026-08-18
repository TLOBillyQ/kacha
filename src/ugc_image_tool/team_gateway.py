"""真实团队网关适配器。

路径、鉴权、载荷、参考图编码、响应与错误映射全部来自
contracts/fixtures/2026-08-17-team-gateway 的脱敏实测夹具，不依据
OpenAI 或 DashScope 文档猜测。生成请求不做自动重发；未实测的能力
（多参考图、编辑侧负向提示词/尺寸/出图数量等）保持关闭并给出可操作提示。
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any

import httpx

from .diagnostics import DiagnosticSink
from .discovery import (
    GatewayError,
    GatewayErrorCategory,
    category_for_status,
)
from .generation import (
    GeneratedImage,
    GatewayGenerationResult,
    ImageEditRequest,
    SizeMode,
    TextToImageRequest,
)
from .settings import validate_base_url

MODELS_PATH = "/v1/models"
TEXT_TO_IMAGE_PATH = "/v1/images/generations"
IMAGE_EDIT_PATH = "/v1/images/edits"

CONNECT_TIMEOUT_SECONDS = 10.0
GENERATION_READ_TIMEOUT_SECONDS = 15 * 60 + 60  # 大于应用层 15 分钟等待超时
MODEL_LIST_READ_TIMEOUT_SECONDS = 30.0


def _decode_image_value(value: Any) -> bytes | None:
    """解码网关返回的图片字段；兼容纯 base64 与 data URI 前缀。"""
    if not isinstance(value, str) or not value:
        return None
    token = value.strip()
    if token.startswith("data:"):
        marker = ";base64,"
        if marker not in token:
            return None
        token = token.split(marker, 1)[1]
    try:
        return base64.b64decode(token, validate=True)
    except (ValueError, TypeError):
        return None


@dataclass(frozen=True)
class ParsedGeneration:
    """生成响应的解析结果；images 为空表示网关未返回任何结果。"""

    images: tuple[GeneratedImage, ...]
    request_id: str | None


class TeamGateway:
    """真实团队网关；同时实现模型发现与生成适配器。

    生成请求只发送一次，不自动重发；模型列表等只读重试由上层发现组件负责。
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        client: httpx.Client | None = None,
        diagnostics: DiagnosticSink | None = None,
    ) -> None:
        self._base_url = validate_base_url(base_url)
        self._api_key = api_key
        self._diagnostics = diagnostics
        self._client = client or httpx.Client(
            timeout=httpx.Timeout(
                connect=CONNECT_TIMEOUT_SECONDS,
                read=GENERATION_READ_TIMEOUT_SECONDS,
                write=30.0,
                pool=10.0,
            ),
            headers={"Accept": "application/json"},
        )

    @property
    def base_url(self) -> str:
        return self._base_url

    def set_base_url(self, base_url: str) -> None:
        """设置页改地址后热更新；不重建客户端，只影响后续请求。"""
        self._base_url = validate_base_url(base_url)

    def set_api_key(self, api_key: str) -> None:
        self._api_key = api_key

    def close(self) -> None:
        self._client.close()

    # -- 模型发现 ------------------------------------------------------------

    def list_models(self) -> tuple[str, ...]:
        if not self._api_key:
            raise GatewayError(
                GatewayErrorCategory.CONFIG, "未配置 API 密钥，请在设置页填写并保存"
            )
        response = self._request(
            "GET",
            MODELS_PATH,
            read_timeout=MODEL_LIST_READ_TIMEOUT_SECONDS,
        )
        body = _json_object(response)
        data = body.get("data")
        if not isinstance(data, list):
            raise GatewayError(
                GatewayErrorCategory.SERVER,
                "网关模型列表响应缺少 data 数组",
                gateway_request_id=response.headers.get("X-Oneapi-Request-Id"),
            )
        model_ids: list[str] = []
        for entry in data:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"]:
                model_ids.append(entry["id"])
        self._log_system(
            "模型列表响应解析完成",
            count=len(model_ids),
            gateway_request_id=response.headers.get("X-Oneapi-Request-Id"),
        )
        return tuple(model_ids)

    # -- 文生图 --------------------------------------------------------------

    def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
        payload: dict[str, object] = {
            "model": request.model_id,
            "prompt": request.prompt,
        }
        if request.negative_prompt:
            payload["negative_prompt"] = request.negative_prompt
        if request.image_count != 1:
            payload["n"] = request.image_count
        if request.size.mode is not SizeMode.AUTO:
            payload["size"] = f"{request.size.width}x{request.size.height}"
        for key, value in request.params:
            payload[key] = value
        response = self._request("POST", TEXT_TO_IMAGE_PATH, json=payload)
        parsed = _parse_ok_generation(response, self._diagnostics)
        return GatewayGenerationResult(images=parsed.images, request_id=parsed.request_id)

    # -- 图片编辑 ------------------------------------------------------------

    def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
        self._validate_edit_request(request)
        reference = request.references[0]
        files = {
            "image": (
                reference.path.name,
                reference.content,
                reference.media_type,
            )
        }
        data = {
            "model": request.model_id,
            "prompt": request.prompt,
        }
        response = self._request("POST", IMAGE_EDIT_PATH, data=data, files=files)
        parsed = _parse_ok_generation(response, self._diagnostics)
        return GatewayGenerationResult(images=parsed.images, request_id=parsed.request_id)

    def _validate_edit_request(self, request: ImageEditRequest) -> None:
        """守住网关边界：只有夹具验证的编辑载荷才允许发出。"""
        if len(request.references) != 1:
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                "图片编辑的多参考图编码未经契约验证，暂仅支持 1 张参考图",
            )
        if request.negative_prompt:
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                "图片编辑的负向提示词字段未经契约验证，暂不支持",
            )
        if request.size.mode is not SizeMode.AUTO:
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                "图片编辑的尺寸字段未经契约验证，暂仅支持模型自动决定尺寸",
            )
        if request.image_count != 1:
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                "图片编辑的出图数量字段未经契约验证，暂仅支持单张出图",
            )
        if request.params:
            names = "、".join(key for key, _ in request.params)
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                f"图片编辑的模型专属参数（{names}）未经契约验证，暂不支持",
            )

    # -- 请求与错误映射 --------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        read_timeout: float = GENERATION_READ_TIMEOUT_SECONDS,
        **kwargs: Any,
    ) -> httpx.Response:
        if not self._api_key:
            raise GatewayError(
                GatewayErrorCategory.CONFIG, "未配置 API 密钥，请在设置页填写并保存"
            )
        url = f"{self._base_url.rstrip('/')}/{path.lstrip('/')}"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }
        try:
            response = self._client.request(
                method,
                url,
                headers=headers,
                timeout=read_timeout,
                **kwargs,
            )
        except httpx.HTTPError as error:
            raise GatewayError(
                GatewayErrorCategory.NETWORK, f"无法连接网关：{error}"
            ) from error
        if response.status_code >= 400:
            raise _error_from_response(response)
        return response

    def _log_system(self, message: str, **fields: object) -> None:
        if self._diagnostics is None:
            return
        joined = "；".join(
            [message] + [f"{key}={value}" for key, value in fields.items() if value is not None]
        )
        self._diagnostics.system(joined)


def _parse_ok_generation(
    response: httpx.Response, diagnostics: DiagnosticSink | None = None
) -> ParsedGeneration:
    """解析成功状态的生成响应，优先使用网关的 X-Oneapi-Request-Id 请求编号。"""
    body = _json_object(response)
    request_id = response.headers.get("X-Oneapi-Request-Id") or _request_id(body)
    data_entries = _data_entries(body)
    metadata_images = _metadata_images(body)
    count = max(len(data_entries), len(metadata_images))
    images: list[GeneratedImage] = []
    for index in range(count):
        url = data_entries[index].get("url") if index < len(data_entries) else None
        content: bytes | None = None
        if index < len(metadata_images):
            content = _decode_image_value(metadata_images[index])
            if content is None:
                # metadata 内容无法解码时，回退到 data 视图的同位 b64_json。
                content = (
                    _decode_image_value(data_entries[index].get("b64_json"))
                    if index < len(data_entries)
                    else None
                )
        elif index < len(data_entries):
            content = _decode_image_value(data_entries[index].get("b64_json"))
        if url is not None or content is not None:
            images.append(GeneratedImage(content=content, url=url))

    if len(data_entries) != len(metadata_images):
        if diagnostics is not None:
            diagnostics.system(
                f"网关响应视图不一致：data {len(data_entries)} 条，"
                f"输出 {len(metadata_images)} 张，按实际输出保存"
            )
    return ParsedGeneration(tuple(images), request_id=request_id)


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except (json.JSONDecodeError, ValueError) as error:
        raise GatewayError(
            GatewayErrorCategory.SERVER,
            "网关返回了无法解析的响应",
            gateway_request_id=response.headers.get("X-Oneapi-Request-Id"),
            status_code=response.status_code,
        ) from error
    if not isinstance(body, dict):
        raise GatewayError(
            GatewayErrorCategory.SERVER,
            "网关响应结构无效",
            gateway_request_id=response.headers.get("X-Oneapi-Request-Id"),
            status_code=response.status_code,
        )
    return body


def _data_entries(body: dict[str, Any]) -> list[dict[str, Any]]:
    data = body.get("data")
    if not isinstance(data, list):
        return []
    return [entry for entry in data if isinstance(entry, dict)]


def _metadata_images(body: dict[str, Any]) -> list[str]:
    """从 metadata.output.choices[].message.content[].image 提取实际输出图片。"""
    metadata = body.get("metadata")
    if not isinstance(metadata, dict):
        return []
    output = metadata.get("output")
    if not isinstance(output, dict):
        return []
    choices = output.get("choices")
    if not isinstance(choices, list):
        return []
    images: list[str] = []
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            image = item.get("image")
            if isinstance(image, str) and image:
                images.append(image)
    return images


def _request_id(body: dict[str, Any]) -> str | None:
    metadata = body.get("metadata")
    if isinstance(metadata, dict):
        value = metadata.get("request_id")
        if isinstance(value, str) and value:
            return value
    return None


def _error_from_response(response: httpx.Response) -> GatewayError:
    status = response.status_code
    request_id = response.headers.get("X-Oneapi-Request-Id")
    return GatewayError(
        category_for_status(status),
        _error_message(response),
        gateway_request_id=request_id,
        status_code=status,
    )


def _error_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except (json.JSONDecodeError, ValueError):
        return f"HTTP {response.status_code}"
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str) and message:
                return message
    return f"HTTP {response.status_code}"