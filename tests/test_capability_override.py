from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from ugc_image_tool.capabilities import (
    BUILTIN_CAPABILITIES,
    CapabilityOverrideError,
    CapabilityRegistry,
    ModelCapability,
    ModelTier,
    ReferenceLimits,
    SizeRule,
    Workflow,
    WorkflowCapability,
    enforce_special_constraints,
    load_override_file,
)

TEXT_SIZE_RULE = {
    "auto_allowed": True,
    "presets": [[1024, 1024]],
    "min_total_pixels": 262144,
    "max_total_pixels": 4194304,
    "min_aspect_ratio": 0.125,
    "max_aspect_ratio": 8.0,
}

EDIT_SIZE_RULE = {
    "auto_allowed": True,
    "presets": [],
    "custom_size_allowed": False,
}


def workflow_entry(workflow: str, **overrides) -> dict:
    """构造单工作流覆盖条目；默认约束与内置编辑契约一致。"""
    entry = {
        "workflow": workflow,
        "supports_negative_prompt": False,
        "min_images": 1,
        "max_images": 1,
        "size": {"auto_allowed": True, "presets": [[1024, 1024]], "custom_size_allowed": True},
    }
    entry.update(overrides)
    return entry


QWEN_ENTRY = {
    "model_id": "qwen-image-3.0-pro",
    "display_name": "团队实测版 Qwen Image 3.0",
    "workflows": [
        workflow_entry(
            "text_to_image",
            supports_negative_prompt=True,
            min_images=1,
            max_images=4,
            size=TEXT_SIZE_RULE,
            extra_params=["watermark"],
        ),
        workflow_entry(
            "image_edit",
            size=EDIT_SIZE_RULE,
            reference_limits={"min_references": 1, "max_references": 1},
        ),
    ],
}

Z_IMAGE_TURBO_ENTRY = {
    "model_id": "z-image-turbo",
    "display_name": "快速写实文生图",
    "workflows": [workflow_entry("text_to_image")],
}


def write_override(directory: str, models: list[dict], schema_version: int = 2) -> Path:
    path = Path(directory) / "override.json"
    path.write_text(
        json.dumps({"schema_version": schema_version, "models": models}, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def reasons_for(models: list[dict], schema_version: int = 2) -> list[str]:
    with TemporaryDirectory() as directory:
        try:
            load_override_file(write_override(directory, models, schema_version))
        except CapabilityOverrideError as error:
            return error.reasons
    raise AssertionError("预期覆盖文件被拒绝，但加载成功")


class OverrideLoadTests(unittest.TestCase):
    def test_valid_override_replaces_builtin_entry_by_model_id(self) -> None:
        with TemporaryDirectory() as directory:
            path = write_override(directory, [QWEN_ENTRY])

            table = load_override_file(path)

            self.assertIn("qwen-image-3.0-pro", table)
            capability = table["qwen-image-3.0-pro"]
            self.assertEqual("团队实测版 Qwen Image 3.0", capability.display_name)
            text = capability.for_workflow(Workflow.TEXT_TO_IMAGE)
            edit = capability.for_workflow(Workflow.IMAGE_EDIT)
            self.assertIsNotNone(text)
            self.assertIsNotNone(edit)
            assert text is not None and edit is not None
            self.assertEqual(4, text.max_images)
            self.assertEqual(1, edit.max_images)
            self.assertEqual(ReferenceLimits(1, 1), edit.reference_limits)
            self.assertIsNot(capability, BUILTIN_CAPABILITIES["qwen-image-3.0-pro"])

    def test_override_adds_new_model(self) -> None:
        with TemporaryDirectory() as directory:
            table = load_override_file(write_override(directory, [Z_IMAGE_TURBO_ENTRY]))

        self.assertEqual(
            {Workflow.TEXT_TO_IMAGE},
            table["z-image-turbo"].workflows,
        )
        self.assertEqual("快速写实文生图", table["z-image-turbo"].display_name)

    def test_override_takes_precedence_in_registry(self) -> None:
        with TemporaryDirectory() as directory:
            registry = CapabilityRegistry(write_override(directory, [QWEN_ENTRY]))

        text = registry.workflow_capability(
            "qwen-image-3.0-pro", Workflow.TEXT_TO_IMAGE
        )
        self.assertIsNotNone(text)
        assert text is not None
        self.assertEqual(4, text.max_images)

    def test_override_workflow_lookup_reflects_edit_contract(self) -> None:
        with TemporaryDirectory() as directory:
            registry = CapabilityRegistry(write_override(directory, [QWEN_ENTRY]))

        edit = registry.workflow_capability(
            "qwen-image-3.0-pro", Workflow.IMAGE_EDIT
        )
        self.assertIsNotNone(edit)
        assert edit is not None
        self.assertFalse(edit.supports_negative_prompt)
        self.assertEqual((1, 1), (edit.min_images, edit.max_images))
        self.assertTrue(edit.size.auto_allowed)
        self.assertEqual((), edit.size.presets)
        self.assertFalse(edit.size.custom_size_allowed)
        self.assertEqual(ReferenceLimits(1, 1), edit.reference_limits)

    def test_missing_file_is_rejected_with_reason(self) -> None:
        with self.assertRaises(CapabilityOverrideError) as raised:
            load_override_file(Path("不存在的目录") / "override.json")
        self.assertTrue(any("override.json" in reason for reason in raised.exception.reasons))

    def test_invalid_json_is_rejected_with_reason(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "override.json"
            path.write_text("{broken json", encoding="utf-8")

            with self.assertRaises(CapabilityOverrideError) as raised:
                load_override_file(path)

        self.assertTrue(any("JSON" in reason for reason in raised.exception.reasons))


class OverrideValidationTests(unittest.TestCase):
    def test_whole_file_rejected_on_schema_version_error(self) -> None:
        with TemporaryDirectory() as directory:
            path = write_override(directory, [QWEN_ENTRY], schema_version=1)

            with self.assertRaises(CapabilityOverrideError) as raised:
                load_override_file(path)

        self.assertTrue(any("schema_version" in reason for reason in raised.exception.reasons))

    def test_whole_file_rejected_on_empty_models(self) -> None:
        reasons = reasons_for([])
        self.assertTrue(reasons)

    def test_whole_file_rejected_on_duplicate_model_id(self) -> None:
        reasons = reasons_for([QWEN_ENTRY, QWEN_ENTRY])
        self.assertTrue(any("重复" in reason for reason in reasons))

    def test_whole_file_rejected_on_duplicate_workflow(self) -> None:
        edit = list(QWEN_ENTRY["workflows"])[1]
        entry = {**QWEN_ENTRY, "workflows": [edit, edit]}
        reasons = reasons_for([entry])
        self.assertTrue(any("重复" in reason for reason in reasons))

    def test_whole_file_rejected_on_unknown_workflow(self) -> None:
        entry = dict(QWEN_ENTRY, workflows=[workflow_entry("video")])
        reasons = reasons_for([entry])
        self.assertTrue(any("video" in reason for reason in reasons))

    def test_whole_file_rejected_when_image_range_inverted(self) -> None:
        entry = {
            **QWEN_ENTRY,
            "workflows": [workflow_entry("text_to_image", min_images=3, max_images=1)],
        }
        reasons = reasons_for([entry])
        self.assertTrue(any("出图数量" in reason for reason in reasons))

    def test_whole_file_rejected_on_non_bool_negative_prompt(self) -> None:
        entry = {
            **QWEN_ENTRY,
            "workflows": [
                workflow_entry("text_to_image", supports_negative_prompt="yes"),
            ],
        }
        reasons = reasons_for([entry])
        self.assertTrue(any("supports_negative_prompt" in reason for reason in reasons))

    def test_whole_file_rejected_on_invalid_reference_limits(self) -> None:
        entry = {
            **QWEN_ENTRY,
            "workflows": [
                workflow_entry(
                    "image_edit",
                    reference_limits={"min_references": 3, "max_references": 1},
                ),
            ],
        }
        reasons = reasons_for([entry])
        self.assertTrue(any("参考图" in reason for reason in reasons))

    def test_whole_file_rejected_when_preset_violates_size_rule(self) -> None:
        entry = {
            **QWEN_ENTRY,
            "workflows": [
                workflow_entry(
                    "text_to_image",
                    size={**TEXT_SIZE_RULE, "presets": [[1024, 1024], [9000, 9000]]},
                ),
            ],
        }
        reasons = reasons_for([entry])
        self.assertTrue(any("预设" in reason or "9000" in reason for reason in reasons))

    def test_whole_file_rejected_on_invalid_custom_size_bounds(self) -> None:
        entry = {
            **QWEN_ENTRY,
            "workflows": [
                workflow_entry(
                    "text_to_image",
                    size={**TEXT_SIZE_RULE, "min_total_pixels": 4194304, "max_total_pixels": 262144},
                ),
            ],
        }
        reasons = reasons_for([entry])
        self.assertTrue(reasons)

    def test_one_invalid_workflow_rejects_whole_file(self) -> None:
        text = list(QWEN_ENTRY["workflows"])[0]
        entry = {
            **QWEN_ENTRY,
            "workflows": [
                text,
                workflow_entry(
                    "image_edit",
                    min_images=0,
                    max_images=0,
                    reference_limits={"min_references": 2, "max_references": 1},
                ),
            ],
        }
        reasons = reasons_for([entry])
        self.assertTrue(any("出图数量" in reason for reason in reasons))
        self.assertTrue(any("参考图" in reason for reason in reasons))

    def test_errors_list_all_reasons_in_whole_file(self) -> None:
        entry = {
            **QWEN_ENTRY,
            "display_name": "",
            "workflows": [workflow_entry("text_to_image", min_images=3, max_images=1)],
        }
        reasons = reasons_for([entry])
        self.assertGreaterEqual(len(reasons), 2)


class OverrideTierTests(unittest.TestCase):
    def test_entry_without_tier_stays_unshelved(self) -> None:
        with TemporaryDirectory() as directory:
            table = load_override_file(write_override(directory, [Z_IMAGE_TURBO_ENTRY]))

        self.assertIsNone(table["z-image-turbo"].tier)

    def test_entry_with_tier_is_shelved(self) -> None:
        entry = {**Z_IMAGE_TURBO_ENTRY, "tier": "economy"}
        with TemporaryDirectory() as directory:
            registry = CapabilityRegistry(write_override(directory, [entry]))

        shelved = registry.resolve_tier(Workflow.TEXT_TO_IMAGE, ModelTier.ECONOMY)
        self.assertIsNotNone(shelved)
        assert shelved is not None
        self.assertEqual("z-image-turbo", shelved.model_id)

    def test_invalid_tier_value_rejects_whole_file(self) -> None:
        entry = {**Z_IMAGE_TURBO_ENTRY, "tier": "premium"}
        reasons = reasons_for([entry])
        self.assertTrue(any("tier" in reason for reason in reasons))

    def test_non_string_tier_rejects_whole_file(self) -> None:
        entry = {**Z_IMAGE_TURBO_ENTRY, "tier": 1}
        reasons = reasons_for([entry])
        self.assertTrue(any("tier" in reason for reason in reasons))

    def test_same_tier_and_workflow_conflict_rejects_whole_override(self) -> None:
        challenger = {
            "model_id": "qwen-image-challenger",
            "display_name": "挑战者",
            "tier": "flagship",
            "workflows": [workflow_entry("text_to_image")],
        }
        with TemporaryDirectory() as directory:
            path = write_override(directory, [challenger])

            with self.assertRaises(CapabilityOverrideError) as raised:
                CapabilityRegistry(path)

        self.assertTrue(any("旗舰" in reason or "flagship" in reason for reason in raised.exception.reasons))

    def test_same_tier_different_workflows_is_allowed(self) -> None:
        text_only = {
            "model_id": "text-model",
            "display_name": "文生图模型",
            "tier": "economy",
            "workflows": [workflow_entry("text_to_image")],
        }
        edit_only = {
            "model_id": "edit-model",
            "display_name": "编辑模型",
            "tier": "economy",
            "workflows": [workflow_entry("image_edit")],
        }
        with TemporaryDirectory() as directory:
            registry = CapabilityRegistry(write_override(directory, [text_only, edit_only]))

        self.assertEqual(
            "text-model",
            registry.resolve_tier(Workflow.TEXT_TO_IMAGE, ModelTier.ECONOMY).model_id,  # type: ignore[union-attr]
        )
        self.assertEqual(
            "edit-model",
            registry.resolve_tier(Workflow.IMAGE_EDIT, ModelTier.ECONOMY).model_id,  # type: ignore[union-attr]
        )

    def test_override_can_unshelf_builtin_model_by_omitting_tier(self) -> None:
        with TemporaryDirectory() as directory:
            registry = CapabilityRegistry(write_override(directory, [QWEN_ENTRY]))

        self.assertIsNone(registry.resolve_tier(Workflow.TEXT_TO_IMAGE, ModelTier.FLAGSHIP))
        self.assertEqual((), registry.shelved_tiers(Workflow.IMAGE_EDIT))

    def test_shelved_tiers_follows_flagship_then_economy_order(self) -> None:
        flagship = {**Z_IMAGE_TURBO_ENTRY, "tier": "flagship"}
        economy = {
            "model_id": "economy-model",
            "display_name": "经济模型",
            "tier": "economy",
            "workflows": [workflow_entry("text_to_image")],
        }
        unshelf_pro = {**QWEN_ENTRY}  # 不带 tier，下架内置旗舰避免冲突
        with TemporaryDirectory() as directory:
            registry = CapabilityRegistry(
                write_override(directory, [unshelf_pro, flagship, economy])
            )

        self.assertEqual(
            (ModelTier.FLAGSHIP, ModelTier.ECONOMY),
            registry.shelved_tiers(Workflow.TEXT_TO_IMAGE),
        )


class ZImageTurboConstraintTests(unittest.TestCase):
    def test_override_with_image_edit_workflow_is_rejected(self) -> None:
        entry = {
            **Z_IMAGE_TURBO_ENTRY,
            "workflows": [workflow_entry("text_to_image"), workflow_entry("image_edit")],
        }
        reasons = reasons_for([entry])
        self.assertTrue(any("快速写实文生图" in reason for reason in reasons))
        self.assertTrue(any("图片编辑" in reason for reason in reasons))

    def test_override_with_wrong_display_name_is_rejected(self) -> None:
        entry = dict(Z_IMAGE_TURBO_ENTRY, display_name="全能图像模型")
        reasons = reasons_for([entry])
        self.assertTrue(any("快速写实文生图" in reason for reason in reasons))

    def test_valid_entry_merges_into_registry(self) -> None:
        with TemporaryDirectory() as directory:
            registry = CapabilityRegistry(write_override(directory, [Z_IMAGE_TURBO_ENTRY]))

        capability = registry.capability("z-image-turbo")
        self.assertIsNotNone(capability)
        self.assertEqual("快速写实文生图", capability.display_name)  # type: ignore[union-attr]
        text_models = registry.for_workflow(Workflow.TEXT_TO_IMAGE)
        self.assertEqual(
            frozenset({Workflow.TEXT_TO_IMAGE}),
            text_models[-1].workflows,
        )

    def test_override_version_identifies_applied_table(self) -> None:
        with TemporaryDirectory() as directory:
            path = write_override(directory, [Z_IMAGE_TURBO_ENTRY])
            registry = CapabilityRegistry(path)
            first_version = registry.version
            path.write_text(
                json.dumps(
                    {
                        "schema_version": 2,
                        "models": [
                            {
                                **Z_IMAGE_TURBO_ENTRY,
                                "workflows": [
                                    workflow_entry("text_to_image", supports_negative_prompt=True)
                                ],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            changed_version = CapabilityRegistry(path).version

        self.assertTrue(first_version.startswith("capabilities-v1+override-"))
        self.assertNotEqual(first_version, changed_version)


class SpecialConstraintEnforcementTests(unittest.TestCase):
    def test_enforcement_normalizes_z_image_turbo_from_any_entry(self) -> None:
        wayward = ModelCapability(
            model_id="z-image-turbo",
            display_name="全能图像模型",
            workflow_capabilities=(
                WorkflowCapability(
                    workflow=Workflow.TEXT_TO_IMAGE,
                    supports_negative_prompt=False,
                    min_images=1,
                    max_images=1,
                    size=SizeRule(auto_allowed=True, presets=((1024, 1024),)),
                    reference_limits=ReferenceLimits(min_references=0, max_references=0),
                ),
                WorkflowCapability(
                    workflow=Workflow.IMAGE_EDIT,
                    supports_negative_prompt=False,
                    min_images=1,
                    max_images=1,
                    size=SizeRule(auto_allowed=True, presets=()),
                    reference_limits=ReferenceLimits(min_references=1, max_references=1),
                ),
            ),
        )

        enforced = enforce_special_constraints(wayward)

        self.assertEqual("快速写实文生图", enforced.display_name)
        self.assertEqual(frozenset({Workflow.TEXT_TO_IMAGE}), enforced.workflows)

    def test_registry_never_exposes_z_image_turbo_in_image_edit(self) -> None:
        registry = CapabilityRegistry()

        self.assertNotIn(
            "z-image-turbo",
            [m.model_id for m in registry.for_workflow(Workflow.IMAGE_EDIT)],
        )


if __name__ == "__main__":
    unittest.main()
