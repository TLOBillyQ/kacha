from __future__ import annotations

import importlib
import unittest

from PySide6.QtWidgets import QWidget

from ugc_image_tool.ui import MainWindow, run
from ugc_image_tool.ui.controllers.discovery_controller import DiscoveryController
from ugc_image_tool.ui.pages import (
    ImageEditPage,
    SettingsPage,
    TaskCenterPage,
    TextToImagePage,
)


class UiImportSmokeTests(unittest.TestCase):
    def test_entry_point_exports_main_window_and_run(self) -> None:
        self.assertTrue(callable(run))
        self.assertTrue(issubclass(MainWindow, QWidget))

    def test_page_components_are_importable_without_creating_qapplication(self) -> None:
        self.assertTrue(issubclass(TextToImagePage, QWidget))
        self.assertTrue(issubclass(ImageEditPage, QWidget))
        self.assertTrue(issubclass(SettingsPage, QWidget))
        self.assertTrue(issubclass(TaskCenterPage, QWidget))
        self.assertTrue(issubclass(DiscoveryController, object))

    def test_packaged_import_path_matches_console_script_target(self) -> None:
        module = importlib.import_module("ugc_image_tool.ui")

        self.assertIs(module.run, run)
        self.assertIs(module.MainWindow, MainWindow)


if __name__ == "__main__":
    unittest.main()
