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
from ..presentation import (
    STAGE_LABELS,
    UI_SUCCESS,
    connection_check_mark,
    format_bytes,
)


class SettingsPage(QWidget):
    """设置页；所有持久化与凭据路由都通过应用服务完成。"""

    status_message = Signal(str)
    output_state_changed = Signal()
    concurrency_changed = Signal(int)
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

        self._base_url_edit = QLineEdit(self._settings.base_url)
        self._base_url_edit.editingFinished.connect(self._apply_base_url)
        self._reset_base_url = QPushButton("恢复默认")
        self._reset_base_url.clicked.connect(self._reset_base_url_clicked)
        base_row = QHBoxLayout()
        base_row.addWidget(self._base_url_edit, 1)
        base_row.addWidget(self._reset_base_url)
        self._base_url_warning = QLabel()
        self._base_url_warning.setWordWrap(True)

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

        self._connection_test = QPushButton("测试网关连接")
        self._connection_test.clicked.connect(self._start_connection_check)
        self._connection_results = QLabel()
        self._connection_results.setWordWrap(True)

        self._diagnostics_status = QLabel()
        self._diagnostics_status.setWordWrap(True)
        self._preview_diagnostics = QPushButton("查看诊断包内容")
        self._preview_diagnostics.clicked.connect(self._show_diagnostics_preview)
        self._export_diagnostics = QPushButton("导出诊断包")
        self._export_diagnostics.clicked.connect(self._export_diagnostics_package)

        layout = QVBoxLayout()
        layout.addWidget(QLabel("输出根目录"))
        layout.addLayout(output_row)
        layout.addWidget(QLabel("团队网关基础地址"))
        layout.addLayout(base_row)
        layout.addWidget(self._base_url_warning)
        layout.addWidget(QLabel("并发上限（1～6，重启后保留）"))
        layout.addWidget(self._settings_concurrency)
        layout.addWidget(QLabel("API 密钥（保存到当前 Windows 用户凭据库）"))
        layout.addLayout(key_row)
        layout.addWidget(self._api_key_status)
        layout.addWidget(QLabel("网关连接测试"))
        layout.addWidget(self._connection_test)
        layout.addWidget(self._connection_results)
        layout.addWidget(QLabel("本地诊断（脱敏日志与诊断包）"))
        layout.addWidget(self._diagnostics_status)
        diagnostics_row = QHBoxLayout()
        diagnostics_row.addWidget(self._preview_diagnostics)
        diagnostics_row.addWidget(self._export_diagnostics)
        diagnostics_row.addStretch(1)
        layout.addLayout(diagnostics_row)
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
            self._base_url_warning.setText(
                "当前地址为明文 HTTP，仅限隔离内网或可信 VPN 使用；非可信网络必须启用 HTTPS。"
            )
            self._base_url_warning.setStyleSheet("color: #c62828;")
        else:
            self._base_url_warning.setText("已启用 HTTPS，可在非可信网络使用。")
            self._base_url_warning.setStyleSheet(f"color: {UI_SUCCESS};")

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
        self.concurrency_changed.emit(value)
        self.status_message.emit(f"并发上限已设置为 {value}")

    def set_concurrency(self, value: int) -> None:
        self._settings_concurrency.blockSignals(True)
        self._settings_concurrency.setValue(value)
        self._settings_concurrency.blockSignals(False)

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
