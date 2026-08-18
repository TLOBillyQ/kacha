from __future__ import annotations

import threading
import unittest
from unittest.mock import patch

from PySide6.QtCore import QCoreApplication
from PySide6.QtTest import QTest

from ugc_image_tool.capabilities import CapabilityRegistry
from ugc_image_tool.discovery import ConnectionCheck, ConnectionStage, DiscoveryState
from ugc_image_tool.ui.controllers.discovery_controller import DiscoveryController


class ScriptedDiscovery:
    """按刷新代际返回预设状态，让竞态行为可确定性测试。"""

    def __init__(self, *, block_first: bool = False) -> None:
        self._state = DiscoveryState()
        self._block_first = block_first
        self._states = {
            1: DiscoveryState(
                model_ids=("stale-model",),
                online=True,
                pending=False,
            ),
            2: DiscoveryState(
                model_ids=("fresh-model",),
                online=True,
                pending=False,
            ),
        }
        self.first_started = threading.Event()
        self.release_first = threading.Event()

    @property
    def state(self) -> DiscoveryState:
        return self._state

    def refresh(self) -> DiscoveryState:
        thread_name = threading.current_thread().name
        if self._block_first and thread_name.endswith("-1"):
            self.first_started.set()
            self.release_first.wait(timeout=2)
            return self._states[1]
        return self._states[2]

    def submission_block_reason(self) -> str | None:
        return "测试阻塞原因"


class ImmediateProvider:
    def list_models(self) -> tuple[str, ...]:
        return ("qwen-image-3.0-pro",)


class DiscoveryControllerTests(unittest.TestCase):
    app: QCoreApplication

    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QCoreApplication.instance() or QCoreApplication([])

    def test_refresh_emits_discovered_state(self) -> None:
        states: list[DiscoveryState] = []
        controller = DiscoveryController(
            ScriptedDiscovery(),
            provider=ImmediateProvider(),
            capabilities=CapabilityRegistry(),
        )
        controller.discovered.connect(states.append)

        controller.refresh()
        deadline = 200
        while not states and deadline > 0:
            QTest.qWait(10)
            deadline -= 10
        self.assertEqual(1, len(states))
        self.assertEqual(("fresh-model",), states[0].model_ids)

    def test_stale_refresh_result_is_discarded(self) -> None:
        discovery = ScriptedDiscovery(block_first=True)
        states: list[DiscoveryState] = []
        controller = DiscoveryController(
            discovery,
            provider=ImmediateProvider(),
            capabilities=CapabilityRegistry(),
        )
        controller.discovered.connect(states.append)

        controller.refresh()
        self.assertTrue(discovery.first_started.wait(timeout=1))
        controller.refresh()
        deadline = 200
        while not states and deadline > 0:
            QTest.qWait(10)
            deadline -= 10
        self.assertEqual(("fresh-model",), states[0].model_ids)

        discovery.release_first.set()
        QTest.qWait(100)

        self.assertEqual(1, len(states))
        self.assertEqual(("fresh-model",), states[0].model_ids)

    def test_connection_check_emits_checks(self) -> None:
        checks: list[tuple[ConnectionCheck, ...]] = []
        controller = DiscoveryController(
            ScriptedDiscovery(),
            provider=ImmediateProvider(),
            capabilities=CapabilityRegistry(),
        )
        controller.checked.connect(checks.append)

        controller.run_connection_check()

        deadline = 200
        while not checks and deadline > 0:
            QTest.qWait(10)
            deadline -= 10
        self.assertEqual(1, len(checks))
        self.assertEqual(ConnectionStage.DNS_OR_CONNECT, checks[0][0].stage)

    def test_connection_check_failure_still_emits_checks(self) -> None:
        checks: list[tuple[ConnectionCheck, ...]] = []
        controller = DiscoveryController(
            ScriptedDiscovery(),
            provider=ImmediateProvider(),
            capabilities=CapabilityRegistry(),
        )
        controller.checked.connect(checks.append)

        with patch(
            "ugc_image_tool.ui.controllers.discovery_controller.run_connection_check",
            side_effect=RuntimeError("测试连接检查异常"),
        ):
            controller.run_connection_check()

        deadline = 200
        while not checks and deadline > 0:
            QTest.qWait(10)
            deadline -= 10
        self.assertEqual(1, len(checks))
        self.assertFalse(checks[0][0].ok)
        self.assertIn("连接检查失败", checks[0][0].message)
        self.assertIsNone(checks[0][1].ok)


if __name__ == "__main__":
    unittest.main()
