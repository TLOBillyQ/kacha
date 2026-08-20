"""本地模型能力表：决定每个模型允许的工作流、参数与取值范围。

网关模型列表只决定模型当前是否可用；本模块决定可提交的内容。未知模型
默认禁用，不按模型名称猜测能力。能力按工作流表达：同一模型可以为文生图
与图片编辑分别声明负向提示词、出图数量、生成尺寸与参考图限制。
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Iterable, cast


class Workflow(StrEnum):
    TEXT_TO_IMAGE = "text_to_image"
    IMAGE_EDIT = "image_edit"


class ModelTier(StrEnum):
    """模型档位：上架清单的表达；缺省（无档位）表示不上架。"""

    FLAGSHIP = "flagship"
    ECONOMY = "economy"

    @property
    def label(self) -> str:
        return _TIER_LABELS[self]


_TIER_LABELS = {
    ModelTier.FLAGSHIP: "旗舰",
    ModelTier.ECONOMY: "经济",
}


# 内置能力表的稳定版本标识，随提交快照冻结，用于追溯任务适用的能力版本。
CAPABILITY_TABLE_VERSION = "capabilities-v1"


@dataclass(frozen=True)
class SizeRule:
    """生成尺寸规则：是否允许模型自动决定、常用预设和自定义校验边界。"""

    auto_allowed: bool
    presets: tuple[tuple[int, int], ...]
    # 是否允许用户在有效边界内自定义宽高；图片编辑仅实测了自动尺寸时为 False。
    custom_size_allowed: bool = True
    min_total_pixels: int | None = None
    max_total_pixels: int | None = None
    # 宽高比按 width / height 计算；None 表示该方向无约束。
    min_aspect_ratio: float | None = None
    max_aspect_ratio: float | None = None

    def custom_size_errors(self, width: int, height: int) -> list[str]:
        """按本规则校验自定义宽高，返回全部具体错误。"""
        errors: list[str] = []
        total = width * height
        if (
            self.min_total_pixels is not None and total < self.min_total_pixels
        ) or (
            self.max_total_pixels is not None and total > self.max_total_pixels
        ):
            errors.append(
                f"自定义尺寸总像素需在 {self.min_total_pixels}～{self.max_total_pixels} 之间"
            )
        ratio = width / height
        if (
            self.min_aspect_ratio is not None and ratio < self.min_aspect_ratio
        ) or (
            self.max_aspect_ratio is not None and ratio > self.max_aspect_ratio
        ):
            errors.append(
                f"自定义尺寸宽高比需在 {self.min_aspect_ratio}～{self.max_aspect_ratio} 之间"
            )
        return errors


@dataclass(frozen=True)
class ReferenceLimits:
    """工作流接受的参考图数量范围；全 0 表示该工作流不接收参考图。"""

    min_references: int
    max_references: int


@dataclass(frozen=True)
class WorkflowCapability:
    """单个工作流下的参数约束。"""

    workflow: Workflow
    supports_negative_prompt: bool
    min_images: int
    max_images: int
    size: SizeRule
    reference_limits: ReferenceLimits
    # 模型专属参数名；水印等固定值由应用层按规则填充。
    extra_params: tuple[str, ...] = ()


@dataclass(frozen=True)
class ModelCapability:
    """一个模型按工作流拆分的全部能力。"""

    model_id: str
    display_name: str
    workflow_capabilities: tuple[WorkflowCapability, ...]
    # 档位是条目级（模型级）上架标记；None 表示不上架、不出现在选择器中。
    tier: ModelTier | None = None

    @property
    def workflows(self) -> frozenset[Workflow]:
        """该模型声明支持的工作流集合。"""
        return frozenset(c.workflow for c in self.workflow_capabilities)

    def for_workflow(self, workflow: Workflow) -> WorkflowCapability | None:
        """返回目标工作流的能力；模型不支持该工作流时返回 None。"""
        return next(
            (
                capability
                for capability in self.workflow_capabilities
                if capability.workflow is workflow
            ),
            None,
        )


# 依据 contracts/fixtures/2026-08-17-team-gateway 实测结果配置文生图：
# n 仅实测到 1 与 2；negative_prompt/size/watermark 字段实测可用。
QWEN_TEXT_WORKFLOW = WorkflowCapability(
    workflow=Workflow.TEXT_TO_IMAGE,
    supports_negative_prompt=True,
    min_images=1,
    max_images=2,
    size=SizeRule(
        auto_allowed=True,
        presets=((1024, 1024), (2048, 2048), (1920, 1080), (1080, 1920)),
        min_total_pixels=262_144,
        max_total_pixels=4_194_304,
        min_aspect_ratio=1 / 8,
        max_aspect_ratio=8.0,
    ),
    reference_limits=ReferenceLimits(min_references=0, max_references=0),
    extra_params=("watermark",),
)

# 图片编辑依据同一夹具的实测结果：仅验证过 1 张参考图、模型自动决定尺寸、
# 单张出图且无负向提示词，其他组合未实测，不在内置能力中开放。
QWEN_EDIT_WORKFLOW = WorkflowCapability(
    workflow=Workflow.IMAGE_EDIT,
    supports_negative_prompt=False,
    min_images=1,
    max_images=1,
    size=SizeRule(auto_allowed=True, presets=(), custom_size_allowed=False),
    reference_limits=ReferenceLimits(min_references=1, max_references=1),
)

BUILTIN_CAPABILITIES: dict[str, ModelCapability] = {
    "qwen-image-3.0-pro": ModelCapability(
        model_id="qwen-image-3.0-pro",
        display_name="Qwen Image 3.0",
        workflow_capabilities=(QWEN_TEXT_WORKFLOW, QWEN_EDIT_WORKFLOW),
        tier=ModelTier.FLAGSHIP,
    ),
}


@dataclass(frozen=True)
class AvailableModel:
    """网关返回的可用模型；capability 为 None 表示能力表未知（未配置）。"""

    model_id: str
    capability: ModelCapability | None


def enforce_special_constraints(capability: ModelCapability) -> ModelCapability:
    """把特殊模型约束作为能力表规则的一部分，任何入口都不能绕过。"""
    if capability.model_id != "z-image-turbo":
        return capability
    text_only = tuple(
        workflow
        for workflow in capability.workflow_capabilities
        if workflow.workflow is Workflow.TEXT_TO_IMAGE
    )
    return dataclasses.replace(
        capability,
        display_name=Z_IMAGE_TURBO_DISPLAY_NAME,
        workflow_capabilities=text_only,
    )


class CapabilityRegistry:
    """内置能力表与覆盖文件的合并视图，按模型 ID 解析能力。"""

    def __init__(self, override_file: Path | None = None) -> None:
        self._override_file = override_file
        table = dict(BUILTIN_CAPABILITIES)
        if override_file is not None:
            table.update(load_override_file(override_file))
        self._table = {
            model_id: enforce_special_constraints(capability)
            for model_id, capability in table.items()
        }
        self._check_tier_conflicts()

    def _check_tier_conflicts(self) -> None:
        """同一档位、同一工作流最多一个上架模型；覆盖文件引入冲突时整份拒绝。"""
        occupied: dict[tuple[ModelTier, Workflow], str] = {}
        conflicts: list[str] = []
        for capability in self._table.values():
            if capability.tier is None:
                continue
            for workflow in capability.workflows:
                key = (capability.tier, workflow)
                if key in occupied:
                    conflicts.append(
                        f"档位 {capability.tier.label} 在工作流 {workflow.value} 下存在多个上架模型："
                        f"{occupied[key]} 与 {capability.model_id}"
                    )
                else:
                    occupied[key] = capability.model_id
        if not conflicts:
            return
        if self._override_file is not None:
            raise CapabilityOverrideError(conflicts)
        raise ValueError("内置能力表存在同档位冲突：" + "；".join(conflicts))

    @property
    def version(self) -> str:
        """生效能力表的稳定标识；覆盖文件内容变化时标识随之变化。"""
        if self._override_file is None:
            return CAPABILITY_TABLE_VERSION
        try:
            digest = hashlib.sha256(self._override_file.read_bytes()).hexdigest()[:12]
        except OSError:
            digest = "unreadable"
        return f"{CAPABILITY_TABLE_VERSION}+override-{digest}"

    def capability(self, model_id: str) -> ModelCapability | None:
        return self._table.get(model_id)

    def workflow_capability(
        self, model_id: str, workflow: Workflow
    ) -> WorkflowCapability | None:
        """按模型与工作流解析约束；未知模型或不支持该工作流时返回 None。"""
        capability = self._table.get(model_id)
        if capability is None:
            return None
        return capability.for_workflow(workflow)

    def for_workflow(self, workflow: Workflow) -> tuple[ModelCapability, ...]:
        return tuple(
            capability
            for capability in self._table.values()
            if workflow in capability.workflows
        )

    def shelved_tiers(self, workflow: Workflow) -> tuple[ModelTier, ...]:
        """该工作流当前上架的档位，按旗舰、经济顺序；供页面构建分段开关。"""
        return tuple(
            tier
            for tier in ModelTier
            if self.resolve_tier(workflow, tier) is not None
        )

    def resolve_tier(self, workflow: Workflow, tier: ModelTier) -> ModelCapability | None:
        """按工作流与档位解析当前上架的模型；该档位未上架此工作流时返回 None。"""
        for capability in self._table.values():
            if capability.tier is tier and workflow in capability.workflows:
                return capability
        return None

    def merge(self, gateway_model_ids: Iterable[str]) -> tuple[AvailableModel, ...]:
        return tuple(
            AvailableModel(model_id=model_id, capability=self._table.get(model_id))
            for model_id in gateway_model_ids
        )


class CapabilityOverrideError(ValueError):
    """能力覆盖文件解析或校验失败；携带全部具体原因。"""

    def __init__(self, reasons: list[str]) -> None:
        self.reasons = reasons
        super().__init__("；".join(reasons))


# z-image-turbo 只能标记为“快速写实文生图”且不进入图片编辑工作流。
Z_IMAGE_TURBO_DISPLAY_NAME = "快速写实文生图"

_OVERRIDE_SCHEMA_VERSION = 2


def load_override_file(path: Path) -> dict[str, ModelCapability]:
    """加载能力覆盖文件，按模型 ID 覆盖内置定义；任一错误拒绝整份覆盖。"""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CapabilityOverrideError(
            [f"无法读取能力覆盖文件 {path.name}：JSON 解析失败（{error}）"]
        ) from error

    errors: list[str] = []
    if not isinstance(raw, dict):
        raise CapabilityOverrideError(["能力覆盖文件必须是 JSON 对象"])
    if raw.get("schema_version") != _OVERRIDE_SCHEMA_VERSION:
        errors.append(f"schema_version 必须为 {_OVERRIDE_SCHEMA_VERSION}")
    models = raw.get("models")
    if not isinstance(models, list):
        errors.append("models 必须是数组")
        raise CapabilityOverrideError(errors)
    if not models:
        errors.append("models 不能为空")
        raise CapabilityOverrideError(errors)

    table: dict[str, ModelCapability] = {}
    for index, entry in enumerate(models):
        prefix = f"models[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix} 必须是对象")
            continue
        try:
            capability = _parse_capability(entry, prefix)
        except _EntryError as error:
            errors.extend(error.reasons)
            continue
        if capability.model_id in table:
            errors.append(f"{prefix} 模型 {capability.model_id} 重复定义")
            continue
        table[capability.model_id] = capability
    if errors:
        raise CapabilityOverrideError(errors)
    return table


class _EntryError(ValueError):
    def __init__(self, reasons: list[str]) -> None:
        self.reasons = reasons
        super().__init__("；".join(reasons))


def _parse_capability(entry: dict[str, Any], prefix: str) -> ModelCapability:
    errors: list[str] = []
    model_id = entry.get("model_id")
    if not isinstance(model_id, str) or not model_id.strip():
        errors.append(f"{prefix}.model_id 必须是非空字符串")
        model_id = ""
    display_name = entry.get("display_name")
    if not isinstance(display_name, str) or not display_name.strip():
        errors.append(f"{prefix}.display_name 必须是非空字符串")
        display_name = ""

    workflows = _parse_workflows(entry.get("workflows"), f"{prefix}.workflows", errors)
    tier = _parse_tier(entry.get("tier"), f"{prefix}.tier", errors)

    if errors:
        raise _EntryError(errors)

    capability = ModelCapability(
        model_id=model_id,
        display_name=display_name,
        workflow_capabilities=workflows,
        tier=tier,
    )
    _validate_special_model_constraint(capability, prefix, errors)
    if errors:
        raise _EntryError(errors)
    return capability


def _parse_workflows(
    value: Any, prefix: str, errors: list[str]
) -> tuple[WorkflowCapability, ...]:
    if not isinstance(value, list) or not value:
        errors.append(f"{prefix} 必须是非空数组")
        return ()
    workflows: list[WorkflowCapability] = []
    seen: set[Workflow] = set()
    for index, entry in enumerate(value):
        entry_prefix = f"{prefix}[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{entry_prefix} 必须是对象")
            continue
        workflow = _parse_workflow(entry.get("workflow"), f"{entry_prefix}.workflow", errors)
        if workflow is None:
            continue
        if workflow in seen:
            errors.append(f"{entry_prefix} 工作流 {workflow.value} 重复定义")
            continue
        seen.add(workflow)
        workflows.append(_parse_workflow_capability(workflow, entry, entry_prefix, errors))
    return tuple(workflows)


def _parse_tier(value: Any, prefix: str, errors: list[str]) -> ModelTier | None:
    if value is None:
        return None  # 缺省合法：不上架
    if not isinstance(value, str):
        errors.append(f"{prefix} 必须是字符串")
        return None
    try:
        return ModelTier(value)
    except ValueError:
        allowed = "、".join(tier.value for tier in ModelTier)
        errors.append(f"{prefix} 包含不受支持的档位：{value!r}（可选：{allowed}）")
        return None


def _parse_workflow(value: Any, prefix: str, errors: list[str]) -> Workflow | None:
    if not isinstance(value, str):
        errors.append(f"{prefix} 必须是字符串")
        return None
    try:
        return Workflow(value)
    except ValueError:
        errors.append(f"{prefix} 包含不受支持的工作流：{value!r}")
        return None


def _parse_workflow_capability(
    workflow: Workflow, entry: dict[str, Any], prefix: str, errors: list[str]
) -> WorkflowCapability:
    supports_negative_prompt = entry.get("supports_negative_prompt")
    if not isinstance(supports_negative_prompt, bool):
        errors.append(f"{prefix}.supports_negative_prompt 必须是布尔值")
    min_images = _parse_int(entry.get("min_images"), f"{prefix}.min_images", errors)
    max_images = _parse_int(entry.get("max_images"), f"{prefix}.max_images", errors)
    if (
        isinstance(min_images, int)
        and isinstance(max_images, int)
        and not 1 <= min_images <= max_images
    ):
        errors.append(f"{prefix} 出图数量范围无效：1 ≤ min ≤ max")
    size = _parse_size_rule(entry.get("size"), f"{prefix}.size", errors)
    reference_limits = _parse_reference_limits(
        entry.get("reference_limits"), f"{prefix}.reference_limits", errors
    )
    extra_params = _parse_extra_params(
        entry.get("extra_params"), f"{prefix}.extra_params", errors
    )

    return WorkflowCapability(
        workflow=workflow,
        supports_negative_prompt=cast(bool, supports_negative_prompt),
        min_images=min_images,
        max_images=max_images,
        size=size,
        reference_limits=reference_limits,
        extra_params=extra_params,
    )


def _parse_int(value: Any, prefix: str, errors: list[str]) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        errors.append(f"{prefix} 必须是整数")
        return 0
    return value


def _parse_reference_limits(
    value: Any, prefix: str, errors: list[str]
) -> ReferenceLimits:
    if value is None:
        return ReferenceLimits(min_references=0, max_references=0)
    if not isinstance(value, dict):
        errors.append(f"{prefix} 必须是对象")
        return ReferenceLimits(min_references=0, max_references=0)
    min_refs = _parse_int(value.get("min_references"), f"{prefix}.min_references", errors)
    max_refs = _parse_int(value.get("max_references"), f"{prefix}.max_references", errors)
    if (
        isinstance(min_refs, int)
        and isinstance(max_refs, int)
        and not 0 <= min_refs <= max_refs
    ):
        errors.append(f"{prefix} 参考图数量范围无效：0 ≤ min ≤ max")
    return ReferenceLimits(min_references=min_refs, max_references=max_refs)


def _parse_size_rule(value: Any, prefix: str, errors: list[str]) -> SizeRule:
    if not isinstance(value, dict):
        errors.append(f"{prefix} 必须是对象")
        return SizeRule(auto_allowed=False, presets=())
    auto_allowed = value.get("auto_allowed")
    if not isinstance(auto_allowed, bool):
        errors.append(f"{prefix}.auto_allowed 必须是布尔值")
    custom_size_allowed = value.get("custom_size_allowed")
    if custom_size_allowed is not None and not isinstance(custom_size_allowed, bool):
        errors.append(f"{prefix}.custom_size_allowed 必须是布尔值")
    presets = _parse_presets(value.get("presets"), f"{prefix}.presets", errors)
    min_pixels = _parse_positive_int(value.get("min_total_pixels"), f"{prefix}.min_total_pixels", errors)
    max_pixels = _parse_positive_int(value.get("max_total_pixels"), f"{prefix}.max_total_pixels", errors)
    if isinstance(min_pixels, int) and isinstance(max_pixels, int) and min_pixels > max_pixels:
        errors.append(f"{prefix} 总像素范围无效：min ≤ max")
    min_ratio = _parse_positive_number(value.get("min_aspect_ratio"), f"{prefix}.min_aspect_ratio", errors)
    max_ratio = _parse_positive_number(value.get("max_aspect_ratio"), f"{prefix}.max_aspect_ratio", errors)
    if (
        isinstance(min_ratio, (int, float))
        and isinstance(max_ratio, (int, float))
        and min_ratio > max_ratio
    ):
        errors.append(f"{prefix} 宽高比范围无效：min ≤ max")

    size = SizeRule(
        auto_allowed=cast(bool, auto_allowed),
        presets=presets,
        custom_size_allowed=(
            cast(bool, custom_size_allowed)
            if custom_size_allowed is not None
            else True
        ),
        min_total_pixels=min_pixels,
        max_total_pixels=max_pixels,
        min_aspect_ratio=min_ratio,
        max_aspect_ratio=max_ratio,
    )
    for width, height in presets:
        custom_errors = size.custom_size_errors(width, height)
        if custom_errors:
            errors.append(
                f"{prefix}.presets 预设 {width}×{height} 不满足模型尺寸规则："
                + "；".join(custom_errors)
            )
    return size


def _parse_presets(value: Any, prefix: str, errors: list[str]) -> tuple[tuple[int, int], ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        errors.append(f"{prefix} 必须是数组")
        return ()
    presets: list[tuple[int, int]] = []
    for index, preset in enumerate(value):
        if (
            not isinstance(preset, list)
            or len(preset) != 2
            or isinstance(preset[0], bool)
            or isinstance(preset[1], bool)
            or not isinstance(preset[0], int)
            or not isinstance(preset[1], int)
            or preset[0] <= 0
            or preset[1] <= 0
        ):
            errors.append(f"{prefix}[{index}] 必须是两个正整数组成的宽高")
            continue
        presets.append((preset[0], preset[1]))
    return tuple(presets)


def _parse_positive_int(value: Any, prefix: str, errors: list[str]) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        errors.append(f"{prefix} 必须是正整数")
        return None
    return value


def _parse_positive_number(value: Any, prefix: str, errors: list[str]) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        errors.append(f"{prefix} 必须是正数")
        return None
    return float(value)


def _parse_extra_params(value: Any, prefix: str, errors: list[str]) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        errors.append(f"{prefix} 必须是字符串数组")
        return ()
    return tuple(value)


def _validate_special_model_constraint(
    capability: ModelCapability, prefix: str, errors: list[str]
) -> None:
    if capability.model_id != "z-image-turbo":
        return
    if capability.display_name != Z_IMAGE_TURBO_DISPLAY_NAME:
        errors.append(
            f"{prefix} z-image-turbo 只能标记为“{Z_IMAGE_TURBO_DISPLAY_NAME}”"
        )
    if Workflow.IMAGE_EDIT in capability.workflows:
        errors.append(
            f"{prefix} z-image-turbo 只能标记为“{Z_IMAGE_TURBO_DISPLAY_NAME}”，不得配置图片编辑工作流"
        )
