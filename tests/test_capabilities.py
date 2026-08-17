from __future__ import annotations

import unittest

from ugc_image_tool.capabilities import (
    CAPABILITY_TABLE_VERSION,
    BUILTIN_CAPABILITIES,
    CapabilityRegistry,
    SizeRule,
    Workflow,
)


class BuiltinCapabilityTableTests(unittest.TestCase):
    def test_table_has_stable_version_identifier(self) -> None:
        self.assertIsInstance(CAPABILITY_TABLE_VERSION, str)
        self.assertTrue(CAPABILITY_TABLE_VERSION.strip())

    def test_qwen_image_3_0_pro_is_configured_from_verified_contract(self) -> None:
        capability = BUILTIN_CAPABILITIES["qwen-image-3.0-pro"]

        self.assertEqual("Qwen Image 3.0", capability.display_name)
        self.assertEqual(
            frozenset({Workflow.TEXT_TO_IMAGE, Workflow.IMAGE_EDIT}),
            capability.workflows,
        )
        self.assertTrue(capability.supports_negative_prompt)
        self.assertEqual((1, 2), (capability.min_images, capability.max_images))
        self.assertIn("watermark", capability.extra_params)

    def test_qwen_image_3_0_size_rule_matches_verified_constraints(self) -> None:
        size = BUILTIN_CAPABILITIES["qwen-image-3.0-pro"].size

        self.assertTrue(size.auto_allowed)
        self.assertEqual(
            ((1024, 1024), (2048, 2048), (1920, 1080), (1080, 1920)),
            size.presets,
        )
        self.assertEqual(262_144, size.min_total_pixels)
        self.assertEqual(4_194_304, size.max_total_pixels)
        self.assertEqual(1 / 8, size.min_aspect_ratio)
        self.assertEqual(8.0, size.max_aspect_ratio)

    def test_size_rule_is_immutable(self) -> None:
        size = BUILTIN_CAPABILITIES["qwen-image-3.0-pro"].size

        with self.assertRaises(AttributeError):
            size.presets = ((512, 512),)  # type: ignore[misc]

    def test_unknown_model_has_no_builtin_capability(self) -> None:
        self.assertNotIn("wan2.7-image", BUILTIN_CAPABILITIES)
        self.assertNotIn("z-image-turbo", BUILTIN_CAPABILITIES)


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

    def test_capability_version_is_stable(self) -> None:
        self.assertEqual(CAPABILITY_TABLE_VERSION, CapabilityRegistry().version)


if __name__ == "__main__":
    unittest.main()
