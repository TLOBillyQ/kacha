from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

QT_CASE_PREFIX = """
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from ugc_image_tool.presets import PresetProject, PresetStore, ProjectPreset
from ugc_image_tool.services import ApplicationServices
from ugc_image_tool.settings import MemoryCredentialService
from ugc_image_tool.ui.pages.text_to_image import TextToImagePage
from ugc_image_tool.ui.presentation import SUBMIT_BUTTON_STYLE


class Gateway:
    def list_models(self):
        return ()

    def generate_text(self, request):
        raise AssertionError("UI 测试不应提交生成任务")

    def generate_image_edit(self, request):
        raise AssertionError("UI 测试不应提交编辑任务")

    def set_base_url(self, value):
        pass

    def set_api_key(self, value):
        pass

    def close(self):
        pass


app = QApplication([])
directory = TemporaryDirectory()
root = Path(directory.name)
preset_store = PresetStore(
    root / "user-data",
    builtins=(
        ProjectPreset(
            preset_id="builtin-test",
            display_name="测试内置预设",
            project=PresetProject.EGG_PARTY,
            prompt="测试提示词",
            read_only=True,
        ),
    ),
)
services = ApplicationServices(
    user_data_dir=root / "user-data",
    output_root=root / "output",
    gateway=Gateway(),
    credentials=MemoryCredentialService(),
    preset_store=preset_store,
)
page = TextToImagePage(services)
"""

QT_CASE_SUFFIX = """
page.close()
services.close()
directory.cleanup()
app.closeAllWindows()
app.processEvents()
app.quit()
"""

QT_TIER_PREFIX = """
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from ugc_image_tool.capabilities import CapabilityRegistry, ModelTier, Workflow
from ugc_image_tool.services import ApplicationServices
from ugc_image_tool.settings import MemoryCredentialService
from ugc_image_tool.ui.pages.text_to_image import TextToImagePage


class Gateway:
    def list_models(self):
        return ()

    def generate_text(self, request):
        raise AssertionError("UI 测试不应提交生成任务")

    def generate_image_edit(self, request):
        raise AssertionError("UI 测试不应提交编辑任务")

    def set_base_url(self, value):
        pass

    def set_api_key(self, value):
        pass

    def close(self):
        pass


def tier_workflow(workflow, **overrides):
    entry = {
        "workflow": workflow,
        "supports_negative_prompt": False,
        "min_images": 1,
        "max_images": 1,
        "size": {"auto_allowed": True, "presets": [[1024, 1024]]},
    }
    entry.update(overrides)
    return entry


def write_override(path, models):
    path.write_text(
        json.dumps({"schema_version": 2, "models": models}, ensure_ascii=False),
        encoding="utf-8",
    )


FLAG_MODEL = {
    "model_id": "flag-model",
    "display_name": "旗舰模型",
    "tier": "flagship",
    "workflows": [
        tier_workflow(
            "text_to_image",
            supports_negative_prompt=True,
            max_images=2,
            extra_params=["watermark"],
        ),
        tier_workflow(
            "image_edit",
            size={"auto_allowed": True, "presets": []},
            reference_limits={"min_references": 1, "max_references": 1},
        ),
    ],
}

ECON_MODEL = {
    "model_id": "econ-model",
    "display_name": "经济模型",
    "tier": "economy",
    "workflows": [tier_workflow("text_to_image")],
}


def make_services(data_dir, output_dir, models):
    override_path = data_dir / "override.json"
    data_dir.mkdir(parents=True, exist_ok=True)
    # 内置旗舰档占用 qwen-image-3.0-pro；测试条目接管档位前必须下架它
    unshelf_pro = {
        "model_id": "qwen-image-3.0-pro",
        "display_name": "Qwen Image 3.0",
        "workflows": [tier_workflow("text_to_image")],
    }
    write_override(override_path, [unshelf_pro, *models])
    return ApplicationServices(
        user_data_dir=data_dir,
        output_root=output_dir,
        gateway=Gateway(),
        credentials=MemoryCredentialService(),
        capabilities=CapabilityRegistry(override_path),
    )


app = QApplication([])
directory = TemporaryDirectory()
root = Path(directory.name)
services = make_services(root / "user-data", root / "output", [FLAG_MODEL, ECON_MODEL])
page = TextToImagePage(services)
"""

QT_TIER_SUFFIX = """
page.close()
services.close()
directory.cleanup()
app.closeAllWindows()
app.processEvents()
app.quit()
"""


class TextToImageUiTests(unittest.TestCase):
    def run_qt_case(self, assertions: str) -> None:
        environment = os.environ.copy()
        environment["QT_QPA_PLATFORM"] = "offscreen"
        source_path = str(ROOT / "src")
        environment["PYTHONPATH"] = os.pathsep.join(
            filter(None, (source_path, environment.get("PYTHONPATH")))
        )
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                textwrap.dedent(QT_CASE_PREFIX + assertions + QT_CASE_SUFFIX),
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_preset_actions_follow_selected_preset_context(self) -> None:
        self.run_qt_case(
            """
builtin = next(
    preset
    for presets in services.presets.grouped_presets().values()
    for preset in presets
    if preset.read_only
)
page._select_preset(builtin.preset_id)
assert not page._apply_preset.isHidden()
assert not page._copy_preset.isHidden()
assert page._edit_preset.isHidden()
assert page._delete_preset.isHidden()

personal = services.presets.copy_builtin_as_personal(
    builtin.preset_id,
    "测试个人预设",
)
page._populate_presets()
page._select_preset(personal.preset_id)
assert not page._apply_preset.isHidden()
assert page._copy_preset.isHidden()
assert not page._edit_preset.isHidden()
assert not page._delete_preset.isHidden()
"""
        )

    def test_negative_prompt_is_collapsed_and_capability_aware(self) -> None:
        self.run_qt_case(
            """
page.set_models(("qwen-image-3.0-pro",))
assert not page._negative_prompt_group.isHidden()
assert not page._negative_prompt_group.isChecked()
assert page._negative_prompt.isHidden()

page._negative_prompt_group.setChecked(True)
assert not page._negative_prompt.isHidden()

page.set_models(("unknown-model",))
assert page._negative_prompt_group.isHidden()
"""
        )

    def test_submit_button_uses_shared_primary_style(self) -> None:
        self.run_qt_case(
            """
assert page._submit.objectName() == "submit"
assert page._submit.styleSheet() == SUBMIT_BUTTON_STYLE
"""
        )


class TierSwitchUiTests(unittest.TestCase):
    """「旗舰 | 经济」分段开关：档位标签、解析、持久化与禁用原因。"""

    def run_qt_case(self, assertions: str) -> None:
        environment = os.environ.copy()
        environment["QT_QPA_PLATFORM"] = "offscreen"
        source_path = str(ROOT / "src")
        environment["PYTHONPATH"] = os.pathsep.join(
            filter(None, (source_path, environment.get("PYTHONPATH")))
        )
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                textwrap.dedent(QT_TIER_PREFIX + assertions + QT_TIER_SUFFIX),
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_switch_shows_tier_labels_instead_of_model_ids(self) -> None:
        self.run_qt_case(
            """
page.set_models(("flag-model", "econ-model", "unknown-model"))
flag = page._tier_switch._buttons[ModelTier.FLAGSHIP]
econ = page._tier_switch._buttons[ModelTier.ECONOMY]
assert flag.isVisibleTo(page._tier_switch) and flag.isEnabled()
assert econ.isVisibleTo(page._tier_switch) and econ.isEnabled()
assert flag.text() == "旗舰"
assert econ.text() == "经济"
# 网关发现的未上架模型（包括“未配置”）不出现在选择器里
assert not hasattr(page, "_model_combo")
for button in page._tier_switch._buttons.values():
    assert "未配置" not in button.text()
    assert "unknown-model" not in button.text()
"""
        )

    def test_tier_selection_fills_draft_with_resolved_model_id(self) -> None:
        self.run_qt_case(
            """
page.set_models(("flag-model", "econ-model"))
assert page._current_model_id() == "flag-model"

page._tier_switch._buttons[ModelTier.ECONOMY].click()

assert page._current_model_id() == "econ-model"
assert page._read_draft().model_id == "econ-model"
"""
        )

    def test_persisted_tier_is_restored_on_new_page(self) -> None:
        self.run_qt_case(
            """
page.set_models(("flag-model", "econ-model"))
page._tier_switch._buttons[ModelTier.ECONOMY].click()

second = TextToImagePage(services)
second.set_models(("flag-model", "econ-model"))

assert second._current_model_id() == "econ-model"
second.close()
"""
        )

    def test_selection_survives_model_swap_within_tier(self) -> None:
        self.run_qt_case(
            """
page.set_models(("flag-model", "econ-model"))
page._tier_switch._buttons[ModelTier.ECONOMY].click()

# 团队把经济档换成新模型：档位选择不变，用户无感
new_services = make_services(
    root / "user-data-swap",
    root / "output-swap",
    [{**ECON_MODEL, "model_id": "econ-model-2"}],
)
new_services.settings.save_selected_tier(Workflow.TEXT_TO_IMAGE, ModelTier.ECONOMY)
swapped = TextToImagePage(new_services)
swapped.set_models(("econ-model-2",))

assert swapped._current_model_id() == "econ-model-2"
swapped.close()
new_services.close()
"""
        )

    def test_unresolvable_tier_is_disabled_with_reason_and_falls_back(self) -> None:
        self.run_qt_case(
            """
page.set_models(("flag-model", "econ-model"))
page._tier_switch._buttons[ModelTier.ECONOMY].click()

# 网关发现结果中没有经济档模型：分段禁用并给出原因，选择回退旗舰档
page.set_models(("flag-model",))

econ = page._tier_switch._buttons[ModelTier.ECONOMY]
assert econ.isVisibleTo(page._tier_switch)
assert not econ.isEnabled()
assert econ.toolTip(), "禁用分段必须给出原因"
assert page._current_model_id() == "flag-model"
# 记住的档位不被覆盖，经济档恢复后仍应回到经济档
assert services.settings.selected_tier(Workflow.TEXT_TO_IMAGE) == ModelTier.ECONOMY
page.set_models(("flag-model", "econ-model"))
assert page._current_model_id() == "econ-model"
"""
        )

    def test_empty_gateway_list_disables_all_segments_and_submit(self) -> None:
        self.run_qt_case(
            """
page.set_models(())
for button in page._tier_switch._buttons.values():
    assert not button.isEnabled()
assert page._current_model_id() is None
assert not page._submit.isEnabled()
assert page._validation_label.text(), "无可用档位时必须给出原因"
"""
        )


if __name__ == "__main__":
    unittest.main()
