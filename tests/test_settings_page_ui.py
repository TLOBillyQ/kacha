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

from PySide6.QtWidgets import QApplication, QLabel, QSpinBox

from ugc_image_tool.services import ApplicationServices
from ugc_image_tool.settings import MemoryCredentialService, SettingsApplication, SettingsStore
from ugc_image_tool.ui.pages.settings_page import SettingsPage
from ugc_image_tool.ui.presentation import UI_ERROR, UI_SUCCESS, UI_TEXT_MUTED


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


class DiscoveryController:
    def run_connection_check(self):
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
page = SettingsPage(services, DiscoveryController())
page.resize(800, 700)
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


class SettingsPageUiTests(unittest.TestCase):
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

    def test_default_layout_discloses_output_security_then_collapsed_advanced(self) -> None:
        self.run_qt_case(
            """
layout = page.layout()
assert layout.indexOf(page._output_section) < layout.indexOf(page._transport_status)
assert layout.indexOf(page._transport_status) < layout.indexOf(page._advanced_section)
assert page._output_root_edit.isVisible()
assert page._transport_status.isVisible()
assert not page._advanced_section.is_expanded()
assert page._advanced_section.toggle.text() == "高级"
assert page._advanced_section.summary.text() == "网关地址、API 密钥、连接测试、并发上限、本地诊断"
assert UI_TEXT_MUTED in page._advanced_section.summary.styleSheet()
assert page._advanced_section.content.isHidden()
"""
        )

    def test_http_warning_and_https_status_share_the_same_live_location(self) -> None:
        self.run_qt_case(
            """
assert "明文 HTTP" in page._transport_status_text.text()
assert "传输保护" not in page._transport_status_text.text()
assert UI_ERROR in page._transport_status_text.styleSheet()
assert page._show_gateway_settings.isVisible()

page._show_gateway_settings.click()
assert page._advanced_section.is_expanded()
assert page._base_url_edit.hasFocus()

page._base_url_edit.setText("https://gateway.example.com")
page._apply_base_url()
assert "HTTPS" in page._transport_status_text.text()
assert UI_SUCCESS in page._transport_status_text.styleSheet()
assert page._show_gateway_settings.isHidden()
"""
        )

    def test_advanced_controls_follow_required_order_and_persist(self) -> None:
        self.run_qt_case(
            """
page._advanced_section.set_expanded(True)
content = page._advanced_section.content.layout()
ordered = [
    page._base_url_section,
    page._api_key_section,
    page._connection_test_section,
    page._concurrency_section,
    page._diagnostics_section,
]
assert [content.indexOf(section) for section in ordered] == sorted(
    content.indexOf(section) for section in ordered
)
assert services.settings.settings_advanced_expanded()

page._settings_concurrency.setValue(5)
assert services.generation.max_concurrency == 5
reloaded = SettingsApplication(
    SettingsStore(root / "user-data"),
    MemoryCredentialService(),
)
assert reloaded.concurrency_limit == 5
assert reloaded.settings_advanced_expanded()
"""
        )


if __name__ == "__main__":
    unittest.main()
