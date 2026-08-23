from __future__ import annotations

import unittest

from ugc_image_tool.capabilities import (
    CAPABILITY_TABLE_VERSION,
    BUILTIN_CAPABILITIES,
    CapabilityRegistry,
    ModelTier,
    ReferenceLimits,
    SizeRule,
    Workflow,
)


class BuiltinCapabilityTableTests(unittest.TestCase):
    def test_table_has_stable_version_identifier(self) -> None:
        self.assertIsInstance(CAPABILITY_TABLE_VERSION, str)
        self.assertTrue(CAPABILITY_TABLE_VERSION.strip())

    def test_qwen_image_3_0_pro_registers_both_workflows(self) -> None:
        capability = BUILTIN_CAPABILITIES["qwen-image-3.0-pro"]

        self.assertEqual("Qwen Image 3.0", capability.display_name)
        self.assertEqual(
            frozenset({Workflow.TEXT_TO_IMAGE, Workflow.IMAGE_EDIT}),
            capability.workflows,
        )

    def test_qwen_text_to_image_capability_matches_verified_contract(self) -> None:
        text = BUILTIN_CAPABILITIES["qwen-image-3.0-pro"].for_workflow(
            Workflow.TEXT_TO_IMAGE
        )

        self.assertIsNotNone(text)
        assert text is not None
        self.assertEqual(Workflow.TEXT_TO_IMAGE, text.workflow)
        self.assertTrue(text.supports_negative_prompt)
        self.assertEqual((1, 2), (text.min_images, text.max_images))
        self.assertIn("watermark", text.extra_params)
        self.assertTrue(text.size.auto_allowed)
        self.assertTrue(text.size.custom_size_allowed)
        self.assertEqual(ReferenceLimits(0, 0), text.reference_limits)

    def test_qwen_text_to_image_size_rule_matches_verified_constraints(self) -> None:
        size = (
            BUILTIN_CAPABILITIES["qwen-image-3.0-pro"]
            .for_workflow(Workflow.TEXT_TO_IMAGE)
            .size  # type: ignore[union-attr]
        )

        self.assertEqual(
            ((1024, 1024), (2048, 2048), (1920, 1080), (1080, 1920)),
            size.presets,
        )
        self.assertEqual(262_144, size.min_total_pixels)
        self.assertEqual(4_194_304, size.max_total_pixels)
        self.assertEqual(1 / 8, size.min_aspect_ratio)
        self.assertEqual(8.0, size.max_aspect_ratio)

    def test_qwen_image_edit_capability(self) -> None:
        edit = BUILTIN_CAPABILITIES["qwen-image-3.0-pro"].for_workflow(
            Workflow.IMAGE_EDIT
        )

        self.assertIsNotNone(edit)
        assert edit is not None
        self.assertEqual(Workflow.IMAGE_EDIT, edit.workflow)
        # 已实测契约：单张出图、仅模型自动决定尺寸、1 张参考图；
        # 负向提示词按文生图同名字段开放试用，尚无编辑场景实测夹具。
        self.assertTrue(edit.supports_negative_prompt)
        self.assertEqual((1, 1), (edit.min_images, edit.max_images))
        self.assertEqual((), edit.extra_params)
        self.assertTrue(edit.size.auto_allowed)
        self.assertEqual((), edit.size.presets)
        self.assertFalse(edit.size.custom_size_allowed)
        self.assertEqual(ReferenceLimits(1, 1), edit.reference_limits)

    def test_workflow_capabilities_are_immutable(self) -> None:
        text = BUILTIN_CAPABILITIES["qwen-image-3.0-pro"].for_workflow(
            Workflow.TEXT_TO_IMAGE
        )
        assert text is not None

        with self.assertRaises(AttributeError):
            text.min_images = 5  # type: ignore[misc]
        with self.assertRaises(AttributeError):
            text.size.presets = ((512, 512),)  # type: ignore[misc]

    def test_unknown_model_has_no_builtin_capability(self) -> None:
        self.assertNotIn("wan2.7-image", BUILTIN_CAPABILITIES)
        self.assertNotIn("z-image-turbo", BUILTIN_CAPABILITIES)


class ModelTierShelfTests(unittest.TestCase):
    """档位是上架清单的表达：有 tier 的条目上架，无 tier 的保持隐藏。"""

    def test_tiers_are_fixed_to_flagship_and_economy_with_labels(self) -> None:
        self.assertEqual("flagship", ModelTier.FLAGSHIP.value)
        self.assertEqual("economy", ModelTier.ECONOMY.value)
        self.assertEqual("旗舰", ModelTier.FLAGSHIP.label)
        self.assertEqual("经济", ModelTier.ECONOMY.label)

    def test_qwen_image_3_0_pro_is_shelved_as_flagship(self) -> None:
        self.assertEqual(
            ModelTier.FLAGSHIP,
            BUILTIN_CAPABILITIES["qwen-image-3.0-pro"].tier,
        )

    def test_builtin_table_has_at_most_one_model_per_tier_and_workflow(self) -> None:
        seen: set[tuple[ModelTier, Workflow]] = set()
        for capability in BUILTIN_CAPABILITIES.values():
            if capability.tier is None:
                continue
            for workflow in capability.workflows:
                key = (capability.tier, workflow)
                self.assertNotIn(
                    key,
                    seen,
                    f"内置能力表同档位同工作流冲突：{capability.tier}/{workflow}",
                )
                seen.add(key)

    def test_resolve_tier_returns_shelved_model_for_workflow(self) -> None:
        registry = CapabilityRegistry()

        flagship = registry.resolve_tier(Workflow.TEXT_TO_IMAGE, ModelTier.FLAGSHIP)

        self.assertIsNotNone(flagship)
        assert flagship is not None
        self.assertEqual("qwen-image-3.0-pro", flagship.model_id)

    def test_resolve_tier_returns_none_when_tier_not_shelved(self) -> None:
        registry = CapabilityRegistry()

        self.assertIsNone(registry.resolve_tier(Workflow.TEXT_TO_IMAGE, ModelTier.ECONOMY))

    def test_shelved_tiers_lists_only_tiers_available_for_workflow(self) -> None:
        registry = CapabilityRegistry()

        tiers = registry.shelved_tiers(Workflow.TEXT_TO_IMAGE)

        self.assertEqual((ModelTier.FLAGSHIP,), tiers)


class SizeRuleCustomFlagTests(unittest.TestCase):
    def test_custom_size_allowed_defaults_to_true(self) -> None:
        rule = SizeRule(auto_allowed=True, presets=((1024, 1024),))
        self.assertTrue(rule.custom_size_allowed)


class CapabilityRegistryMergeTests(unittest.TestCase):
    GATEWAY_MODELS = [
        "qwen-image-3.0-pro",
        "wan2.7-image",
        "z-image-turbo",
    ]

    def test_merges_gateway_models_with_capability_by_model_id(self) -> None:
        registry = CapabilityRegistry()

        merged = registry.merge(self.GATEWAY_MODELS)

        self.assertEqual(3, len(merged))
        self.assertEqual("qwen-image-3.0-pro", merged[0].model_id)
        self.assertIsNotNone(merged[0].capability)
        self.assertEqual(merged[0].capability, registry.capability("qwen-image-3.0-pro"))

    def test_unknown_gateway_model_is_marked_unconfigured(self) -> None:
        merged = CapabilityRegistry().merge(self.GATEWAY_MODELS)

        by_id = {entry.model_id: entry for entry in merged}
        self.assertIsNone(by_id["wan2.7-image"].capability)
        self.assertIsNone(by_id["z-image-turbo"].capability)
        self.assertIsNone(CapabilityRegistry().capability("wan2.7-image"))

    def test_merge_preserves_gateway_order(self) -> None:
        merged = CapabilityRegistry().merge(reversed(self.GATEWAY_MODELS))
        self.assertEqual(list(reversed(self.GATEWAY_MODELS)), [m.model_id for m in merged])

    def test_workflow_filter_keeps_only_supporting_models(self) -> None:
        text_to_image = CapabilityRegistry().for_workflow(Workflow.TEXT_TO_IMAGE)
        image_edit = CapabilityRegistry().for_workflow(Workflow.IMAGE_EDIT)

        self.assertEqual(["qwen-image-3.0-pro"], [m.model_id for m in text_to_image])
        self.assertEqual(["qwen-image-3.0-pro"], [m.model_id for m in image_edit])

    def test_workflow_capability_lookup_resolves_per_workflow(self) -> None:
        registry = CapabilityRegistry()

        text = registry.workflow_capability(
            "qwen-image-3.0-pro", Workflow.TEXT_TO_IMAGE
        )
        edit = registry.workflow_capability(
            "qwen-image-3.0-pro", Workflow.IMAGE_EDIT
        )

        self.assertIsNotNone(text)
        self.assertIsNotNone(edit)
        assert text is not None and edit is not None
        self.assertEqual(2, text.max_images)
        self.assertEqual(1, edit.max_images)
        self.assertNotEqual(text, edit)
        self.assertIsNone(registry.workflow_capability("wan2.7-image", Workflow.TEXT_TO_IMAGE))

    def test_capability_version_is_stable(self) -> None:
        self.assertEqual(CAPABILITY_TABLE_VERSION, CapabilityRegistry().version)


if __name__ == "__main__":
    unittest.main()
