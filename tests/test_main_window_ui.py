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

    def test_page_feedback_still_uses_status_bar(self) -> None:
        self.run_qt_case(
            """
window._text_page.status_message.emit("已提交生成任务")
assert window.statusBar().currentMessage() == "已提交生成任务"
assert window._status_text.text() == "正在连接网关…"
"""
        )


if __name__ == "__main__":
    unittest.main()
