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

from PySide6.QtCore import QModelIndex, Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QLabel, QToolButton

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
        ProjectPreset(
            preset_id="builtin-second",
            display_name="第二个内置预设",
            project=PresetProject.THOUSAND_STARS,
            prompt="不应默认应用",
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

    def test_layout_prioritizes_prompt_and_uses_native_disclosures(self) -> None:
        self.run_qt_case(
            """
assert page._splitter.orientation() == Qt.Orientation.Horizontal
assert page._splitter.count() == 2
main_width, sidebar_width = page._splitter.sizes()
assert main_width > sidebar_width
assert page._prompt.placeholderText() == "描述画面、角色、风格与构图……"
assert page._generation_panel.title() == "本次生成"
for section in (page._reference_section, page._negative_section, page._count_section):
    assert isinstance(section.toggle, QToolButton)
    assert section.toggle.isCheckable()
    assert section.toggle.styleSheet() == "QToolButton { border: none; }"
    assert section.toggle.arrowType() == Qt.ArrowType.RightArrow
    assert section.content.isHidden()
"""
        )

    def test_negative_prompt_is_collapsed_and_capability_aware(self) -> None:
        self.run_qt_case(
            """
assert not page._negative_section.toggle.isChecked()
assert page._negative_section.content.isHidden()

page._negative_section.toggle.setChecked(True)
assert not page._negative_section.content.isHidden()

page.set_models(("qwen-image-3.0-pro",))
assert not page._negative_section.isHidden()
assert not page._negative_section.content.isHidden()

page.set_models(("unknown-model",))
assert page._negative_section.isHidden()
"""
        )

    def test_unchecked_negative_prompt_is_kept_but_not_submitted(self) -> None:
        self.run_qt_case(
            """
captured = {}
page._application.submit_generate = lambda draft: captured.update(draft=draft)
page._negative_prompt.setPlainText("模糊，低清晰度")

page._negative_section.toggle.setChecked(True)
page._submit_generate()
assert captured["draft"].negative_prompt == "模糊，低清晰度"

page._negative_section.toggle.setChecked(False)
page._submit_generate()
assert captured["draft"].negative_prompt is None
assert page._negative_prompt.toPlainText() == "模糊，低清晰度"
"""
        )

    def test_negative_prompt_checked_state_is_restored_on_new_page(self) -> None:
        self.run_qt_case(
            """
page._negative_section.toggle.setChecked(True)
assert services.settings.generation_negative_prompt_enabled()

second = GeneratePage(services)
assert second._negative_section.toggle.isChecked()
second.close()

services.settings.save_generation_negative_prompt_enabled(False)
third = GeneratePage(services)
assert not third._negative_section.toggle.isChecked()
third.close()
"""
        )

    def test_references_can_be_reordered_removed_and_collapse_when_empty(self) -> None:
        self.run_qt_case(
            """
page.set_models(("qwen-image-3.0-pro",))
paths = []
for name in ("first.png", "second.png", "third.png"):
    path = Path(root) / name
    path.write_bytes(PNG_1X1)
    paths.append(str(path))

page._add_reference_paths(paths)
assert page._reference_section.is_expanded()
assert page._references.count() == 3
assert page._references.model().moveRow(QModelIndex(), 2, QModelIndex(), 0)
assert [page._references.item(index).text() for index in range(3)] == [
    "1. third.png",
    "2. first.png",
    "3. second.png",
]

for _ in range(3):
    page._references.setCurrentRow(0)
    page._remove_reference.click()

assert page._references.count() == 0
assert not page._reference_section.is_expanded()
assert not services.settings.generation_reference_expanded()
assert page._warnings.text() == ""
"""
        )

    def test_selected_reference_can_be_removed_with_delete_key(self) -> None:
        self.run_qt_case(
            """
page.set_models(("qwen-image-3.0-pro",))
paths = []
for name in ("first.png", "second.png"):
    path = Path(root) / name
    path.write_bytes(PNG_1X1)
    paths.append(str(path))

page._add_reference_paths(paths)
page._references.setCurrentRow(0)
page._references.setFocus()
QTest.keyClick(page._references, Qt.Key.Key_Delete)

assert page._references.count() == 1
assert page._references.item(0).text() == "1. second.png"
"""
        )

    def test_reference_overflow_is_kept_with_clear_feedback(self) -> None:
        self.run_qt_case(
            """
page.set_models(("qwen-image-3.0-pro",))
paths = []
for name in ("one.png", "two.png", "three.png", "four.png"):
    path = Path(root) / name
    path.write_bytes(PNG_1X1)
    paths.append(str(path))

page._add_reference_paths(paths)

assert page._references.count() == 3
assert "最多 3 张" in page._reference_hint.text()
assert page._reference_hint.isVisible()
"""
        )

    def test_empty_reference_panel_stays_open_when_add_is_cancelled(self) -> None:
        self.run_qt_case(
            """
page._reference_section.toggle.setChecked(True)
page._add_reference_paths([])

assert page._reference_section.is_expanded()
assert services.settings.generation_reference_expanded()
assert page._add_reference.text() == "＋ 添加参考图（可选，最多 3 张）"
assert any(
    label.text() == "拖放 PNG / JPEG 到这里；添加的参考图将用于图片编辑生成"
    for label in page._reference_section.content.findChildren(QLabel)
)
"""
        )

    def test_reference_expansion_is_restored_on_new_page(self) -> None:
        self.run_qt_case(
            """
page._reference_section.toggle.setChecked(True)
assert services.settings.generation_reference_expanded()

second = GeneratePage(services)
assert second._reference_section.is_expanded()
assert not second._reference_section.content.isHidden()
second.close()
"""
        )

    def test_submit_button_uses_shared_primary_style(self) -> None:
        self.run_qt_case(
            """
assert page._submit.objectName() == "submit"
assert page._submit.styleSheet() == SUBMIT_BUTTON_STYLE
"""
        )

    def test_custom_size_inputs_only_appear_for_custom_mode(self) -> None:
        self.run_qt_case(
            """
assert page._custom_size.isHidden()
page.set_models(("qwen-image-3.0-pro",))
assert page._custom_size.isHidden()

custom_index = page._size_combo.findText("自定义…")
assert custom_index >= 0
page._size_combo.setCurrentIndex(custom_index)
assert not page._custom_size.isHidden()

page._size_combo.setCurrentIndex(0)
assert page._custom_size.isHidden()
"""
        )

    def test_image_count_disclosure_state_is_restored(self) -> None:
        self.run_qt_case(
            """
assert not page._count_section.toggle.isChecked()
page._count_section.toggle.setChecked(True)
assert services.settings.generation_image_count_expanded()

second = GeneratePage(services)
assert second._count_section.toggle.isChecked()
assert not second._count_section.content.isHidden()
second.close()
"""
        )

    def test_opening_advanced_input_dismisses_hint_permanently(self) -> None:
        self.run_qt_case(
            """
assert not page._disclosure_hint.isHidden()
page._reference_section.toggle.setChecked(True)
assert page._disclosure_hint.isHidden()
assert services.settings.generation_disclosure_hint_seen()

second = GeneratePage(services)
assert second._disclosure_hint.isHidden()
second.close()
"""
        )

    def test_closing_disclosure_hint_marks_it_seen(self) -> None:
        self.run_qt_case(
            """
assert not page._disclosure_hint.isHidden()
page._dismiss_disclosure_hint.click()
assert page._disclosure_hint.isHidden()
assert services.settings.generation_disclosure_hint_seen()

second = GeneratePage(services)
assert second._disclosure_hint.isHidden()
second.close()
"""
        )

    def test_apply_preset_fills_shared_prompt_state(self) -> None:
        """验收口径 #3：应用预设后正向/负向提示词被填充，带参考图（编辑任务）同样生效。"""
        self.run_qt_case(
            """
page.set_models(("qwen-image-3.0-pro",))
assert page._prompt.toPlainText() == "测试提示词"
assert page._negative_prompt.toPlainText() == "测试负向"
page._negative_section.toggle.setChecked(True)

ref = Path(root) / "ref.png"
ref.write_bytes(PNG_1X1)
page._add_reference_paths([str(ref)])
captured = {}
page._application.submit_generate = lambda draft: captured.update(draft=draft)
page._submit_generate()
draft = captured["draft"]
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
assert page._apply_preset.isVisible()
assert page._copy_preset.isVisible()
assert not page._edit_preset.isVisible()
assert not page._delete_preset.isVisible()

personal = services.presets.copy_builtin_as_personal(
    builtin.preset_id,
    "测试个人预设",
)
page._populate_presets()
page._select_preset(personal.preset_id)
assert page._apply_preset.isVisible()
assert not page._copy_preset.isVisible()
assert page._edit_preset.isVisible()
assert page._delete_preset.isVisible()
"""
        )

    def test_first_builtin_is_selected_applied_and_exposed_through_one_menu(self) -> None:
        self.run_qt_case(
            """
assert page._preset_combo.currentData() == "builtin-test"
assert services.settings.generation_selected_preset_id() == "builtin-test"
assert page._prompt.toPlainText() == "测试提示词"
assert page._negative_prompt.toPlainText() == "测试负向"
assert page._preset_actions.text() == "预设操作…"
assert "应用" in page._preset_actions.toolTip()
assert page._preset_actions.menu() is page._preset_menu
assert [action.text() for action in page._preset_menu.actions() if action.isVisible()] == [
    "应用项目预设",
    "复制为个人预设",
    "新建个人预设",
]
"""
        )

    def test_no_builtin_presets_keeps_selection_empty(self) -> None:
        self.run_qt_case(
            """
empty_store = PresetStore(root / "empty-user", builtins=())
empty_services = ApplicationServices(
    user_data_dir=root / "empty-user",
    output_root=root / "empty-output",
    gateway=Gateway(),
    credentials=MemoryCredentialService(),
    preset_store=empty_store,
)
empty_page = GeneratePage(empty_services)
assert empty_page._preset_combo.currentIndex() == -1
assert empty_page._preset_combo.placeholderText() == "选择项目预设"
assert empty_page._prompt.toPlainText() == ""
assert empty_services.settings.generation_selected_preset_id() is None
empty_page.close()
empty_services.close()
"""
        )

    def test_recorded_applied_preset_is_applied_on_restart(self) -> None:
        self.run_qt_case(
            """
page._prompt.setPlainText("临时修改")
second_store = PresetStore(
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
second_services = ApplicationServices(
    user_data_dir=root / "user-data",
    output_root=root / "second-output",
    gateway=Gateway(),
    credentials=MemoryCredentialService(),
    preset_store=second_store,
)
second_page = GeneratePage(second_services)
assert second_page._preset_combo.currentData() == "builtin-test"
assert second_page._prompt.toPlainText() == "测试提示词"
assert second_page._negative_prompt.toPlainText() == "测试负向"
second_page.close()
second_services.close()
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
page._negative_prompt.setPlainText("不应发送")

assert not page._references.isEnabled()
assert not page._add_reference.isEnabled()
assert not page._reference_disabled.isHidden()
assert "不支持图片编辑" in page._reference_disabled.text()
assert page._read_draft().negative_prompt is None

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

    def test_submit_uses_selected_model_size_count_and_prompt_values(self) -> None:
        self.run_qt_case(
            """
page.set_models(("flag-model", "econ-model"))
page._prompt.setPlainText("漂浮岛屿，暖色逆光")
page._negative_section.toggle.setChecked(True)
page._negative_prompt.setPlainText("模糊，文字")
custom_index = page._size_combo.findText("自定义…")
page._size_combo.setCurrentIndex(custom_index)
page._width_box.setValue(1024)
page._height_box.setValue(1024)
page._count_box.setValue(2)
captured = {}
page._application.submit_generate = lambda draft: captured.update(draft=draft)

page._submit_generate()

draft = captured["draft"]
assert draft.prompt == "漂浮岛屿，暖色逆光"
assert draft.negative_prompt == "模糊，文字"
assert draft.model_id == "flag-model"
assert draft.size_mode.value == "custom"
assert (draft.size_width, draft.size_height) == (1024, 1024)
assert draft.image_count == 2
"""
        )


if __name__ == "__main__":
    unittest.main()
