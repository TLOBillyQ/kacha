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
assert not page._edit_negative_prompt_group.isChecked()
assert page._edit_negative_prompt.isHidden()

page._edit_negative_prompt_group.setVisible(True)
page._edit_negative_prompt_group.setChecked(True)
assert not page._edit_negative_prompt.isHidden()

page.set_models(("qwen-image-3.0-pro",))
assert page._edit_negative_prompt_group.isHidden()
assert page._edit_negative_prompt.isHidden()
"""
        )

    def test_submit_button_uses_shared_primary_style(self) -> None:
        self.run_qt_case(
            """
assert page._edit_edit_submit.objectName() == "submit"
assert page._edit_edit_submit.styleSheet() == SUBMIT_BUTTON_STYLE
"""
        )


if __name__ == "__main__":
    unittest.main()
