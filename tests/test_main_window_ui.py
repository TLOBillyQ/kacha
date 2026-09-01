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

from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from ugc_image_tool.discovery import DiscoveryState
from ugc_image_tool.presets import PresetStore
from ugc_image_tool.services import ApplicationServices
from ugc_image_tool.settings import MemoryCredentialService
from ugc_image_tool.ui.main_window import MainWindow
from ugc_image_tool.ui.presentation import (
    UI_ERROR,
    UI_SUCCESS,
    UI_TEXT_MUTED,
    UI_WARNING,
)


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


class StubController:
    def __init__(self, state):
        self._state = state

    @property
    def state(self):
        return self._state


app = QApplication([])
directory = TemporaryDirectory()
root = Path(directory.name)
from PySide6.QtCore import QSettings

QSettings.setDefaultFormat(QSettings.Format.IniFormat)
QSettings.setPath(
    QSettings.Format.IniFormat, QSettings.Scope.UserScope, str(root / "settings")
)
services = ApplicationServices(
    user_data_dir=root / "user-data",
    output_root=root / "output",
    gateway=Gateway(),
    credentials=MemoryCredentialService(),
    preset_store=PresetStore(root / "user-data"),
)
window = MainWindow(services=services)


def set_state(state):
    window._discovery_controller = StubController(state)
    window._update_connection_status()
"""

QT_CASE_SUFFIX = """
# 等待启动时的异步发现结束，避免守护线程在清理临时目录时仍在写缓存。
for _ in range(200):
    if not services.discovery.state.pending:
        break
    QTest.qWait(10)
QTest.qWait(50)
window.close()
services.close()
directory.cleanup()
app.closeAllWindows()
app.quit()
"""


class MainWindowUiTests(unittest.TestCase):
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

    def test_pending_and_online_states_stay_in_status_bar(self) -> None:
        self.run_qt_case(
            """
assert window._status_text.text() == "正在连接网关…"
assert UI_TEXT_MUTED in window._status_dot.styleSheet()
assert window._connection_banner.isHidden()

set_state(DiscoveryState(model_ids=("m1", "m2"), online=True, pending=False))
assert window._status_text.text() == "网关在线"
assert UI_SUCCESS in window._status_dot.styleSheet()
assert window._connection_banner.isHidden()
"""
        )

    def test_cached_models_raise_banner_with_fetched_time(self) -> None:
        self.run_qt_case(
            """
from datetime import UTC, datetime

fetched = datetime(2026, 8, 19, 1, 0, tzinfo=UTC)
set_state(
    DiscoveryState(
        model_ids=("cached-model",),
        from_cache=True,
        pending=False,
        fetched_at=fetched,
    )
)
assert window._status_text.text() == "使用缓存模型"
assert UI_WARNING in window._status_dot.styleSheet()
assert not window._connection_banner.isHidden()
assert "获取于" in window._banner_text.text()
assert "模型列表可能已过期" in window._banner_text.text()
"""
        )

    def test_offline_raises_banner_with_error_detail(self) -> None:
        self.run_qt_case(
            """
set_state(DiscoveryState(pending=False, error="连接超时"))
assert window._status_text.text() == "网关离线"
assert UI_ERROR in window._status_dot.styleSheet()
assert not window._connection_banner.isHidden()
assert "无法获取模型列表" in window._banner_text.text()
assert "连接超时" in window._banner_text.text()
"""
        )

    def test_banner_action_opens_settings_page(self) -> None:
        self.run_qt_case(
            """
set_state(DiscoveryState(pending=False))
assert not window._connection_banner.isHidden()
window._banner_action.click()
assert window._tabs.currentWidget() is window._settings_page
"""
        )

    def test_task_center_docks_right_with_recall_button(self) -> None:
        self.run_qt_case(
            """
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QDockWidget

assert isinstance(window._dock, QDockWidget)
assert window._dock.objectName() == "taskCenterDock"
assert window._dock.widget() is window._task_center
assert window.dockWidgetArea(window._dock) == Qt.DockWidgetArea.RightDockWidgetArea
allowed = window._dock.allowedAreas()
assert allowed & Qt.DockWidgetArea.LeftDockWidgetArea
assert allowed & Qt.DockWidgetArea.RightDockWidgetArea
assert allowed & Qt.DockWidgetArea.BottomDockWidgetArea
assert not allowed & Qt.DockWidgetArea.TopDockWidgetArea
features = window._dock.features()
assert features & QDockWidget.DockWidgetFeature.DockWidgetMovable
assert features & QDockWidget.DockWidgetFeature.DockWidgetFloatable
assert features & QDockWidget.DockWidgetFeature.DockWidgetClosable
central_layout = window.centralWidget().layout()
assert central_layout.indexOf(window._task_center) == -1
assert window._recall_button.text() == "任务中心"
"""
        )

    def test_default_dock_width_is_340_without_saved_state(self) -> None:
        self.run_qt_case(
            """
assert window._window_settings().value("mainWindow/state") is None
window.show()
QTest.qWait(50)
app.processEvents()
assert abs(window._dock.width() - 340) <= 20, window._dock.width()
"""
        )

    def test_recall_button_toggles_dock_and_clears_badge(self) -> None:
        self.run_qt_case(
            """
window.show()
app.processEvents()
assert window._dock.isVisible()

window._recall_button.click()
assert not window._dock.isVisible()

window._on_task_arrived(None)
assert window._recall_button.text() == "任务中心 ● 新任务"
assert window._recall_button.styleSheet()
assert not window._dock.isVisible()

window._recall_button.click()
assert window._dock.isVisible()
assert window._recall_button.text() == "任务中心"
assert window._recall_button.styleSheet() == ""
"""
        )

    def test_window_state_persists_and_restores_dock_placement(self) -> None:
        self.run_qt_case(
            """
window.show()
app.processEvents()
window._dock.setFloating(True)
assert window._dock.isFloating()
window.close()
saved = window._window_settings().value("mainWindow/state")
assert saved is not None
window._dock.setFloating(False)
assert window._restore_window_state()
assert window._dock.isFloating()
"""
        )

    def test_page_feedback_still_uses_status_bar(self) -> None:
        self.run_qt_case(
            """
window._generate_page.status_message.emit("已提交生成任务")
assert window.statusBar().currentMessage() == "已提交生成任务"
assert window._status_text.text() == "正在连接网关…"
"""
        )

    def test_generation_entry_is_a_single_generate_tab(self) -> None:
        """结构验收：生成入口收敛为一个「生成」标签，无文生图/图片编辑标签。"""
        self.run_qt_case(
            """
labels = [window._tabs.tabText(i) for i in range(window._tabs.count())]
assert labels == ["生成", "设置"], labels
assert window._tabs.widget(0) is window._generate_page
assert window._tabs.widget(1) is window._settings_page
assert not hasattr(window, "_text_page")
assert not hasattr(window, "_edit_page")
"""
        )

    def test_window_has_no_concurrency_synchronization_wiring(self) -> None:
        self.run_qt_case(
            """
assert not hasattr(window._settings_page, "concurrency_changed")
assert not hasattr(window._task_center, "concurrency_changed")
assert not hasattr(window._task_center, "set_concurrency")
assert not hasattr(window._settings_page, "set_concurrency")
"""
        )

    def test_status_bar_shows_version_badge_at_far_right(self) -> None:
        self.run_qt_case(
            """
from ugc_image_tool.version_info import build_label

expected = build_label()
assert window._version_badge.text() == expected, (window._version_badge.text(), expected)
assert "点击复制" in window._version_badge.toolTip()
assert window._version_badge.parent() is window.statusBar()
"""
        )

    def test_clicking_version_badge_copies_text_to_clipboard(self) -> None:
        self.run_qt_case(
            """
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication
from ugc_image_tool.version_info import build_label

expected = build_label()
QApplication.clipboard().clear()
QTest.mouseClick(window._version_badge, Qt.MouseButton.LeftButton)
QTest.qWait(50)
assert QApplication.clipboard().text() == expected, QApplication.clipboard().text()
"""
        )


if __name__ == "__main__":
    unittest.main()
