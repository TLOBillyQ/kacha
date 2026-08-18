"""主窗口：装配应用服务、后台控制器与四个页面组件。"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QObject, Signal, Slot
from PySide6.QtWidgets import (
    QApplication,
    QLabel,
    QMainWindow,
    QMessageBox,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from ..capabilities import CapabilityRegistry
from ..discovery import DiscoveryState
from ..presets import PresetStore, PresetStoreError
from ..services import ApplicationServices
from ..settings import (
    CredentialService,
    SettingsApplication,
    SettingsStoreError,
)
from .controllers.discovery_controller import DiscoveryController
from .pages import ImageEditPage, SettingsPage, TaskCenterPage, TextToImagePage


class _TaskEvents(QObject):
    changed = Signal(object)


class MainWindow(QMainWindow):
    """界面只订阅状态信号并调用应用服务。"""

    def __init__(
        self,
        output_root: Path | None = None,
        capabilities: CapabilityRegistry | None = None,
        preset_store: PresetStore | None = None,
        user_data_dir: Path | None = None,
        settings: SettingsApplication | None = None,
        credentials: CredentialService | None = None,
        services: ApplicationServices | None = None,
    ) -> None:
        super().__init__()
        self.setWindowTitle("UGC AI 生图工具")
        self.resize(900, 620)
        self._events = _TaskEvents()
        if services is None:
            services = ApplicationServices(
                output_root=output_root,
                capabilities=capabilities,
                preset_store=preset_store,
                user_data_dir=user_data_dir,
                settings=settings,
                credentials=credentials,
            )
        elif any(
            value is not None
            for value in (
                output_root,
                capabilities,
                preset_store,
                user_data_dir,
                settings,
                credentials,
            )
        ):
            raise ValueError("提供 services 时不能再单独提供其他依赖")
        self._services = services
        self._services.start()
        self._services.on_task_changed = self._events.changed.emit
        self._discovery_controller = DiscoveryController(
            self._services.discovery,
            provider=self._services.gateway,
            capabilities=self._services.capabilities,
            diagnostics=self._services.diagnostics,
            parent=self,
        )
        self._connection_status = QLabel("正在连接网关…")
        self._connection_status.setWordWrap(True)
        self._text_page = TextToImagePage(self._services, parent=self)
        self._edit_page = ImageEditPage(self._services, parent=self)
        self._settings_page = SettingsPage(
            self._services,
            self._discovery_controller,
            parent=self,
        )
        self._task_center = TaskCenterPage(self._services, parent=self)
        self._wire_signals()
        self._build_window()
        self._update_connection_status()
        self._discovery_controller.refresh()

    def _wire_signals(self) -> None:
        self._events.changed.connect(self._task_center.on_task_changed)
        self._discovery_controller.discovered.connect(self._on_discovery_state)
        self._discovery_controller.checked.connect(
            self._settings_page.show_connection_check
        )
        self._settings_page.output_state_changed.connect(
            self._on_output_state_changed
        )
        self._settings_page.concurrency_changed.connect(
            self._task_center.set_concurrency
        )
        self._task_center.concurrency_changed.connect(
            self._settings_page.set_concurrency
        )
        self._settings_page.discovery_restart_requested.connect(
            self._restart_discovery
        )
        self._text_page.status_message.connect(self.statusBar().showMessage)
        self._settings_page.status_message.connect(self.statusBar().showMessage)
        self._task_center.status_message.connect(self.statusBar().showMessage)

    def _build_window(self) -> None:
        tabs = QTabWidget()
        tabs.addTab(self._text_page, "文生图")
        tabs.addTab(self._edit_page, "图片编辑")
        tabs.addTab(self._settings_page, "设置")
        root = QVBoxLayout()
        root.addWidget(self._connection_status)
        root.addWidget(tabs)
        root.addWidget(self._task_center)
        container = QWidget()
        container.setLayout(root)
        self.setCentralWidget(container)

    @Slot()
    def _on_output_state_changed(self) -> None:
        self._text_page.refresh_output_state()
        self._edit_page.refresh_output_state()

    @Slot(object)
    def _on_discovery_state(self, state: DiscoveryState) -> None:
        self._text_page.set_models(state.model_ids)
        self._edit_page.set_models(state.model_ids)
        self._update_connection_status()

    def _update_connection_status(self) -> None:
        state = self._discovery_controller.state
        if state.pending:
            text = "正在连接网关…"
            style = ""
        elif state.online:
            text = f"网关在线：发现 {len(state.model_ids)} 个可用模型"
            style = "color: #2e7d32;"
        elif state.from_cache:
            fetched = state.fetched_at
            when = (
                fetched.astimezone().strftime("%Y-%m-%d %H:%M")
                if fetched is not None
                else "未知时间"
            )
            text = f"网关离线：正在使用可能过期的缓存模型（获取于 {when}）"
            style = "color: #c62828;"
        else:
            text = "网关离线：无法获取模型列表"
            style = "color: #c62828;"
        if state.error:
            text = f"{text}；{state.error}"
        self._connection_status.setText(text)
        self._connection_status.setStyleSheet(style)

    @Slot()
    def _restart_discovery(self) -> None:
        """设置页修改地址或密钥后重新发现模型并刷新连接状态。"""
        self._connection_status.setText("正在连接网关…")
        self._connection_status.setStyleSheet("")
        self._discovery_controller.refresh()

    def closeEvent(self, event) -> None:
        if self._services.generation.has_unfinished_tasks():
            answer = QMessageBox.question(
                self,
                "确认关闭",
                "仍有排队或生成中的任务，关闭后将停止本地等待。确定关闭吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if answer is not QMessageBox.StandardButton.Yes:
                event.ignore()
                return
        self._services.close()
        event.accept()


def run() -> int:
    app = QApplication.instance() or QApplication([])
    try:
        window = MainWindow()
    except (PresetStoreError, SettingsStoreError) as error:
        QMessageBox.critical(None, "配置不可用", str(error))
        return 1
    window.show()
    return app.exec()
