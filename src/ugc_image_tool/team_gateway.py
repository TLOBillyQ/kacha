"""真实团队网关适配器。

路径、鉴权、载荷、参考图编码、响应与错误映射全部来自
contracts/fixtures 下的脱敏实测夹具（2026-08-17 文生图与模型列表、
2026-08-29 JSON 图片编辑），不依据 OpenAI 或 DashScope 文档猜测。
生成请求不做自动重发；编辑载荷在网关
边界按能力表的工作流约束做防御性校验，与应用层提交前校验读取同一份
能力事实，避免规则漂移。
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any

import httpx

from .capabilities import CapabilityRegistry, Workflow, WorkflowCapability
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
    SizeSpec,
    TextToImageRequest,
)
from .references import ReferenceImage
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
        capabilities: CapabilityRegistry | None = None,
    ) -> None:
        self._base_url = validate_base_url(base_url)
        self._api_key = api_key
        self._diagnostics = diagnostics
        # 与应用层共享同一份能力表实例；缺省回退内置能力表。
        self._capabilities = capabilities or CapabilityRegistry()
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
        # JSON 透传载荷（contracts/fixtures/2026-08-29-team-gateway-edit-json 实测）：
        # 参考图编码为 data-URL，按顺序进入 input.messages[0].content 的多个
        # image 项，提示词作为末尾 text 项；顶层 prompt 为网关必填字段。
        # input.negative_prompt 尚未实测，负向提示词先并入主提示词文本。
        prompt_text = request.prompt
        if request.negative_prompt:
            prompt_text = f"{request.prompt}\n避免出现：{request.negative_prompt}"
        content: list[dict[str, str]] = [
            {"image": _reference_data_url(reference)}
            for reference in request.references
        ]
        content.append({"text": prompt_text})
        payload: dict[str, object] = {
            "model": request.model_id,
            "prompt": prompt_text,
            "input": {"messages": [{"role": "user", "content": content}]},
        }
        parameters: dict[str, object] = {}
        if request.size.mode is not SizeMode.AUTO:
            # 透传路径不做 x→* 转换，尺寸必须是“宽*高”星号格式。
            parameters["size"] = f"{request.size.width}*{request.size.height}"
        if request.image_count != 1:
            parameters["n"] = request.image_count
        for key, value in request.params:
            parameters[key] = value
        if parameters:
            payload["parameters"] = parameters
        response = self._request("POST", IMAGE_EDIT_PATH, json=payload)
        parsed = _parse_ok_generation(response, self._diagnostics)
        return GatewayGenerationResult(images=parsed.images, request_id=parsed.request_id)

    def _validate_edit_request(self, request: ImageEditRequest) -> None:
        """守住网关边界：载荷必须符合能力表中该模型的图片编辑约束。"""
        capability = self._capabilities.workflow_capability(
            request.model_id, Workflow.IMAGE_EDIT
        )
        if capability is None:
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                f"能力表未开放模型 {request.model_id} 的图片编辑",
            )
        limits = capability.reference_limits
        if not limits.min_references <= len(request.references) <= limits.max_references:
            if limits.min_references == limits.max_references:
                expected = f"参考图数量需为 {limits.min_references} 张"
            else:
                expected = (
                    f"参考图数量需在 {limits.min_references}～{limits.max_references} 张之间"
                )
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                f"图片编辑的{expected}，超出能力表中该模型已验证的范围",
            )
        if request.negative_prompt and not capability.supports_negative_prompt:
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                "该模型能力表的图片编辑未开放负向提示词",
            )
        size_error = _edit_size_error(request.size, capability)
        if size_error is not None:
            raise GatewayError(GatewayErrorCategory.REJECTED, size_error)
        if not capability.min_images <= request.image_count <= capability.max_images:
            if capability.min_images == capability.max_images:
                expected_count = f"出图数量仅支持 {capability.min_images} 张"
            else:
                expected_count = (
                    f"出图数量需在 {capability.min_images}～{capability.max_images} 之间"
                )
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                f"图片编辑的{expected_count}，超出能力表中该模型已验证的范围",
            )
        unsupported = [
            key for key, _ in request.params if key not in capability.extra_params
        ]
        if unsupported:
            names = "、".join(unsupported)
            raise GatewayError(
                GatewayErrorCategory.REJECTED,
                f"该模型能力表的图片编辑未开放模型专属参数（{names}）",
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


def _reference_data_url(reference: ReferenceImage) -> str:
    """把参考图编码为 JSON 编辑载荷使用的 data-URL。"""
    encoded = base64.b64encode(reference.content).decode("ascii")
    return f"data:{reference.media_type};base64,{encoded}"


def _edit_size_error(size: SizeSpec, capability: WorkflowCapability) -> str | None:
    """按能力表的图片编辑尺寸规则校验；无错误时返回 None。"""
    if size.mode is SizeMode.AUTO:
        if capability.size.auto_allowed:
            return None
        return "该模型能力表的图片编辑未开放模型自动决定尺寸"
    if size.width is None or size.height is None:
        return "图片编辑的生成尺寸缺少宽高，载荷不完整"
    rule = capability.size
    if (size.width, size.height) in rule.presets:
        return None
    if rule.custom_size_allowed and not rule.custom_size_errors(
        size.width, size.height
    ):
        return None
    return "图片编辑的生成尺寸超出能力表中该模型已验证的范围"


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
            metadata_value = metadata_images[index]
            content = _decode_image_value(metadata_value)
            if content is None and metadata_value.startswith(("http://", "https://")):
                # metadata 是出图真源：其临时地址优先于 data 视图（2026-08-29
                # JSON 编辑实测：n>1 时 data[0].url 被上游覆盖成最后一张图地址，
                # 取 data 会让第一张图静默丢失）。
                url = metadata_value
            elif content is None:
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