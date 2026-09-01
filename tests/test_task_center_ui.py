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
from PySide6.QtWidgets import QApplication, QLabel, QSpinBox

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

    def test_layout_is_preview_first_vertical_splitter(self) -> None:
        self.run_qt_case(
            """
assert page._content_splitter.orientation() == Qt.Orientation.Vertical
assert page._content_splitter.widget(0) is page._preview
assert page._content_splitter.widget(1) is page._task_list
assert page._content_splitter.widget(2) is page._result_list
assert not hasattr(page, "_result_splitter")
page._content_splitter.splitterMoved.emit(100, 1)
"""
        )

    def test_concurrency_limit_is_not_exposed_in_task_center(self) -> None:
        self.run_qt_case(
            """
assert not hasattr(page, "_concurrency_box")
assert not hasattr(page, "concurrency_changed")
assert all(
    "并发上限" not in label.text()
    for label in page.findChildren(QLabel)
)
assert not page.findChildren(QSpinBox)
"""
        )

    def test_empty_state_and_unselected_task_hide_all_actions(self) -> None:
        self.run_qt_case(
            """
assert page._empty_state.text() == "生成结果会出现在这里"
assert page._empty_state.isVisible()
assert page._content_splitter.isHidden()
assert page._action_bar.isHidden()

page.on_task_changed(make_task("queued-task"))
page._task_list.setCurrentRow(-1)
app.processEvents()
assert page._empty_state.isHidden()
assert page._content_splitter.isVisible()
assert page._action_bar.isHidden()
"""
        )

    def test_every_task_status_maps_to_the_contextual_primary_action(self) -> None:
        self.run_qt_case(
            """
image_path = root / "result.png"
source = QPixmap(20, 20)
source.fill(QColor("#ff0000"))
assert source.save(str(image_path))

expected_without_result = {
    GenerationStatus.QUEUED: "取消任务",
    GenerationStatus.RUNNING: "取消任务",
    GenerationStatus.SUCCEEDED: "移除",
    GenerationStatus.PARTIALLY_SUCCEEDED: "移除",
    GenerationStatus.FAILED: "移除",
    GenerationStatus.UNKNOWN: "移除",
    GenerationStatus.CANCELLED: "移除",
}
for index, (status, expected_text) in enumerate(expected_without_result.items()):
    page.on_task_changed(make_task(f"task-{index}", status=status))
    page._task_list.setCurrentRow(index)
    app.processEvents()
    assert page._primary_action.text() == expected_text
    assert page._primary_action.toolTip()
    assert page._primary_action.accessibleName() == page._primary_action.toolTip()
    assert not page._primary_action.icon().isNull()

for status in (
    GenerationStatus.SUCCEEDED,
    GenerationStatus.PARTIALLY_SUCCEEDED,
    GenerationStatus.FAILED,
    GenerationStatus.UNKNOWN,
    GenerationStatus.CANCELLED,
):
    index = page._task_list.count()
    page.on_task_changed(
        make_task(f"result-{status.value}", status=status, result_paths=(image_path,))
    )
    page._task_list.setCurrentRow(index)
    app.processEvents()
    assert page._primary_action.text() == "复制图片"
    assert page._primary_action.toolTip() == "复制当前生成结果"
    assert page._primary_action.accessibleName() == "复制当前生成结果"
"""
        )

    def test_more_menu_contains_only_actions_valid_for_current_context(self) -> None:
        self.run_qt_case(
            """
def menu_entries():
    return ["<separator>" if action.isSeparator() else action.text()
            for action in page._more_menu.actions()]

page.on_task_changed(make_task("running", status=GenerationStatus.RUNNING))
app.processEvents()
assert menu_entries() == []
assert page._more_actions.isHidden()

page.on_task_changed(make_task("failed", status=GenerationStatus.FAILED))
page._task_list.setCurrentRow(1)
app.processEvents()
assert menu_entries() == ["从任务中心移除"]
assert page._more_actions.isVisible()

image_path = root / "result.png"
source = QPixmap(20, 20)
source.fill(QColor("#ff0000"))
assert source.save(str(image_path))
page.on_task_changed(
    make_task(
        "completed",
        status=GenerationStatus.SUCCEEDED,
        result_paths=(image_path,),
    )
)
page._task_list.setCurrentRow(2)
app.processEvents()
assert menu_entries() == [
    "保存副本",
    "打开所在目录",
    "<separator>",
    "从任务中心移除",
]
assert page._more_actions.isVisible()
assert page._more_actions.toolTip() == "更多当前生成结果和任务操作"
assert page._more_actions.accessibleName() == page._more_actions.toolTip()
"""
        )

    def test_result_actions_and_terminal_removal_target_only_current_context(self) -> None:
        self.run_qt_case(
            """
import ugc_image_tool.ui.pages.task_center as task_center_module

first_dir = root / "first"
second_dir = root / "second"
first_dir.mkdir()
second_dir.mkdir()
first_path = first_dir / "first.png"
second_path = second_dir / "second.png"
first = QPixmap(20, 20)
first.fill(QColor("#ff0000"))
second = QPixmap(20, 20)
second.fill(QColor("#0000ff"))
assert first.save(str(first_path))
assert second.save(str(second_path))

page.on_task_changed(
    make_task(
        "completed",
        status=GenerationStatus.SUCCEEDED,
        result_paths=(first_path, second_path),
    )
)
page._result_list.setCurrentRow(1)
app.processEvents()

page._primary_action.click()
clipboard_image = QApplication.clipboard().pixmap().toImage()
assert clipboard_image.pixelColor(0, 0) == QColor("#0000ff")

copy_path = root / "selected-copy.png"
class SaveDialog:
    @staticmethod
    def getSaveFileName(*args):
        return str(copy_path), ""

opened = []
class DesktopServices:
    @staticmethod
    def openUrl(url):
        opened.append(url.toLocalFile())
        return True

task_center_module.QFileDialog = SaveDialog
task_center_module.QDesktopServices = DesktopServices
page._save_copy_action.trigger()
page._open_directory_action.trigger()
assert copy_path.read_bytes() == second_path.read_bytes()
assert opened == [str(second_dir)]

class GenerationOperations:
    def __init__(self):
        self.removed = []

    def remove_task(self, task_id):
        self.removed.append(task_id)
        return True

page._application = GenerationOperations()
page._remove_task_action.trigger()
assert page._application.removed == ["completed"]
assert first_path.is_file()
assert second_path.is_file()
assert page._task_list.count() == 0
assert page._empty_state.isVisible()
assert page._action_bar.isHidden()
"""
        )

    def test_primary_action_preserves_cancel_semantics_and_tracks_status_changes(self) -> None:
        self.run_qt_case(
            """
class GenerationOperations:
    def __init__(self):
        self.cancelled = []

    def cancel(self, task_id):
        self.cancelled.append(task_id)
        return True

page._application = GenerationOperations()
page.on_task_changed(make_task("active", status=GenerationStatus.RUNNING))
page._primary_action.click()
assert page._application.cancelled == ["active"]

page.on_task_changed(make_task("active", status=GenerationStatus.CANCELLED))
app.processEvents()
assert page._primary_action.text() == "移除"
assert [action.text() for action in page._more_menu.actions()] == [
    "从任务中心移除"
]
"""
        )

    def test_removing_one_terminal_task_selects_the_next_task_context(self) -> None:
        self.run_qt_case(
            """
image_path = root / "result.png"
source = QPixmap(20, 20)
source.fill(QColor("#ff0000"))
assert source.save(str(image_path))
page.on_task_changed(make_task("failed", status=GenerationStatus.FAILED))
page.on_task_changed(
    make_task(
        "completed",
        status=GenerationStatus.SUCCEEDED,
        result_paths=(image_path,),
    )
)
page._task_list.setCurrentRow(0)

class GenerationOperations:
    def remove_task(self, task_id):
        return task_id == "failed"

page._application = GenerationOperations()
page._primary_action.click()
app.processEvents()
assert page._task_list.count() == 1
assert page._selected_task_id == "completed"
assert page._result_list.count() == 1
assert page._primary_action.text() == "复制图片"
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
assert abs(page._content_splitter.sizes()[1] - expected_height) <= 2

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
assert page._primary_action.text() == "复制图片"
assert page._more_actions.isVisible()

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
assert page._primary_action.text() == "取消任务"
assert page._more_actions.isHidden()
"""
        )


if __name__ == "__main__":
    unittest.main()
