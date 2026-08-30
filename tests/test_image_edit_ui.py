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

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QListWidget

from ugc_image_tool.services import ApplicationServices
from ugc_image_tool.settings import MemoryCredentialService
from ugc_image_tool.ui.pages.image_edit import ImageEditPage
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
services = ApplicationServices(
    user_data_dir=root / "user-data",
    output_root=root / "output",
    gateway=Gateway(),
    credentials=MemoryCredentialService(),
)
page = ImageEditPage(services)
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


class ImageEditUiTests(unittest.TestCase):
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

    def test_layout_uses_left_reference_splitter(self) -> None:
        self.run_qt_case(
            """
assert page._edit_splitter.orientation() == Qt.Orientation.Horizontal
assert page._edit_splitter.count() == 2
left_width, right_width = page._edit_splitter.sizes()
assert 175 <= left_width <= 205, (left_width, right_width)
assert right_width > left_width
assert page._edit_references.viewMode() == QListWidget.ViewMode.ListMode
"""
        )

    def test_negative_prompt_is_collapsed_and_capability_aware(self) -> None:
        self.run_qt_case(
            """
assert not page._edit_negative_prompt_check.isChecked()
assert page._edit_negative_prompt.isHidden()

page._edit_negative_prompt_check.setChecked(True)
assert not page._edit_negative_prompt.isHidden()

page.set_models(("qwen-image-3.0-pro",))
assert not page._edit_negative_prompt_check.isHidden()
assert not page._edit_negative_prompt.isHidden()

page.set_models(("unknown-model",))
assert page._edit_negative_prompt_check.isHidden()
assert page._edit_negative_prompt.isHidden()
"""
        )

    def test_unchecked_negative_prompt_is_kept_but_not_submitted(self) -> None:
        self.run_qt_case(
            """
captured = {}
page._application.submit_edit = lambda draft: captured.update(draft=draft)
page._edit_negative_prompt.setPlainText("模糊，低清晰度")

page._edit_negative_prompt_check.setChecked(True)
page._submit_edit()
assert captured["draft"].negative_prompt == "模糊，低清晰度"

page._edit_negative_prompt_check.setChecked(False)
page._submit_edit()
assert captured["draft"].negative_prompt is None
assert page._edit_negative_prompt.toPlainText() == "模糊，低清晰度"
"""
        )

    def test_negative_prompt_checked_state_is_restored_on_new_page(self) -> None:
        self.run_qt_case(
            """
from ugc_image_tool.capabilities import Workflow

page._edit_negative_prompt_check.setChecked(True)
assert services.settings.negative_prompt_enabled(Workflow.IMAGE_EDIT)

second = ImageEditPage(services)
assert second._edit_negative_prompt_check.isChecked()
second.close()

services.settings.save_negative_prompt_enabled(Workflow.IMAGE_EDIT, False)
third = ImageEditPage(services)
assert not third._edit_negative_prompt_check.isChecked()
third.close()
"""
        )

    def test_submit_button_uses_shared_primary_style(self) -> None:
        self.run_qt_case(
            """
assert page._edit_edit_submit.objectName() == "submit"
assert page._edit_edit_submit.styleSheet() == SUBMIT_BUTTON_STYLE
"""
        )


QT_TIER_PREFIX = """
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from ugc_image_tool.capabilities import CapabilityRegistry, ModelTier, Workflow
from ugc_image_tool.services import ApplicationServices
from ugc_image_tool.settings import MemoryCredentialService
from ugc_image_tool.ui.pages.image_edit import ImageEditPage


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


FLAG_MODEL = {
    "model_id": "flag-model",
    "display_name": "旗舰模型",
    "tier": "flagship",
    "workflows": [
        tier_workflow("text_to_image", supports_negative_prompt=True, max_images=2),
        tier_workflow(
            "image_edit",
            size={"auto_allowed": True, "presets": []},
            reference_limits={"min_references": 1, "max_references": 1},
        ),
    ],
}

# 经济档只支持文生图：不应出现在图片编辑页的分段开关里
ECON_MODEL = {
    "model_id": "econ-model",
    "display_name": "经济模型",
    "tier": "economy",
    "workflows": [tier_workflow("text_to_image")],
}

EDIT_ECON_MODEL = {
    "model_id": "econ-edit-model",
    "display_name": "经济编辑模型",
    "tier": "economy",
    "workflows": [
        tier_workflow(
            "image_edit",
            size={"auto_allowed": True, "presets": []},
            reference_limits={"min_references": 1, "max_references": 1},
        ),
    ],
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
    override_path.write_text(
        json.dumps(
            {"schema_version": 2, "models": [unshelf_pro, *models]},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
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
page = ImageEditPage(services)
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


class ImageEditTierSwitchUiTests(unittest.TestCase):
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

    def test_tier_only_appears_in_workflows_its_model_supports(self) -> None:
        self.run_qt_case(
            """
page.set_models(("flag-model", "econ-model"))
flag = page._tier_switch._buttons[ModelTier.FLAGSHIP]
econ = page._tier_switch._buttons[ModelTier.ECONOMY]
assert flag.isVisibleTo(page._tier_switch) and flag.isEnabled()
assert not econ.isVisibleTo(page._tier_switch)
assert not hasattr(page, "_edit_model_combo")
"""
        )

    def test_edit_tier_selection_resolves_model_id_for_draft(self) -> None:
        self.run_qt_case(
            """
edit_services = make_services(
    root / "edit-data",
    root / "edit-output",
    [FLAG_MODEL, EDIT_ECON_MODEL],
)
edit_page = ImageEditPage(edit_services)
edit_page.set_models(("flag-model", "econ-edit-model"))
assert edit_page._current_model_id() == "flag-model"

edit_page._tier_switch._buttons[ModelTier.ECONOMY].click()

assert edit_page._current_model_id() == "econ-edit-model"
assert edit_services.settings.selected_tier(Workflow.IMAGE_EDIT) == ModelTier.ECONOMY
edit_page.close()
edit_services.close()
"""
        )

    def test_edit_persisted_tier_restored_and_unresolvable_disabled(self) -> None:
        self.run_qt_case(
            """
edit_services = make_services(
    root / "edit-data",
    root / "edit-output",
    [FLAG_MODEL, EDIT_ECON_MODEL],
)
edit_services.settings.save_selected_tier(Workflow.IMAGE_EDIT, ModelTier.ECONOMY)
edit_page = ImageEditPage(edit_services)
edit_page.set_models(("flag-model", "econ-edit-model"))
assert edit_page._current_model_id() == "econ-edit-model"

edit_page.set_models(("flag-model",))

econ = edit_page._tier_switch._buttons[ModelTier.ECONOMY]
assert not econ.isEnabled()
assert econ.toolTip(), "禁用分段必须给出原因"
assert edit_page._current_model_id() == "flag-model"
edit_page.close()
edit_services.close()
"""
        )


if __name__ == "__main__":
    unittest.main()
