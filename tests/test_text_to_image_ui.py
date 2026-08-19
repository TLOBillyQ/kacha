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


if __name__ == "__main__":
    unittest.main()
