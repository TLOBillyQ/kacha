"""设置页：输出目录、网关地址与密钥、并发上限、连接测试与诊断包。"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from PySide6.QtCore import Signal, Slot
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from ...discovery import ConnectionCheck
from ...services import ApplicationServices
from ...settings import (
    DEFAULT_BASE_URL,
    MAX_CONCURRENCY_LIMIT,
    MIN_CONCURRENCY_LIMIT,
    SettingsStoreError,
    default_output_root,
)
from ..controllers.discovery_controller import DiscoveryController
from ..disclosure import CollapsibleSection
from ..presentation import (
    STAGE_LABELS,
    UI_ERROR,
    UI_SUCCESS,
    UI_SPACING,
    connection_check_mark,
    format_bytes,
)


class SettingsPage(QWidget):
    """设置页；所有持久化与凭据路由都通过应用服务完成。"""

    status_message = Signal(str)
    output_state_changed = Signal()
    discovery_restart_requested = Signal()

    def __init__(
        self,
        services: ApplicationServices,
        discovery_controller: DiscoveryController,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._services = services
        self._settings = services.settings
        self._diagnostics = services.diagnostics
        self._diagnostic_exporter = services.diagnostic_exporter
        self._discovery_controller = discovery_controller
        self._build_settings_page()
        self._update_api_key_status()
        self._update_base_url_warning()
        self._update_diagnostics_status()

    def _build_settings_page(self) -> None:
        self._output_root_edit = QLineEdit(str(self._settings.output_root))
        self._output_root_edit.editingFinished.connect(self._apply_output_root)
        self._browse_output = QPushButton("浏览…")
        self._browse_output.clicked.connect(self._browse_output_root)
        self._reset_output = QPushButton("恢复默认")
        self._reset_output.clicked.connect(self._reset_output_root)
        output_row = QHBoxLayout()
        output_row.addWidget(self._output_root_edit, 1)
        output_row.addWidget(self._browse_output)
        output_row.addWidget(self._reset_output)
        self._output_section = QWidget()
        output_layout = QVBoxLayout(self._output_section)
        output_layout.setContentsMargins(0, 0, 0, 0)
        output_layout.setSpacing(UI_SPACING)
        output_layout.addWidget(QLabel("输出根目录"))
        output_layout.addLayout(output_row)

        self._base_url_edit = QLineEdit(self._settings.base_url)
        self._base_url_edit.editingFinished.connect(self._apply_base_url)
        self._reset_base_url = QPushButton("恢复默认")
        self._reset_base_url.clicked.connect(self._reset_base_url_clicked)
        base_row = QHBoxLayout()
        base_row.addWidget(self._base_url_edit, 1)
        base_row.addWidget(self._reset_base_url)
        self._base_url_section = QWidget()
        base_layout = QVBoxLayout(self._base_url_section)
        base_layout.setContentsMargins(0, 0, 0, 0)
        base_layout.setSpacing(UI_SPACING)
        base_layout.addWidget(QLabel("团队网关基础地址"))
        base_layout.addLayout(base_row)

        self._settings_concurrency = QSpinBox()
        self._settings_concurrency.setRange(MIN_CONCURRENCY_LIMIT, MAX_CONCURRENCY_LIMIT)
        self._settings_concurrency.setValue(self._settings.concurrency_limit)
        self._settings_concurrency.valueChanged.connect(self._on_settings_concurrency_changed)

        self._api_key_edit = QLineEdit()
        self._api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self._api_key_edit.setPlaceholderText("输入 API 密钥")
        self._save_api_key = QPushButton("保存密钥")
        self._save_api_key.clicked.connect(self._save_api_key_clicked)
        self._clear_api_key = QPushButton("清除密钥")
        self._clear_api_key.clicked.connect(self._clear_api_key_clicked)
        self._api_key_status = QLabel()
        key_row = QHBoxLayout()
        key_row.addWidget(self._api_key_edit, 1)
        key_row.addWidget(self._save_api_key)
        key_row.addWidget(self._clear_api_key)
        self._api_key_section = QWidget()
        api_key_layout = QVBoxLayout(self._api_key_section)
        api_key_layout.setContentsMargins(0, 0, 0, 0)
        api_key_layout.setSpacing(UI_SPACING)
        api_key_layout.addWidget(QLabel("API 密钥（保存到当前 Windows 用户凭据库）"))
        api_key_layout.addLayout(key_row)
        api_key_layout.addWidget(self._api_key_status)

        self._connection_test = QPushButton("测试网关连接")
        self._connection_test.clicked.connect(self._start_connection_check)
        self._connection_results = QLabel()
        self._connection_results.setWordWrap(True)
        self._connection_test_section = QWidget()
        connection_layout = QVBoxLayout(self._connection_test_section)
        connection_layout.setContentsMargins(0, 0, 0, 0)
        connection_layout.setSpacing(UI_SPACING)
        connection_layout.addWidget(QLabel("网关连接测试"))
        connection_layout.addWidget(self._connection_test)
        connection_layout.addWidget(self._connection_results)

        self._concurrency_section = QWidget()
        concurrency_layout = QVBoxLayout(self._concurrency_section)
        concurrency_layout.setContentsMargins(0, 0, 0, 0)
        concurrency_layout.setSpacing(UI_SPACING)
        concurrency_layout.addWidget(QLabel("并发上限（1～6，修改后立即生效）"))
        concurrency_layout.addWidget(self._settings_concurrency)

        self._diagnostics_status = QLabel()
        self._diagnostics_status.setWordWrap(True)
        self._preview_diagnostics = QPushButton("查看诊断包内容")
        self._preview_diagnostics.clicked.connect(self._show_diagnostics_preview)
        self._export_diagnostics = QPushButton("导出诊断包")
        self._export_diagnostics.clicked.connect(self._export_diagnostics_package)
        diagnostics_row = QHBoxLayout()
        diagnostics_row.addWidget(self._preview_diagnostics)
        diagnostics_row.addWidget(self._export_diagnostics)
        diagnostics_row.addStretch(1)
        self._diagnostics_section = QWidget()
        diagnostics_layout = QVBoxLayout(self._diagnostics_section)
        diagnostics_layout.setContentsMargins(0, 0, 0, 0)
        diagnostics_layout.setSpacing(UI_SPACING)
        diagnostics_layout.addWidget(QLabel("本地诊断（脱敏日志与诊断包）"))
        diagnostics_layout.addWidget(self._diagnostics_status)
        diagnostics_layout.addLayout(diagnostics_row)

        advanced_layout = QVBoxLayout()
        advanced_layout.setContentsMargins(0, 0, 0, 0)
        advanced_layout.setSpacing(UI_SPACING)
        advanced_layout.addWidget(self._base_url_section)
        advanced_layout.addWidget(self._api_key_section)
        advanced_layout.addWidget(self._connection_test_section)
        advanced_layout.addWidget(self._concurrency_section)
        advanced_layout.addWidget(self._diagnostics_section)
        self._advanced_section = CollapsibleSection(
            "高级",
            summary="网关地址、API 密钥、连接测试、并发上限、本地诊断",
            expanded=self._settings.settings_advanced_expanded(),
        )
        self._advanced_section.set_content_layout(advanced_layout)
        self._advanced_section.toggled.connect(
            self._settings.save_settings_advanced_expanded
        )

        self._transport_status_text = QLabel()
        self._transport_status_text.setWordWrap(True)
        self._show_gateway_settings = QPushButton("查看网关设置")
        self._show_gateway_settings.clicked.connect(self._reveal_gateway_settings)
        self._transport_status = QWidget()
        transport_layout = QHBoxLayout(self._transport_status)
        transport_layout.setContentsMargins(0, 0, 0, 0)
        transport_layout.setSpacing(UI_SPACING)
        transport_layout.addWidget(self._transport_status_text, 1)
        transport_layout.addWidget(self._show_gateway_settings)

        layout = QVBoxLayout()
        layout.setSpacing(UI_SPACING)
        layout.addWidget(self._output_section)
        layout.addWidget(self._transport_status)
        layout.addWidget(self._advanced_section)
        layout.addStretch(1)
        self.setLayout(layout)

    # -- 输出根目录 ----------------------------------------------------------

    @Slot()
    def _apply_output_root(self) -> None:
        try:
            self._services.set_output_root(Path(self._output_root_edit.text()))
        except (ValueError, SettingsStoreError) as error:
            self.status_message.emit(str(error))
            self._output_root_edit.setText(str(self._settings.output_root))
            return
        self.output_state_changed.emit()
        self.status_message.emit(f"输出根目录已设置：{self._settings.output_root}")

    @Slot()
    def _browse_output_root(self) -> None:
        directory = QFileDialog.getExistingDirectory(
            self, "选择输出根目录", str(self._settings.output_root)
        )
        if not directory:
            return
        self._output_root_edit.setText(directory)
        self._apply_output_root()

    @Slot()
    def _reset_output_root(self) -> None:
        self._output_root_edit.setText(str(default_output_root()))
        self._apply_output_root()

    # -- 网关地址与密钥 ------------------------------------------------------

    @Slot()
    def _apply_base_url(self) -> None:
        try:
            self._services.set_base_url(self._base_url_edit.text())
        except (ValueError, SettingsStoreError) as error:
            self.status_message.emit(str(error))
            self._base_url_edit.setText(self._settings.base_url)
            return
        self._update_base_url_warning()
        self.discovery_restart_requested.emit()
        self.status_message.emit(f"网关基础地址已保存：{self._settings.base_url}")

    @Slot()
    def _reset_base_url_clicked(self) -> None:
        self._base_url_edit.setText(DEFAULT_BASE_URL)
        self._apply_base_url()

    def _update_base_url_warning(self) -> None:
        if self._settings.uses_plaintext_http:
            self._transport_status_text.setText(
                "当前地址为明文 HTTP，仅限隔离内网或可信 VPN 使用；非可信网络必须启用 HTTPS。"
            )
            self._transport_status_text.setStyleSheet(f"color: {UI_ERROR};")
            self._show_gateway_settings.show()
        else:
            self._transport_status_text.setText("网关传输安全：HTTPS")
            self._transport_status_text.setStyleSheet(f"color: {UI_SUCCESS};")
            self._show_gateway_settings.hide()

    @Slot()
    def _reveal_gateway_settings(self) -> None:
        self._advanced_section.set_expanded(True)
        self._base_url_edit.setFocus()

    @Slot()
    def _save_api_key_clicked(self) -> None:
        try:
            self._services.save_api_key(self._api_key_edit.text())
        except (ValueError, OSError) as error:
            self.status_message.emit(f"保存 API 密钥失败：{error}")
            return
        self._api_key_edit.clear()
        self._update_api_key_status()
        self.discovery_restart_requested.emit()
        self.status_message.emit("API 密钥已保存到当前用户凭据库")

    @Slot()
    def _clear_api_key_clicked(self) -> None:
        try:
            self._services.clear_api_key()
        except OSError as error:
            self.status_message.emit(f"清除 API 密钥失败：{error}")
            return
        self._api_key_edit.clear()
        self._update_api_key_status()
        self.discovery_restart_requested.emit()
        self.status_message.emit("API 密钥已清除")

    def _update_api_key_status(self) -> None:
        if self._settings.api_key is None:
            self._api_key_status.setText("未保存 API 密钥")
            self._api_key_status.setStyleSheet("color: #c62828;")
        else:
            self._api_key_status.setText("已保存 API 密钥")
            self._api_key_status.setStyleSheet(f"color: {UI_SUCCESS};")

    # -- 并发上限 ------------------------------------------------------------

    @Slot(int)
    def _on_settings_concurrency_changed(self, value: int) -> None:
        try:
            self._services.set_concurrency_limit(value)
        except ValueError as error:
            self.status_message.emit(str(error))
            return
        self.status_message.emit(f"并发上限已设置为 {value}")

    # -- 连接测试 ------------------------------------------------------------

    @Slot()
    def _start_connection_check(self) -> None:
        self._connection_test.setEnabled(False)
        self._connection_results.setText("正在检查网关连接…")
        self._discovery_controller.run_connection_check()

    @Slot(object)
    def show_connection_check(self, checks: tuple[ConnectionCheck, ...]) -> None:
        self._connection_test.setEnabled(True)
        lines = []
        for check in checks:
            lines.append(
                f"{STAGE_LABELS[check.stage]}：{connection_check_mark(check.ok)}"
                f" — {check.message}"
            )
        self._connection_results.setText("\n".join(lines))

    # -- 诊断包 --------------------------------------------------------------

    def _update_diagnostics_status(self) -> None:
        total = self._diagnostics.total_bytes
        segments = len(self._diagnostics.segments())
        self._diagnostics_status.setText(
            f"日志位置：{self._diagnostics.directory}\n"
            f"当前占用 {format_bytes(total)}，"
            f"总容量上限 {format_bytes(self._diagnostics.max_total_bytes)}（"
            f"{segments} 个日志文件，超出后自动删除最旧日志）。\n"
            "日志只记录定位所需的时间、版本、任务编号、模型、状态码、网关请求"
            "编号、状态迁移与脱敏错误类别，不包含密钥、认证头、图片内容、完整"
            "提示词或临时下载地址。"
        )

    @Slot()
    def _show_diagnostics_preview(self) -> None:
        entries = self._diagnostic_exporter.preview()
        if not entries:
            QMessageBox.information(self, "诊断包内容", "当前没有任何日志文件")
            return
        lines = [
            "导出诊断包时将只包含以下文件；不会收集任务记录、设置、凭据、图片"
            "或提示词等额外用户数据：",
            "",
        ]
        for entry in entries:
            lines.append(
                f"• {entry.name}（{format_bytes(entry.size)}）—— {entry.description}"
            )
        QMessageBox.information(self, "诊断包内容（导出前清单）", "\n".join(lines))

    @Slot()
    def _export_diagnostics_package(self) -> None:
        default_name = (
            f"ugc-image-tool-diagnostics-"
            f"{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
        )
        target_name, _ = QFileDialog.getSaveFileName(
            self,
            "导出诊断包",
            default_name,
            "ZIP 压缩包 (*.zip);;所有文件 (*)",
        )
        if not target_name:
            return
        target = Path(target_name)
        try:
            entries = self._diagnostic_exporter.export(target)
        except OSError as error:
            QMessageBox.warning(self, "导出诊断包失败", f"无法导出诊断包：{error}")
            return
        self._diagnostics.system("诊断包已导出")
        self._update_diagnostics_status()
        self.status_message.emit(
            f"诊断包已导出：{target}（含 {len(entries)} 个文件）"
        )
