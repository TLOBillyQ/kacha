from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

QT_CASE_PREFIX = """
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPixmap
from PySide6.QtWidgets import QApplication

from ugc_image_tool.generation import (
    GenerationStatus,
    GenerationTask,
    TextToImageRequest,
)
from ugc_image_tool.services import ApplicationServices
from ugc_image_tool.settings import MemoryCredentialService
from ugc_image_tool.ui.pages.task_center import TaskCenterPage
from ugc_image_tool.ui.presentation import STATUS_LABELS


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


def make_task(
    task_id,
    status=GenerationStatus.QUEUED,
    prompt="测试提示词",
    result_paths=(),
):
    return GenerationTask(
        task_id=task_id,
        request=TextToImageRequest(
            prompt=prompt,
            model_id="model",
            capability_version="test-v1",
        ),
        submitted_at=datetime.now(UTC),
        status=status,
        result_paths=tuple(result_paths),
    )


app = QApplication([])
directory = TemporaryDirectory()
root = Path(directory.name)
services = ApplicationServices(
    user_data_dir=root / "user-data",
    output_root=root / "output",
    gateway=Gateway(),
    credentials=MemoryCredentialService(),
)
page = TaskCenterPage(services)
page.resize(800, 600)
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


class TaskCenterUiTests(unittest.TestCase):
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

    def test_layout_uses_vertical_and_horizontal_splitters(self) -> None:
        self.run_qt_case(
            """
assert page._content_splitter.orientation() == Qt.Orientation.Vertical
assert page._content_splitter.widget(0) is page._task_list
assert page._content_splitter.widget(1) is page._result_splitter
assert page._result_splitter.orientation() == Qt.Orientation.Horizontal
assert page._result_splitter.widget(0) is page._result_list
assert page._result_splitter.widget(1) is page._preview
assert page._result_splitter.sizes()[0] < page._result_splitter.sizes()[1]
page._result_splitter.splitterMoved.emit(100, 1)
page._content_splitter.splitterMoved.emit(100, 1)
"""
        )

    def test_task_rows_are_two_line_status_colored_and_capped_at_four(self) -> None:
        self.run_qt_case(
            """
expected_colors = {
    GenerationStatus.QUEUED: "#9e9e9e",
    GenerationStatus.RUNNING: "#1976d2",
    GenerationStatus.SUCCEEDED: "#388e3c",
    GenerationStatus.PARTIALLY_SUCCEEDED: "#f57c00",
    GenerationStatus.FAILED: "#c62828",
    GenerationStatus.UNKNOWN: "#757575",
    GenerationStatus.CANCELLED: "#e65100",
}
for index, (status, color) in enumerate(expected_colors.items()):
    task = make_task(f"task-{index}", status=status, prompt=f"提示词 {index}")
    page.on_task_changed(task)
    item = page._task_list.item(index)
    assert item.text() == f"[{STATUS_LABELS[status]}]  task-{index}\\n提示词 {index}"
    assert item.foreground().color().name() == color
    assert item.sizeHint().height() == page._TASK_ITEM_HEIGHT

page._content_splitter.resize(700, 500)
page._resize_task_list()
expected_height = (
    page._MAX_VISIBLE_TASKS * page._TASK_ITEM_HEIGHT
    + 2 * page._task_list.frameWidth()
)
assert abs(page._content_splitter.sizes()[0] - expected_height) <= 2

updated = make_task("task-0", status=GenerationStatus.RUNNING, prompt="更新后的提示词")
page.on_task_changed(updated)
item = page._task_list.item(0)
assert item.text().endswith("\\n更新后的提示词")
assert item.foreground().color().name() == "#1976d2"
"""
        )

    def test_preview_rescales_from_original_and_clears_for_empty_task(self) -> None:
        self.run_qt_case(
            """
image_path = root / "result.png"
source = QPixmap(40, 20)
source.fill(QColor("#ff0000"))
assert source.save(str(image_path))

completed = make_task(
    "completed-task",
    status=GenerationStatus.SUCCEEDED,
    result_paths=(image_path,),
)
page.on_task_changed(completed)
app.processEvents()
assert page._current_preview is not None
assert page._current_preview.size().width() == 40
assert page._current_preview.size().height() == 20
assert page._save_copy.isEnabled()
assert page._copy_image.isEnabled()
assert page._open_directory.isEnabled()

page._preview.resize(120, 120)
page._refresh_preview()
scaled = source.scaled(
    page._preview.size(),
    Qt.AspectRatioMode.KeepAspectRatio,
    Qt.TransformationMode.SmoothTransformation,
)
assert page._preview.pixmap().size() == scaled.size()
assert page._current_preview.width() == 40

page.on_task_changed(make_task("empty-task"))
page._task_list.setCurrentRow(1)
app.processEvents()
assert page._current_preview is None
assert page._preview.text() == "当前任务没有可预览的结果"
assert not page._save_copy.isEnabled()
"""
        )


if __name__ == "__main__":
    unittest.main()
