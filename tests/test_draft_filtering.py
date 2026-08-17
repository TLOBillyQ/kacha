from __future__ import annotations

import unittest

from ugc_image_tool.capabilities import (
    BUILTIN_CAPABILITIES,
    CAPABILITY_TABLE_VERSION,
    ModelCapability,
    SizeRule,
    Workflow,
)
from ugc_image_tool.generation import (
    SizeMode,
    SizeSpec,
    TextToImageDraft,
    build_request,
    draft_errors,
)

QWEN = BUILTIN_CAPABILITIES["qwen-image-3.0-pro"]

TEXT_ONLY_NO_NEGATIVE = ModelCapability(
    model_id="z-image-turbo",
    display_name="快速写实文生图",
    workflows=frozenset({Workflow.TEXT_TO_IMAGE}),
    supports_negative_prompt=False,
    min_images=1,
    max_images=1,
    size=SizeRule(auto_allowed=True, presets=((1024, 1024),)),
)


def qwen_draft(**overrides) -> TextToImageDraft:
    fields = {"prompt": "一只蓝色小鸟", "model_id": "qwen-image-3.0-pro"}
    fields.update(overrides)
    return TextToImageDraft(**fields)


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
            workflows=frozenset({Workflow.IMAGE_EDIT}),
            supports_negative_prompt=True,
            min_images=1,
            max_images=1,
            size=SizeRule(auto_allowed=True, presets=((1024, 1024),)),
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
        errors = draft_errors(
            qwen_draft(size_mode=SizeMode.CUSTOM, size_width=0, size_height=-1), QWEN
        )
        self.assertTrue(any("宽高" in error for error in errors))

    def test_preset_outside_capability_is_rejected(self) -> None:
        errors = draft_errors(
            qwen_draft(size_mode=SizeMode.PRESET, size_width=512, size_height=512), QWEN
        )
        self.assertTrue(any("预设" in error for error in errors))

    def test_auto_mode_rejected_when_not_allowed(self) -> None:
        no_auto = ModelCapability(
            model_id="no-auto",
            display_name="不允许自动",
            workflows=frozenset({Workflow.TEXT_TO_IMAGE}),
            supports_negative_prompt=True,
            min_images=1,
            max_images=1,
            size=SizeRule(auto_allowed=False, presets=((1024, 1024),)),
        )
        errors = draft_errors(qwen_draft(model_id="no-auto"), no_auto)
        self.assertTrue(any("自动决定" in error for error in errors))


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
        no_watermark = ModelCapability(
            model_id="plain",
            display_name="无水印参数",
            workflows=frozenset({Workflow.TEXT_TO_IMAGE}),
            supports_negative_prompt=True,
            min_images=1,
            max_images=2,
            size=SizeRule(auto_allowed=True, presets=((1024, 1024),)),
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
