from __future__ import annotations

import unittest
from pathlib import Path

from ugc_image_tool.capabilities import (
    BUILTIN_CAPABILITIES,
    CAPABILITY_TABLE_VERSION,
    ModelCapability,
    ReferenceLimits,
    SizeRule,
    Workflow,
    WorkflowCapability,
)
from ugc_image_tool.generation import (
    ImageEditDraft,
    SizeMode,
    SizeSpec,
    TextToImageDraft,
    build_request,
    draft_errors,
    generate_draft_errors,
    image_edit_draft_errors,
)

QWEN = BUILTIN_CAPABILITIES["qwen-image-3.0-pro"]


def text_capability(
    model_id: str,
    display_name: str,
    *,
    supports_negative_prompt: bool = False,
    min_images: int = 1,
    max_images: int = 1,
    size: SizeRule | None = None,
    extra_params: tuple[str, ...] = (),
) -> ModelCapability:
    """构造只提供文生图工作流的模型能力，用于草稿过滤测试。"""
    return ModelCapability(
        model_id=model_id,
        display_name=display_name,
        workflow_capabilities=(WorkflowCapability(
            workflow=Workflow.TEXT_TO_IMAGE,
            supports_negative_prompt=supports_negative_prompt,
            min_images=min_images,
            max_images=max_images,
            size=size or SizeRule(auto_allowed=True, presets=((1024, 1024),)),
            reference_limits=ReferenceLimits(min_references=0, max_references=0),
            extra_params=extra_params,
        ),),
    )


TEXT_ONLY_NO_NEGATIVE = text_capability(
    "z-image-turbo",
    "快速写实文生图",
)


def qwen_draft(**overrides: object) -> TextToImageDraft:
    draft = TextToImageDraft(prompt="一只蓝色小鸟", model_id="qwen-image-3.0-pro")
    for key, value in overrides.items():
        setattr(draft, key, value)
    return draft


class DraftValidationTests(unittest.TestCase):
    def test_valid_draft_has_no_errors(self) -> None:
        self.assertEqual([], draft_errors(qwen_draft(), QWEN))

    def test_empty_prompt_is_rejected(self) -> None:
        self.assertIn("请输入正向提示词", draft_errors(qwen_draft(prompt="  "), QWEN))

    def test_unknown_model_is_rejected(self) -> None:
        errors = draft_errors(qwen_draft(model_id="wan2.7-image"), None)
        self.assertIn("模型未配置", errors[0])

    def test_model_without_text_to_image_workflow_is_rejected(self) -> None:
        edit_only = ModelCapability(
            model_id="edit-only",
            display_name="仅编辑",
            workflow_capabilities=(WorkflowCapability(
                workflow=Workflow.IMAGE_EDIT,
                supports_negative_prompt=True,
                min_images=1,
                max_images=1,
                size=SizeRule(auto_allowed=True, presets=((1024, 1024),)),
                reference_limits=ReferenceLimits(min_references=1, max_references=1),
            ),),
        )
        self.assertIn("不支持文生图", draft_errors(qwen_draft(model_id="edit-only"), edit_only)[0])

    def test_image_count_out_of_range_is_rejected(self) -> None:
        self.assertIn("出图数量需在 1～2 之间", draft_errors(qwen_draft(image_count=0), QWEN))
        self.assertIn("出图数量需在 1～2 之间", draft_errors(qwen_draft(image_count=3), QWEN))

    def test_custom_size_total_pixel_bounds(self) -> None:
        self.assertEqual(
            [],
            draft_errors(qwen_draft(size_mode=SizeMode.CUSTOM, size_width=512, size_height=512), QWEN),
        )
        self.assertEqual(
            [],
            draft_errors(qwen_draft(size_mode=SizeMode.CUSTOM, size_width=2048, size_height=2048), QWEN),
        )
        errors = draft_errors(
            qwen_draft(size_mode=SizeMode.CUSTOM, size_width=100, size_height=100), QWEN
        )
        self.assertTrue(any("总像素" in error for error in errors))

    def test_custom_size_aspect_ratio_bounds(self) -> None:
        errors = draft_errors(
            qwen_draft(size_mode=SizeMode.CUSTOM, size_width=8192, size_height=512), QWEN
        )
        self.assertTrue(any("宽高比" in error for error in errors))
        errors = draft_errors(
            qwen_draft(size_mode=SizeMode.CUSTOM, size_width=512, size_height=8192), QWEN
        )
        self.assertTrue(any("宽高比" in error for error in errors))

    def test_custom_size_requires_positive_integers(self) -> None:
        for width, height in ((0, 512), (512, 0)):
            errors = draft_errors(
                qwen_draft(
                    size_mode=SizeMode.CUSTOM,
                    size_width=width,
                    size_height=height,
                ),
                QWEN,
            )
            self.assertIn("请输入有效的自定义宽高", errors)

    def test_positive_unit_dimensions_reach_capability_validation(self) -> None:
        for width, height in ((1, 512), (512, 1)):
            errors = draft_errors(
                qwen_draft(
                    size_mode=SizeMode.CUSTOM,
                    size_width=width,
                    size_height=height,
                ),
                QWEN,
            )
            self.assertNotIn("请输入有效的自定义宽高", errors)

    def test_preset_outside_capability_is_rejected(self) -> None:
        errors = draft_errors(
            qwen_draft(size_mode=SizeMode.PRESET, size_width=512, size_height=512), QWEN
        )
        self.assertTrue(any("预设" in error for error in errors))

    def test_auto_mode_rejected_when_not_allowed(self) -> None:
        no_auto = text_capability(
            "no-auto",
            "不允许自动",
            supports_negative_prompt=True,
            size=SizeRule(auto_allowed=False, presets=((1024, 1024),)),
        )
        errors = draft_errors(qwen_draft(model_id="no-auto"), no_auto)
        self.assertTrue(any("自动决定" in error for error in errors))

    def test_generate_draft_without_references_reuses_text_validation(self) -> None:
        errors = generate_draft_errors(
            ImageEditDraft(
                prompt="  ",
                model_id="qwen-image-3.0-pro",
                image_count=3,
            ),
            QWEN,
        )

        self.assertEqual(
            ["请输入正向提示词", "出图数量需在 1～2 之间"],
            errors,
        )

    def test_generate_draft_with_references_reuses_edit_validation(self) -> None:
        errors = generate_draft_errors(
            ImageEditDraft(
                prompt="保留构图",
                model_id="qwen-image-3.0-pro",
                image_count=6,
                reference_paths=(Path("reference.png"),),
            ),
            QWEN,
        )

        self.assertEqual(["出图数量需在 1～5 之间"], errors)

    def test_image_edit_validation_requires_at_least_one_reference(self) -> None:
        errors = image_edit_draft_errors(
            ImageEditDraft(prompt="保留构图", model_id="qwen-image-3.0-pro"),
            QWEN,
        )

        self.assertEqual(["参考图数量需在 1～3 之间"], errors)

    def test_image_edit_validation_describes_an_exact_reference_limit(self) -> None:
        exact_reference_capability = ModelCapability(
            model_id="exact-edit",
            display_name="固定一张参考图",
            workflow_capabilities=(
                WorkflowCapability(
                    workflow=Workflow.IMAGE_EDIT,
                    supports_negative_prompt=False,
                    min_images=1,
                    max_images=1,
                    size=SizeRule(auto_allowed=True, presets=()),
                    reference_limits=ReferenceLimits(
                        min_references=1,
                        max_references=1,
                    ),
                ),
            ),
        )
        errors = image_edit_draft_errors(
            ImageEditDraft(prompt="保留构图", model_id="exact-edit"),
            exact_reference_capability,
        )

        self.assertEqual(["参考图数量需为 1 张"], errors)


class DraftSnapshotFilteringTests(unittest.TestCase):
    def test_request_keeps_supported_fields(self) -> None:
        draft = qwen_draft(
            negative_prompt="不要文字",
            size_mode=SizeMode.PRESET,
            size_width=1024,
            size_height=1024,
            image_count=2,
        )

        request = build_request(draft, QWEN, CAPABILITY_TABLE_VERSION)

        self.assertEqual("一只蓝色小鸟", request.prompt)
        self.assertEqual("qwen-image-3.0-pro", request.model_id)
        self.assertEqual("不要文字", request.negative_prompt)
        self.assertEqual(SizeSpec(SizeMode.PRESET, 1024, 1024), request.size)
        self.assertEqual(2, request.image_count)
        self.assertIn(("watermark", False), request.params)
        self.assertEqual(CAPABILITY_TABLE_VERSION, request.capability_version)

    def test_auto_size_is_frozen_with_auto_mode(self) -> None:
        request = build_request(qwen_draft(), QWEN, CAPABILITY_TABLE_VERSION)
        self.assertEqual(SizeSpec(SizeMode.AUTO), request.size)

    def test_unsupported_negative_prompt_is_dropped(self) -> None:
        draft = TextToImageDraft(
            prompt="快速写实",
            model_id="z-image-turbo",
            negative_prompt="不要文字",
        )

        request = build_request(draft, TEXT_ONLY_NO_NEGATIVE, CAPABILITY_TABLE_VERSION)

        self.assertIsNone(request.negative_prompt)
        self.assertEqual((), request.params)

    def test_blank_negative_prompt_becomes_none(self) -> None:
        request = build_request(qwen_draft(negative_prompt="   "), QWEN, CAPABILITY_TABLE_VERSION)
        self.assertIsNone(request.negative_prompt)

    def test_watermark_only_when_capability_declares_it(self) -> None:
        no_watermark = text_capability(
            "plain",
            "无水印参数",
            supports_negative_prompt=True,
            max_images=2,
        )
        request = build_request(qwen_draft(model_id="plain"), no_watermark, "v-test")
        self.assertEqual((), request.params)

    def test_invalid_draft_raises_on_snapshot(self) -> None:
        with self.assertRaises(ValueError):
            build_request(qwen_draft(image_count=9), QWEN, CAPABILITY_TABLE_VERSION)

    def test_mismatched_capability_raises_on_snapshot(self) -> None:
        with self.assertRaises(ValueError) as raised:
            build_request(qwen_draft(), TEXT_ONLY_NO_NEGATIVE, CAPABILITY_TABLE_VERSION)
        self.assertIn("不匹配", str(raised.exception))

    def test_request_is_immutable(self) -> None:
        request = build_request(qwen_draft(), QWEN, CAPABILITY_TABLE_VERSION)
        with self.assertRaises(AttributeError):
            request.prompt = "改不了"  # type: ignore[misc]

    def test_draft_keeps_values_across_model_switch(self) -> None:
        draft = qwen_draft(
            negative_prompt="不要文字",
            size_mode=SizeMode.PRESET,
            size_width=1024,
            size_height=1024,
            image_count=1,
        )
        draft.model_id = "z-image-turbo"

        request = build_request(draft, TEXT_ONLY_NO_NEGATIVE, CAPABILITY_TABLE_VERSION)

        self.assertIsNone(request.negative_prompt)
        self.assertEqual(SizeSpec(SizeMode.PRESET, 1024, 1024), request.size)
        self.assertEqual(1, request.image_count)


if __name__ == "__main__":
    unittest.main()
