from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
)

QT_CASE_PREFIX = """
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QListWidget

PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
)

from ugc_image_tool.presets import PresetProject, PresetStore, ProjectPreset
from ugc_image_tool.services import ApplicationServices
from ugc_image_tool.settings import MemoryCredentialService
from ugc_image_tool.ui.pages.generate import GeneratePage
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
            negative_prompt="测试负向",
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
page = GeneratePage(services)
page.resize(900, 640)
page.show()
app.processEvents()
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
from ugc_image_tool.ui.pages.generate import GeneratePage


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


def write_override(path, models):
    path.write_text(
        json.dumps({"schema_version": 2, "models": models}, ensure_ascii=False),
        encoding="utf-8",
    )


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


# 旗舰档同时支持文生图与图片编辑（图片编辑参考图 1～3 张、支持负向）。
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
            supports_negative_prompt=True,
            max_images=5,
            size={"auto_allowed": True, "presets": [[1024, 1024]]},
            reference_limits={"min_references": 1, "max_references": 3},
        ),
    ],
}

# 经济档只支持文生图：参考图区应被禁用。
ECON_MODEL = {
    "model_id": "econ-model",
    "display_name": "经济模型",
    "tier": "economy",
    "workflows": [tier_workflow("text_to_image")],
}


def make_services(data_dir, output_dir, models):
    override_path = data_dir / "override.json"
    data_dir.mkdir(parents=True, exist_ok=True)
    # 内置旗舰档占用 qwen-image-3.0-pro、经济档占用 qwen-image-3.0；
    # 测试条目接管档位前必须下架它们。
    unshelf_pro = {
        "model_id": "qwen-image-3.0-pro",
        "display_name": "Qwen Image 3.0",
        "workflows": [tier_workflow("text_to_image")],
    }
    unshelf_economy = {
        "model_id": "qwen-image-3.0",
        "display_name": "Qwen Image 3.0 经济版",
        "workflows": [tier_workflow("text_to_image")],
    }
    write_override(override_path, [unshelf_pro, unshelf_economy, *models])
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
page = GeneratePage(services)
page.resize(900, 640)
page.show()
app.processEvents()
"""

QT_TIER_SUFFIX = """
page.close()
services.close()
directory.cleanup()
app.closeAllWindows()
app.processEvents()
app.quit()
"""


class GeneratePageLayoutUiTests(unittest.TestCase):
    def run_qt_case(self, assertions: str) -> None:
        environment = os.environ.copy()
        environment["QT_QPA_PLATFORM"] = "offscreen"
        source_path = str(ROOT / "src")
        environment["PYTHONPATH"] = os.pathsep.join(
            filter(None, (source_path, environment.get("PYTHONPATH")))
        )
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(QT_CASE_PREFIX + assertions + QT_CASE_SUFFIX)],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_layout_uses_left_reference_splitter(self) -> None:
        self.run_qt_case(
            """
assert page._splitter.orientation() == Qt.Orientation.Horizontal
assert page._splitter.count() == 2
left_width, right_width = page._splitter.sizes()
assert 175 <= left_width <= 205, (left_width, right_width)
assert right_width > left_width
assert page._references.viewMode() == QListWidget.ViewMode.ListMode
"""
        )

    def test_negative_prompt_is_collapsed_and_capability_aware(self) -> None:
        self.run_qt_case(
            """
assert not page._negative_prompt_check.isChecked()
assert page._negative_prompt.isHidden()

page._negative_prompt_check.setChecked(True)
assert not page._negative_prompt.isHidden()

page.set_models(("qwen-image-3.0-pro",))
assert not page._negative_prompt_check.isHidden()
assert not page._negative_prompt.isHidden()

page.set_models(("unknown-model",))
assert page._negative_prompt_check.isHidden()
assert page._negative_prompt.isHidden()
"""
        )

    def test_unchecked_negative_prompt_is_kept_but_not_submitted(self) -> None:
        self.run_qt_case(
            """
captured = {}
page._application.submit_generate = lambda draft: captured.update(draft=draft)
page._negative_prompt.setPlainText("模糊，低清晰度")

page._negative_prompt_check.setChecked(True)
page._submit_generate()
assert captured["draft"].negative_prompt == "模糊，低清晰度"

page._negative_prompt_check.setChecked(False)
page._submit_generate()
assert captured["draft"].negative_prompt is None
assert page._negative_prompt.toPlainText() == "模糊，低清晰度"
"""
        )

    def test_negative_prompt_checked_state_is_restored_on_new_page(self) -> None:
        self.run_qt_case(
            """
page._negative_prompt_check.setChecked(True)
assert services.settings.generation_negative_prompt_enabled()

second = GeneratePage(services)
assert second._negative_prompt_check.isChecked()
second.close()

services.settings.save_generation_negative_prompt_enabled(False)
third = GeneratePage(services)
assert not third._negative_prompt_check.isChecked()
third.close()
"""
        )

    def test_submit_button_uses_shared_primary_style(self) -> None:
        self.run_qt_case(
            """
assert page._submit.objectName() == "submit"
assert page._submit.styleSheet() == SUBMIT_BUTTON_STYLE
"""
        )

    def test_apply_preset_fills_shared_prompt_state(self) -> None:
        """验收口径 #3：应用预设后正向/负向提示词被填充，带参考图（编辑任务）同样生效。"""
        self.run_qt_case(
            """
page.set_models(("qwen-image-3.0-pro",))
page._select_preset("builtin-test")
page._apply_selected_preset()
assert page._prompt.toPlainText() == "测试提示词"
assert page._negative_prompt.toPlainText() == "测试负向"
page._negative_prompt_check.setChecked(True)

ref = Path(root) / "ref.png"
ref.write_bytes(PNG_1X1)
page._add_reference_paths([str(ref)])
draft = page._read_draft()
assert len(draft.reference_paths) == 1
assert draft.prompt == "测试提示词"
assert draft.negative_prompt == "测试负向"
"""
        )


class GeneratePresetUiTests(unittest.TestCase):
    def run_qt_case(self, assertions: str) -> None:
        environment = os.environ.copy()
        environment["QT_QPA_PLATFORM"] = "offscreen"
        source_path = str(ROOT / "src")
        environment["PYTHONPATH"] = os.pathsep.join(
            filter(None, (source_path, environment.get("PYTHONPATH")))
        )
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(QT_CASE_PREFIX + assertions + QT_CASE_SUFFIX)],
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


class GenerateTierSwitchUiTests(unittest.TestCase):
    def run_qt_case(self, assertions: str) -> None:
        environment = os.environ.copy()
        environment["QT_QPA_PLATFORM"] = "offscreen"
        source_path = str(ROOT / "src")
        environment["PYTHONPATH"] = os.pathsep.join(
            filter(None, (source_path, environment.get("PYTHONPATH")))
        )
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(QT_TIER_PREFIX + assertions + QT_TIER_SUFFIX)],
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
page.set_models(("flag-model", "econ-model"))
flag = page._tier_switch._buttons[ModelTier.FLAGSHIP]
econ = page._tier_switch._buttons[ModelTier.ECONOMY]
assert flag.isVisibleTo(page._tier_switch) and flag.isEnabled()
assert econ.isVisibleTo(page._tier_switch) and econ.isEnabled()
assert flag.text() == "旗舰"
assert econ.text() == "经济"
assert not hasattr(page, "_model_combo")
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

second = GeneratePage(services)
second.set_models(("flag-model", "econ-model"))
assert second._current_model_id() == "econ-model"
second.close()
"""
        )

    def test_unresolvable_tier_is_disabled_with_reason_and_falls_back(self) -> None:
        self.run_qt_case(
            """
page.set_models(("flag-model", "econ-model"))
page._tier_switch._buttons[ModelTier.ECONOMY].click()

page.set_models(("flag-model",))
econ = page._tier_switch._buttons[ModelTier.ECONOMY]
assert econ.isVisibleTo(page._tier_switch)
assert not econ.isEnabled()
assert econ.toolTip(), "禁用分段必须给出原因"
assert page._current_model_id() == "flag-model"
# 记住的档位不被覆盖，经济档恢复后仍应回到经济档
assert services.settings.generation_tier() == ModelTier.ECONOMY
page.set_models(("flag-model", "econ-model"))
assert page._current_model_id() == "econ-model"
"""
        )

    def test_text_only_model_disables_reference_panel_with_reason(self) -> None:
        """验收口径 #2：当前模型不支持图片编辑时参考图区停用并说明原因。"""
        self.run_qt_case(
            """
page.set_models(("flag-model", "econ-model"))
page._tier_switch._buttons[ModelTier.ECONOMY].click()
assert page._current_model_id() == "econ-model"

assert not page._references.isEnabled()
assert not page._add_reference.isEnabled()
assert not page._reference_disabled.isHidden()
assert "不支持图片编辑" in page._reference_disabled.text()

page._tier_switch._buttons[ModelTier.FLAGSHIP].click()
assert page._references.isEnabled()
assert page._add_reference.isEnabled()
assert page._reference_disabled.isHidden()
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
assert page._validation.text(), "无可用档位时必须给出原因"
"""
        )


if __name__ == "__main__":
    unittest.main()
