from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path

from .capabilities import ModelCapability, Workflow, WorkflowCapability
from .references import ReferenceImage


class GenerationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    PARTIALLY_SUCCEEDED = "partially_succeeded"
    FAILED = "failed"
    UNKNOWN = "unknown"
    CANCELLED = "cancelled"


_ALLOWED_STATUS_TRANSITIONS: dict[GenerationStatus, frozenset[GenerationStatus]] = {
    GenerationStatus.QUEUED: frozenset(
        {GenerationStatus.RUNNING, GenerationStatus.CANCELLED}
    ),
    GenerationStatus.RUNNING: frozenset(
        {
            GenerationStatus.SUCCEEDED,
            GenerationStatus.PARTIALLY_SUCCEEDED,
            GenerationStatus.FAILED,
            GenerationStatus.UNKNOWN,
            GenerationStatus.CANCELLED,
        }
    ),
    GenerationStatus.SUCCEEDED: frozenset(),
    GenerationStatus.PARTIALLY_SUCCEEDED: frozenset(),
    GenerationStatus.FAILED: frozenset(),
    GenerationStatus.UNKNOWN: frozenset(),
    GenerationStatus.CANCELLED: frozenset(),
}


@dataclass(frozen=True)
class GeneratedImage:
    """网关返回的一张结果；可以是已读入的字节或待下载的临时地址。"""

    content: bytes | None = None
    media_type: str | None = None
    url: str | None = None


@dataclass(frozen=True)
class GatewayGenerationResult:
    """生成响应及其可用于追溯的网关请求 ID。"""

    images: tuple[GeneratedImage, ...]
    request_id: str | None = None


class SizeMode(StrEnum):
    AUTO = "auto"
    PRESET = "preset"
    CUSTOM = "custom"


@dataclass(frozen=True)
class SizeSpec:
    """提交快照中的生成尺寸；AUTO 模式下 width/height 为 None。"""

    mode: SizeMode
    width: int | None = None
    height: int | None = None


@dataclass
class TextToImageDraft:
    """文生图表单草稿；模型切换时保留，提交时按目标模型能力过滤。"""

    prompt: str = ""
    model_id: str | None = None
    negative_prompt: str | None = None
    size_mode: SizeMode = SizeMode.AUTO
    size_width: int | None = None
    size_height: int | None = None
    image_count: int = 1


@dataclass(frozen=True)
class TextToImageRequest:
    """提交快照；只包含目标模型能力允许的字段。"""

    prompt: str
    model_id: str
    capability_version: str
    negative_prompt: str | None = None
    size: SizeSpec = SizeSpec(SizeMode.AUTO)
    image_count: int = 1
    params: tuple[tuple[str, object], ...] = ()


@dataclass
class ImageEditDraft:
    prompt: str = ""
    model_id: str | None = None
    negative_prompt: str | None = None
    size_mode: SizeMode = SizeMode.AUTO
    size_width: int | None = None
    size_height: int | None = None
    image_count: int = 1
    reference_paths: tuple[Path, ...] = ()


@dataclass(frozen=True)
class ImageEditRequest:
    prompt: str
    model_id: str
    capability_version: str
    references: tuple[ReferenceImage, ...]
    negative_prompt: str | None = None
    size: SizeSpec = SizeSpec(SizeMode.AUTO)
    image_count: int = 1
    params: tuple[tuple[str, object], ...] = ()


def generate_draft_errors(
    draft: ImageEditDraft,
    capability: ModelCapability | None,
) -> list[str]:
    """按参考图数量选择工作流，并复用对应草稿校验规则。"""
    if draft.reference_paths:
        return image_edit_draft_errors(draft, capability)
    return draft_errors(text_draft_from_generate(draft), capability)


def image_edit_draft_errors(
    draft: ImageEditDraft,
    capability: ModelCapability | None,
) -> list[str]:
    """按模型图片编辑能力校验草稿，返回全部具体错误。"""
    workflow_capability = (
        capability.for_workflow(Workflow.IMAGE_EDIT)
        if capability is not None
        else None
    )
    if workflow_capability is None:
        return ["该模型不支持图片编辑"]
    return [
        *_prompt_errors(draft.prompt),
        *_negative_prompt_errors(
            draft.negative_prompt,
            workflow_capability,
            "该模型的图片编辑不支持负向提示词",
        ),
        *_image_count_errors(draft.image_count, workflow_capability),
        *_reference_count_errors(len(draft.reference_paths), workflow_capability),
        *_size_errors(draft, workflow_capability),
    ]


def text_draft_from_generate(draft: ImageEditDraft) -> TextToImageDraft:
    """提取统一生成草稿中的文生图字段。"""
    return TextToImageDraft(
        prompt=draft.prompt,
        model_id=draft.model_id,
        negative_prompt=draft.negative_prompt,
        size_mode=draft.size_mode,
        size_width=draft.size_width,
        size_height=draft.size_height,
        image_count=draft.image_count,
    )


def _text_workflow_capability(
    capability: ModelCapability | None,
) -> WorkflowCapability | None:
    """解析文生图工作流约束；未知模型或不支持文生图时返回 None。"""
    if capability is None:
        return None
    return capability.for_workflow(Workflow.TEXT_TO_IMAGE)


def draft_errors(draft: TextToImageDraft, capability: ModelCapability | None) -> list[str]:
    """按模型文生图工作流能力校验表单草稿，返回全部具体错误。"""
    if capability is None:
        return ["模型未配置，无法提交"]
    workflow_capability = _text_workflow_capability(capability)
    if workflow_capability is None:
        return ["该模型不支持文生图"]
    return [
        *_prompt_errors(draft.prompt),
        *_image_count_errors(draft.image_count, workflow_capability),
        *_size_errors(draft, workflow_capability),
    ]


def build_request(
    draft: TextToImageDraft,
    capability: ModelCapability,
    capability_version: str,
) -> TextToImageRequest:
    """把草稿冻结为提交快照；忽略并发送目标模型不支持的字段。"""
    errors = draft_errors(draft, capability)
    if errors:
        raise ValueError("；".join(errors))
    if draft.model_id != capability.model_id:
        raise ValueError("模型与能力不匹配，无法提交")
    workflow_capability = _text_workflow_capability(capability)
    assert workflow_capability is not None  # draft_errors 已确认支持文生图
    return TextToImageRequest(
        prompt=draft.prompt.strip(),
        model_id=draft.model_id,
        capability_version=capability_version,
        negative_prompt=_supported_negative_prompt(draft, workflow_capability),
        size=_snapshot_size(draft),
        image_count=draft.image_count,
        params=_request_params(workflow_capability),
    )


def _prompt_errors(prompt: str) -> list[str]:
    return [] if prompt.strip() else ["请输入正向提示词"]


def _negative_prompt_errors(
    negative_prompt: str | None,
    capability: WorkflowCapability,
    message: str,
) -> list[str]:
    if not (negative_prompt or "").strip() or capability.supports_negative_prompt:
        return []
    return [message]


def _image_count_errors(
    image_count: int,
    capability: WorkflowCapability,
) -> list[str]:
    if capability.min_images <= image_count <= capability.max_images:
        return []
    return [f"出图数量需在 {capability.min_images}～{capability.max_images} 之间"]


def _reference_count_errors(
    reference_count: int,
    capability: WorkflowCapability,
) -> list[str]:
    limits = capability.reference_limits
    if limits.min_references <= reference_count <= limits.max_references:
        return []
    if limits.min_references == limits.max_references:
        return [f"参考图数量需为 {limits.min_references} 张"]
    return [f"参考图数量需在 {limits.min_references}～{limits.max_references} 之间"]


def _size_errors(
    draft: TextToImageDraft | ImageEditDraft, capability: WorkflowCapability
) -> list[str]:
    if draft.size_mode is SizeMode.AUTO:
        return (
            []
            if capability.size.auto_allowed
            else ["该模型不支持模型自动决定尺寸"]
        )
    if draft.size_mode is SizeMode.PRESET:
        size = (draft.size_width, draft.size_height)
        return (
            []
            if size in capability.size.presets
            else ["所选常用尺寸不在模型允许的预设中"]
        )
    return _custom_size_errors(draft, capability)


def _custom_size_errors(
    draft: TextToImageDraft | ImageEditDraft,
    capability: WorkflowCapability,
) -> list[str]:
    width, height = draft.size_width, draft.size_height
    if (
        not isinstance(width, int)
        or not isinstance(height, int)
        or width <= 0
        or height <= 0
    ):
        return ["请输入有效的自定义宽高"]
    if not capability.size.custom_size_allowed:
        return ["该模型不支持自定义尺寸"]
    return capability.size.custom_size_errors(width, height)


def _supported_negative_prompt(
    draft: TextToImageDraft,
    capability: WorkflowCapability,
) -> str | None:
    if not capability.supports_negative_prompt or not draft.negative_prompt:
        return None
    return draft.negative_prompt.strip() or None


def _request_params(capability: WorkflowCapability) -> tuple[tuple[str, object], ...]:
    if "watermark" in capability.extra_params:
        return (("watermark", False),)
    return ()


def _snapshot_size(draft: TextToImageDraft | ImageEditDraft) -> SizeSpec:
    """冻结尺寸模式与参数；AUTO 模式不携带宽高（网关适配器不发送尺寸字段）。"""
    return SizeSpec(
        mode=draft.size_mode,
        width=draft.size_width,
        height=draft.size_height,
    )


@dataclass(frozen=True)
class GenerationTask:
    task_id: str
    request: TextToImageRequest | ImageEditRequest
    submitted_at: datetime
    status: GenerationStatus = GenerationStatus.QUEUED
    result_paths: tuple[Path, ...] = ()
    error: str | None = None
    workflow: Workflow = Workflow.TEXT_TO_IMAGE
    gateway_request_id: str | None = None

    @property
    def prompt(self) -> str:
        return self.request.prompt

    def with_status(
        self,
        status: GenerationStatus,
        *,
        result_paths: tuple[Path, ...] = (),
        error: str | None = None,
        gateway_request_id: str | None = None,
    ) -> GenerationTask:
        if status is self.status:
            return self
        if status not in _ALLOWED_STATUS_TRANSITIONS[self.status]:
            raise ValueError(f"非法任务状态迁移：{self.status.value} -> {status.value}")
        return GenerationTask(
            task_id=self.task_id,
            request=self.request,
            submitted_at=self.submitted_at,
            status=status,
            result_paths=result_paths,
            error=error,
            workflow=self.workflow,
            gateway_request_id=(
                gateway_request_id
                if gateway_request_id is not None
                else self.gateway_request_id
            ),
        )

# mutate4py-manifest
# version=4
# projectHash=01fe93674c991f8e
# scope.0.id=generation.generate_draft_errors
# scope.0.kind=function
# scope.0.startLine=125
# scope.0.endLine=132
# scope.0.semanticHash=3b56dccea8ba9c31
# scope.1.id=generation.image_edit_draft_errors
# scope.1.kind=function
# scope.1.startLine=135
# scope.1.endLine=157
# scope.1.semanticHash=5f614054d0ca0911
# scope.2.id=generation.text_draft_from_generate
# scope.2.kind=function
# scope.2.startLine=160
# scope.2.endLine=170
# scope.2.semanticHash=6fb6128df43acdcb
# scope.3.id=generation._text_workflow_capability
# scope.3.kind=function
# scope.3.startLine=173
# scope.3.endLine=179
# scope.3.semanticHash=85bf8b181d9940c1
# scope.4.id=generation.draft_errors
# scope.4.kind=function
# scope.4.startLine=182
# scope.4.endLine=193
# scope.4.semanticHash=c9548460f5c31a1d
# scope.5.id=generation.build_request
# scope.5.kind=function
# scope.5.startLine=196
# scope.5.endLine=217
# scope.5.semanticHash=9c033c5e64cfac22
# scope.6.id=generation._prompt_errors
# scope.6.kind=function
# scope.6.startLine=220
# scope.6.endLine=221
# scope.6.semanticHash=bbb264da6c00135d
# scope.7.id=generation._negative_prompt_errors
# scope.7.kind=function
# scope.7.startLine=224
# scope.7.endLine=231
# scope.7.semanticHash=c8f0a919251a50e7
# scope.8.id=generation._image_count_errors
# scope.8.kind=function
# scope.8.startLine=234
# scope.8.endLine=240
# scope.8.semanticHash=0499b6c385b97be8
# scope.9.id=generation._reference_count_errors
# scope.9.kind=function
# scope.9.startLine=243
# scope.9.endLine=252
# scope.9.semanticHash=0d5deda78d10a7ea
# scope.10.id=generation._size_errors
# scope.10.kind=function
# scope.10.startLine=255
# scope.10.endLine=271
# scope.10.semanticHash=ef0d90435d4e6d8d
# scope.11.id=generation._custom_size_errors
# scope.11.kind=function
# scope.11.startLine=274
# scope.11.endLine=288
# scope.11.semanticHash=3a677b5dc743ea9e
# scope.12.id=generation._supported_negative_prompt
# scope.12.kind=function
# scope.12.startLine=291
# scope.12.endLine=297
# scope.12.semanticHash=9e5dc9424fbbff83
# scope.13.id=generation._request_params
# scope.13.kind=function
# scope.13.startLine=300
# scope.13.endLine=303
# scope.13.semanticHash=c26efe12316df83d
# scope.14.id=generation._snapshot_size
# scope.14.kind=function
# scope.14.startLine=306
# scope.14.endLine=312
# scope.14.semanticHash=34ec9590622abe1f
# scope.15.id=generation.GenerationTask.prompt
# scope.15.kind=method
# scope.15.startLine=327
# scope.15.endLine=328
# scope.15.semanticHash=6e40772bd2c7038c
# scope.16.id=generation.GenerationTask.with_status
# scope.16.kind=method
# scope.16.startLine=330
# scope.16.endLine=355
# scope.16.semanticHash=0bad30a15f0a2094
