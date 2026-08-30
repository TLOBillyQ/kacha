"""主窗口：装配应用服务、后台控制器与四个页面组件。"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QObject, QSettings, Qt, Signal, Slot
from PySide6.QtWidgets import (
    QApplication,
    QDockWidget,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
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
from .presentation import (
    UI_BORDER,
    UI_ERROR,
    UI_SUCCESS,
    UI_TEXT_MUTED,
    UI_WARNING,
)

_WINDOW_STATE_KEY = "mainWindow/state"
_RECALL_BADGE_STYLE = f"color: {UI_WARNING}; font-weight: bold;"

_CONNECTION_BANNER_STYLE = f"""
QFrame#connectionBanner {{
    background-color: #fff8e1;
    border: 1px solid {UI_BORDER};
    border-radius: 4px;
}}
"""


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
        # 默认宽度需容纳中央区最小宽度（约 700px）加右侧任务中心面板 340px。
        self.resize(1100, 640)
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
        self._status_dot = QLabel("●")
        self._status_text = QLabel()
        status_indicator = QWidget()
        indicator_layout = QHBoxLayout(status_indicator)
        indicator_layout.setContentsMargins(0, 0, 0, 0)
        indicator_layout.setSpacing(4)
        indicator_layout.addWidget(self._status_dot)
        indicator_layout.addWidget(self._status_text)
        self.statusBar().addPermanentWidget(status_indicator)
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
        self._tabs = QTabWidget()
        self._tabs.addTab(self._text_page, "文生图")
        self._tabs.addTab(self._edit_page, "图片编辑")
        self._tabs.addTab(self._settings_page, "设置")
        self._connection_banner = self._build_connection_banner()
        root = QVBoxLayout()
        root.addWidget(self._connection_banner)
        root.addWidget(self._tabs)
        container = QWidget()
        container.setLayout(root)
        self.setCentralWidget(container)

        # 任务中心改挂右侧 QDockWidget（#30 决议）：可换边/浮动/隐藏，尺寸位置持久化。
        self._dock = QDockWidget("任务中心", self)
        self._dock.setObjectName("taskCenterDock")
        self._dock.setAllowedAreas(
            Qt.DockWidgetArea.LeftDockWidgetArea
            | Qt.DockWidgetArea.RightDockWidgetArea
            | Qt.DockWidgetArea.BottomDockWidgetArea
        )
        self._dock.setFeatures(
            QDockWidget.DockWidgetFeature.DockWidgetMovable
            | QDockWidget.DockWidgetFeature.DockWidgetFloatable
            | QDockWidget.DockWidgetFeature.DockWidgetClosable
        )
        self._dock.setWidget(self._task_center)
        self._dock.visibilityChanged.connect(self._on_dock_visibility)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self._dock)

        self._recall_button = QPushButton("任务中心")
        self._recall_button.setToolTip("显示/隐藏任务中心面板")
        self._recall_button.clicked.connect(self._toggle_task_center_dock)
        self.statusBar().addPermanentWidget(self._recall_button)
        self._events.changed.connect(self._on_task_arrived)

        # 无持久化状态时应用默认尺寸；resizeDocks 需在窗口显示前调用才生效。
        if not self._restore_window_state():
            self._apply_default_dock_size()

    def _build_connection_banner(self) -> QFrame:
        """网关离线或使用缓存模型时上浮的完整提示；正常状态下隐藏。"""
        banner = QFrame()
        banner.setObjectName("connectionBanner")
        banner.setStyleSheet(_CONNECTION_BANNER_STYLE)
        layout = QHBoxLayout(banner)
        layout.setContentsMargins(10, 6, 10, 6)
        self._banner_text = QLabel()
        self._banner_text.setWordWrap(True)
        self._banner_action = QPushButton("前往设置检查连接")
        self._banner_action.clicked.connect(self._open_settings_page)
        layout.addWidget(self._banner_text, 1)
        layout.addWidget(self._banner_action)
        banner.hide()
        return banner

    @Slot()
    def _open_settings_page(self) -> None:
        self._tabs.setCurrentWidget(self._settings_page)

    # ---------------------------------------------------------- 任务中心停靠面板

    def _window_settings(self) -> QSettings:
        return QSettings(
            QSettings.Format.IniFormat,
            QSettings.Scope.UserScope,
            "qinyuanj",
            "ugc-image-tool",
        )

    def _restore_window_state(self) -> bool:
        """恢复用户拖拽后的停靠位置、浮动状态与尺寸；无记录时返回 False。"""
        state = self._window_settings().value(_WINDOW_STATE_KEY)
        if state is None:
            return False
        return self.restoreState(state)

    def _apply_default_dock_size(self) -> None:
        """首次启动（无持久化状态）时默认右侧停靠、宽 340px。"""
        self.resizeDocks([self._dock], [340], Qt.Orientation.Horizontal)

    @Slot()
    def _toggle_task_center_dock(self) -> None:
        self._dock.setVisible(not self._dock.isVisible())

    @Slot(bool)
    def _on_dock_visibility(self, visible: bool) -> None:
        if visible:
            self._recall_button.setText("任务中心")
            self._recall_button.setStyleSheet("")

    @Slot(object)
    def _on_task_arrived(self, _task: object) -> None:
        """面板隐藏时新任务到达：召回按钮高亮，不强制弹出面板。"""
        if not self._dock.isVisible():
            self._recall_button.setText("任务中心 ● 新任务")
            self._recall_button.setStyleSheet(_RECALL_BADGE_STYLE)

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
        """正常状态收进底部状态栏；离线或使用缓存模型时上浮完整提示。"""
        state = self._discovery_controller.state
        if state.pending:
            self._set_status_indicator(UI_TEXT_MUTED, "正在连接网关…")
            self._connection_banner.hide()
            return
        if state.online:
            self._set_status_indicator(UI_SUCCESS, "网关在线")
            self._connection_banner.hide()
            return
        if state.from_cache:
            self._set_status_indicator(UI_WARNING, "使用缓存模型")
            fetched = state.fetched_at
            when = (
                fetched.astimezone().strftime("%Y-%m-%d %H:%M")
                if fetched is not None
                else "未知时间"
            )
            detail = f"正在使用可能过期的缓存模型（获取于 {when}），模型列表可能已过期"
        else:
            self._set_status_indicator(UI_ERROR, "网关离线")
            detail = "无法获取模型列表，暂时无法提交生成任务"
        if state.error:
            detail = f"{detail}；{state.error}"
        self._banner_text.setText(f"网关离线：{detail}。可前往设置检查连接。")
        self._connection_banner.show()

    def _set_status_indicator(self, color: str, text: str) -> None:
        self._status_dot.setStyleSheet(f"color: {color};")
        self._status_text.setText(text)

    @Slot()
    def _restart_discovery(self) -> None:
        """设置页修改地址或密钥后重新发现模型并刷新连接状态。"""
        self._set_status_indicator(UI_TEXT_MUTED, "正在连接网关…")
        self._connection_banner.hide()
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
        self._window_settings().setValue(_WINDOW_STATE_KEY, self.saveState())
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
