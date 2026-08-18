from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path

from .capabilities import ModelCapability, Workflow
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
    content: bytes
    media_type: str


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


def draft_errors(draft: TextToImageDraft, capability: ModelCapability | None) -> list[str]:
    """按模型能力校验表单草稿，返回全部具体错误；空列表表示可提交。"""
    if capability is None:
        return ["模型未配置，无法提交"]
    if Workflow.TEXT_TO_IMAGE not in capability.workflows:
        return ["该模型不支持文生图"]
    errors: list[str] = []
    if not draft.prompt.strip():
        errors.append("请输入正向提示词")
    if not capability.min_images <= draft.image_count <= capability.max_images:
        errors.append(f"出图数量需在 {capability.min_images}～{capability.max_images} 之间")
    errors.extend(_size_errors(draft, capability))
    return errors


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
    size = _snapshot_size(draft)
    negative_prompt: str | None = None
    if capability.supports_negative_prompt and draft.negative_prompt:
        negative_prompt = draft.negative_prompt.strip() or None
    params: tuple[tuple[str, object], ...] = ()
    if "watermark" in capability.extra_params:
        # 水印在第一版固定关闭，不在普通界面暴露。
        params = (("watermark", False),)
    return TextToImageRequest(
        prompt=draft.prompt.strip(),
        model_id=draft.model_id,
        capability_version=capability_version,
        negative_prompt=negative_prompt,
        size=size,
        image_count=draft.image_count,
        params=params,
    )


def _size_errors(draft: TextToImageDraft, capability: ModelCapability) -> list[str]:
    errors: list[str] = []
    if draft.size_mode is SizeMode.AUTO:
        if not capability.size.auto_allowed:
            errors.append("该模型不支持模型自动决定尺寸")
        return errors
    if draft.size_mode is SizeMode.PRESET:
        if (draft.size_width, draft.size_height) not in capability.size.presets:
            errors.append("所选常用尺寸不在模型允许的预设中")
        return errors
    width, height = draft.size_width, draft.size_height
    if (
        not isinstance(width, int)
        or not isinstance(height, int)
        or width <= 0
        or height <= 0
    ):
        errors.append("请输入有效的自定义宽高")
        return errors
    return capability.size.custom_size_errors(width, height)


def _snapshot_size(draft: TextToImageDraft) -> SizeSpec:
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

    @property
    def prompt(self) -> str:
        return self.request.prompt

    def with_status(
        self,
        status: GenerationStatus,
        *,
        result_paths: tuple[Path, ...] = (),
        error: str | None = None,
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
        )
