from __future__ import annotations

import os
import shutil
from datetime import datetime
from pathlib import Path
from threading import Thread
from typing import cast

from PySide6.QtCore import QObject, QUrl, Qt, Signal, Slot
from PySide6.QtGui import QDesktopServices, QIcon, QPixmap, QStandardItemModel
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QTextEdit,
    QInputDialog,
    QVBoxLayout,
    QWidget,
    QFileDialog,
    QTabWidget,
)

from .application import GenerationApplication
from .capabilities import CapabilityRegistry, Workflow
from .diagnostics import DiagnosticExporter, DiagnosticLogger
from .discovery import (
    ConnectionCheck,
    ConnectionStage,
    DiscoveryState,
    ModelCache,
    ModelDiscovery,
    run_connection_check,
)
from .generation import (
    GenerationStatus,
    GenerationTask,
    ImageEditDraft,
    SizeMode,
    TextToImageDraft,
    draft_errors,
)
from .results import FileResultRepository
from .references import inspect_reference_image
from .simulated_gateway import SimulatedGateway
from .settings import (
    DEFAULT_BASE_URL,
    MAX_CONCURRENCY_LIMIT,
    MIN_CONCURRENCY_LIMIT,
    CredentialService,
    MemoryCredentialService,
    SettingsApplication,
    SettingsStore,
    SettingsStoreError,
    WindowsCredentialService,
    default_output_root,
)
from .presets import (
    PresetProject,
    PresetApplication,
    PresetStore,
    PresetStoreError,
    ProjectPreset,
)

_STATUS_LABELS = {
    GenerationStatus.QUEUED: "排队中",
    GenerationStatus.RUNNING: "生成中",
    GenerationStatus.SUCCEEDED: "成功",
    GenerationStatus.PARTIALLY_SUCCEEDED: "部分成功",
    GenerationStatus.FAILED: "失败",
    GenerationStatus.UNKNOWN: "结果未知",
    GenerationStatus.CANCELLED: "已取消",
}

_CUSTOM_SIZE_LABEL = "自定义…"

_STAGE_LABELS = {
    ConnectionStage.DNS_OR_CONNECT: "DNS/连接",
    ConnectionStage.AUTH: "鉴权",
    ConnectionStage.MODEL_LIST: "模型列表",
    ConnectionStage.CAPABILITY: "能力匹配",
}


def _format_bytes(size: int) -> str:
    """把字节数格式化为可读文本；日志容量通常不超过 1 MB。"""
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size} B"


class _TaskEvents(QObject):
    changed = Signal(object)


class _DiscoveryEvents(QObject):
    discovered = Signal(object)
    checked = Signal(object)


class _ReferenceListWidget(QListWidget):
    files_dropped = Signal(list)

    def __init__(self) -> None:
        super().__init__()
        self.setAcceptDrops(True)
        self.setDragDropMode(QListWidget.DragDropMode.InternalMove)

    def dragEnterEvent(self, event) -> None:
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragEnterEvent(event)

    def dropEvent(self, event) -> None:
        urls = event.mimeData().urls()
        if urls:
            self.files_dropped.emit([url.toLocalFile() for url in urls if url.isLocalFile()])
            event.acceptProposedAction()
        else:
            super().dropEvent(event)


class MainWindow(QMainWindow):
    def __init__(
        self,
        output_root: Path | None = None,
        capabilities: CapabilityRegistry | None = None,
        preset_store: PresetStore | None = None,
        user_data_dir: Path | None = None,
        settings: SettingsApplication | None = None,
        credentials: CredentialService | None = None,
    ) -> None:
        super().__init__()
        self.setWindowTitle("UGC AI 生图工具")
        self.resize(900, 620)
        self._events = _TaskEvents()
        self._events.changed.connect(self._update_task)
        self._capabilities = capabilities or CapabilityRegistry()
        self._preset_application = PresetApplication(
            preset_store or PresetStore(user_data_dir)
        )
        if settings is None:
            credential_service = credentials
            if credential_service is None:
                credential_service = (
                    WindowsCredentialService() if os.name == "nt" else MemoryCredentialService()
                )
            settings = SettingsApplication(SettingsStore(user_data_dir), credential_service)
        self._settings = settings
        if output_root is not None:
            self._settings.set_output_root(output_root)
        self._diagnostics = DiagnosticLogger(user_data_dir)
        self._diagnostics.system("应用启动")
        self._results = FileResultRepository(
            self._settings.output_root,
            diagnostics=self._diagnostics,
        )
        self._updating_prompt_controls = False
        self._gateway = SimulatedGateway()
        self._discovery_events = _DiscoveryEvents()
        self._discovery_events.discovered.connect(self._on_discovery_state)
        self._discovery_events.checked.connect(self._show_connection_check)
        self._discovery = ModelDiscovery(
            self._gateway,
            cache=ModelCache(user_data_dir),
            diagnostics=self._diagnostics,
        )
        self._application = GenerationApplication(
            gateway=self._gateway,
            results=self._results,
            capabilities=self._capabilities,
            on_task_changed=self._events.changed.emit,
            max_concurrency=self._settings.concurrency_limit,
            submission_guard=self._submission_guard,
            diagnostics=self._diagnostics,
        )
        self._diagnostic_exporter = DiagnosticExporter(user_data_dir)
        self._tasks: dict[str, GenerationTask] = {}
        self._removed_task_ids: set[str] = set()
        self._selected_task_id: str | None = None
        self._has_configured_models = False
        self._has_edit_models = False
        self._draft_count = 1
        self._output_error: str | None = None
        self._connection_status = QLabel("正在连接网关…")
        self._connection_status.setWordWrap(True)
        self._build_form()
        self._build_edit_form()
        self._build_settings_page()
        self._build_task_center()
        self._populate_presets()
        self._refresh_output_state()
        self._revalidate()
        self._update_connection_status()
        self._start_discovery()

    def _build_form(self) -> None:
        self._model_combo = QComboBox()
        self._model_combo.currentIndexChanged.connect(self._on_model_changed)

        self._prompt = QTextEdit()
        self._prompt.setPlaceholderText("输入正向提示词")
        self._prompt.textChanged.connect(self._on_prompt_changed)

        self._negative_prompt = QTextEdit()
        self._negative_prompt.setPlaceholderText("输入负向提示词（可留空）")
        self._negative_prompt.textChanged.connect(self._on_prompt_changed)

        self._preset_combo = QComboBox()
        self._preset_combo.setPlaceholderText("选择项目预设")
        self._preset_combo.currentIndexChanged.connect(self._update_preset_actions)
        self._apply_preset = QPushButton("应用项目预设")
        self._apply_preset.clicked.connect(self._apply_selected_preset)
        self._copy_preset = QPushButton("复制为个人预设")
        self._copy_preset.clicked.connect(self._copy_selected_preset)
        self._save_preset = QPushButton("新建个人预设")
        self._save_preset.clicked.connect(self._save_personal_preset)
        self._edit_preset = QPushButton("编辑个人预设")
        self._edit_preset.clicked.connect(self._edit_selected_preset)
        self._delete_preset = QPushButton("删除个人预设")
        self._delete_preset.clicked.connect(self._delete_selected_preset)

        self._size_combo = QComboBox()
        self._size_combo.currentIndexChanged.connect(self._on_size_mode_changed)

        self._width_box = QSpinBox()
        self._width_box.setRange(1, 16384)
        self._width_box.setValue(1024)
        self._width_box.valueChanged.connect(self._revalidate)
        self._height_box = QSpinBox()
        self._height_box.setRange(1, 16384)
        self._height_box.setValue(1024)
        self._height_box.valueChanged.connect(self._revalidate)

        self._count_box = QSpinBox()
        self._count_box.setRange(1, 1)
        self._count_box.valueChanged.connect(self._on_count_changed)

        self._validation_label = QLabel()
        self._validation_label.setStyleSheet("color: #c62828;")
        self._validation_label.setWordWrap(True)

        self._submit = QPushButton("提交生成")
        self._submit.clicked.connect(self._submit_prompt)

        size_row = QHBoxLayout()
        size_row.addWidget(self._size_combo, 1)
        size_row.addWidget(QLabel("宽"))
        size_row.addWidget(self._width_box)
        size_row.addWidget(QLabel("高"))
        size_row.addWidget(self._height_box)
        size_row.addWidget(QLabel("出图数量"))
        size_row.addWidget(self._count_box)
        size_row.addStretch(1)

        layout = QVBoxLayout()
        layout.addWidget(QLabel("模型"))
        layout.addWidget(self._model_combo)
        preset_row = QHBoxLayout()
        preset_row.addWidget(self._preset_combo, 1)
        preset_row.addWidget(self._apply_preset)
        preset_row.addWidget(self._copy_preset)
        preset_row.addWidget(self._save_preset)
        preset_row.addWidget(self._edit_preset)
        preset_row.addWidget(self._delete_preset)
        layout.addWidget(QLabel("项目预设"))
        layout.addLayout(preset_row)
        layout.addWidget(QLabel("文生图"))
        layout.addWidget(self._prompt)
        layout.addWidget(self._negative_prompt)
        layout.addWidget(QLabel("生成尺寸"))
        layout.addLayout(size_row)
        layout.addWidget(self._validation_label)
        layout.addWidget(self._submit)
        self._form_container = QWidget()
        self._form_container.setLayout(layout)

    def _populate_presets(self) -> None:
        selected_id = self._preset_combo.currentData()
        self._preset_combo.blockSignals(True)
        self._preset_combo.clear()
        for project, presets in self._preset_application.grouped_presets().items():
            self._preset_combo.addItem(project.display_name)
            model = cast(QStandardItemModel, self._preset_combo.model())
            header = model.item(self._preset_combo.count() - 1)
            if header is not None:
                header.setEnabled(False)
            for preset in presets:
                source = "内置" if preset.read_only else "个人"
                self._preset_combo.addItem(
                    f"  {preset.display_name}（{source}）",
                    preset.preset_id,
                )
        restored = -1
        if isinstance(selected_id, str):
            for index in range(self._preset_combo.count()):
                if self._preset_combo.itemData(index) == selected_id:
                    restored = index
                    break
        self._preset_combo.setCurrentIndex(restored)
        self._preset_combo.blockSignals(False)
        self._update_preset_actions()

    def _selected_preset(self) -> ProjectPreset | None:
        preset_id = self._preset_combo.currentData()
        if not isinstance(preset_id, str):
            return None
        return self._preset_application.get(preset_id)

    @Slot(int)
    def _update_preset_actions(self, _index: int = -1) -> None:
        preset = self._selected_preset()
        self._apply_preset.setEnabled(preset is not None)
        self._copy_preset.setEnabled(preset is not None and preset.read_only)
        self._edit_preset.setEnabled(preset is not None and not preset.read_only)
        self._delete_preset.setEnabled(preset is not None and not preset.read_only)

    @Slot()
    def _on_prompt_changed(self) -> None:
        if not self._updating_prompt_controls:
            self._preset_application.update_prompt(
                self._prompt.toPlainText(),
                self._negative_prompt.toPlainText() or None,
            )
        self._revalidate()

    def _set_prompt_values(self) -> None:
        values = self._preset_application.prompt_values
        self._updating_prompt_controls = True
        self._prompt.blockSignals(True)
        self._negative_prompt.blockSignals(True)
        try:
            self._prompt.setPlainText(values.prompt)
            self._negative_prompt.setPlainText(values.negative_prompt or "")
        finally:
            self._negative_prompt.blockSignals(False)
            self._prompt.blockSignals(False)
            self._updating_prompt_controls = False
        self._revalidate()

    def _confirm_discard_prompt_changes(self) -> bool:
        answer = QMessageBox.question(
            self,
            "确认应用预设",
            "当前提示词有未提交修改，应用预设会覆盖这些修改。确定继续吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        return answer is QMessageBox.StandardButton.Yes

    @Slot()
    def _apply_selected_preset(self) -> None:
        preset = self._selected_preset()
        if preset is None:
            return
        if not self._preset_application.apply_preset(
            preset.preset_id,
            confirm_discard=self._confirm_discard_prompt_changes,
        ):
            self.statusBar().showMessage("已取消应用项目预设")
            return
        self._set_prompt_values()
        self.statusBar().showMessage(f"已应用项目预设：{preset.display_name}")

    @Slot()
    def _save_personal_preset(self) -> None:
        name, accepted = QInputDialog.getText(self, "新建个人预设", "显示名称")
        if not accepted:
            return
        project_name, accepted = QInputDialog.getItem(
            self,
            "选择项目",
            "项目",
            [project.display_name for project in PresetProject],
            0,
            False,
        )
        if not accepted:
            return
        project = next(project for project in PresetProject if project.display_name == project_name)
        try:
            preset = self._preset_application.create_personal(
                name,
                project,
                self._prompt.toPlainText(),
                self._negative_prompt.toPlainText() or None,
            )
        except (ValueError, PresetStoreError) as error:
            self.statusBar().showMessage(f"新建个人预设失败：{error}")
            return
        self._populate_presets()
        self._select_preset(preset.preset_id)
        self.statusBar().showMessage(f"个人预设已保存：{preset.display_name}")

    @Slot()
    def _copy_selected_preset(self) -> None:
        source = self._selected_preset()
        if source is None:
            return
        name, accepted = QInputDialog.getText(
            self,
            "复制为个人预设",
            "显示名称",
            text=source.display_name,
        )
        if not accepted:
            return
        try:
            preset = self._preset_application.copy_builtin_as_personal(source.preset_id, name)
        except (ValueError, PresetStoreError, KeyError) as error:
            self.statusBar().showMessage(f"复制个人预设失败：{error}")
            return
        self._populate_presets()
        self._select_preset(preset.preset_id)
        self.statusBar().showMessage(f"个人预设已创建：{preset.display_name}")

    @Slot()
    def _edit_selected_preset(self) -> None:
        source = self._selected_preset()
        if source is None or source.read_only:
            return
        name, accepted = QInputDialog.getText(
            self,
            "编辑个人预设",
            "显示名称",
            text=source.display_name,
        )
        if not accepted:
            return
        try:
            preset = self._preset_application.update_personal(
                source.preset_id,
                display_name=name,
                prompt=self._prompt.toPlainText(),
                negative_prompt=self._negative_prompt.toPlainText() or None,
            )
        except (ValueError, PresetStoreError, KeyError) as error:
            self.statusBar().showMessage(f"编辑个人预设失败：{error}")
            return
        self._populate_presets()
        self._select_preset(preset.preset_id)
        self.statusBar().showMessage(f"个人预设已更新：{preset.display_name}")

    @Slot()
    def _delete_selected_preset(self) -> None:
        preset = self._selected_preset()
        if preset is None or preset.read_only:
            return
        answer = QMessageBox.question(
            self,
            "删除个人预设",
            f"确定删除个人预设“{preset.display_name}”吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer is not QMessageBox.StandardButton.Yes:
            return
        try:
            self._preset_application.delete_personal(preset.preset_id)
        except (KeyError, PermissionError, PresetStoreError) as error:
            self.statusBar().showMessage(f"删除个人预设失败：{error}")
            return
        self._populate_presets()
        self.statusBar().showMessage(f"个人预设已删除：{preset.display_name}")

    def _select_preset(self, preset_id: str) -> None:
        for index in range(self._preset_combo.count()):
            if self._preset_combo.itemData(index) == preset_id:
                self._preset_combo.setCurrentIndex(index)
                return

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
        self._settings_container = QWidget()
        self._settings_container.setLayout(layout)
        self._update_api_key_status()
        self._update_base_url_warning()
        self._update_diagnostics_status()

    @Slot()
    def _apply_output_root(self) -> None:
        try:
            self._settings.set_output_root(Path(self._output_root_edit.text()))
        except (ValueError, SettingsStoreError) as error:
            self.statusBar().showMessage(str(error))
            self._output_root_edit.setText(str(self._settings.output_root))
            return
        self._results.output_root = self._settings.output_root
        self._refresh_output_state()
        self.statusBar().showMessage(f"输出根目录已设置：{self._settings.output_root}")

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

    @Slot()
    def _apply_base_url(self) -> None:
        try:
            self._settings.set_base_url(self._base_url_edit.text())
        except (ValueError, SettingsStoreError) as error:
            self.statusBar().showMessage(str(error))
            self._base_url_edit.setText(self._settings.base_url)
            return
        self._update_base_url_warning()
        self.statusBar().showMessage("网关基础地址已保存")

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
            self._base_url_warning.setStyleSheet("color: #2e7d32;")

    @Slot(int)
    def _on_settings_concurrency_changed(self, value: int) -> None:
        try:
            self._settings.set_concurrency_limit(value)
            self._application.set_concurrency_limit(value)
        except ValueError as error:
            self.statusBar().showMessage(str(error))
            return
        self._sync_concurrency_controls(value)
        self.statusBar().showMessage(f"并发上限已设置为 {value}")

    def _sync_concurrency_controls(self, value: int) -> None:
        self._concurrency_box.blockSignals(True)
        self._concurrency_box.setValue(value)
        self._concurrency_box.blockSignals(False)
        self._settings_concurrency.blockSignals(True)
        self._settings_concurrency.setValue(value)
        self._settings_concurrency.blockSignals(False)

    @Slot()
    def _save_api_key_clicked(self) -> None:
        try:
            self._settings.save_api_key(self._api_key_edit.text())
        except (ValueError, OSError) as error:
            self.statusBar().showMessage(f"保存 API 密钥失败：{error}")
            return
        self._api_key_edit.clear()
        self._update_api_key_status()
        self.statusBar().showMessage("API 密钥已保存到当前用户凭据库")

    @Slot()
    def _clear_api_key_clicked(self) -> None:
        try:
            self._settings.clear_api_key()
        except OSError as error:
            self.statusBar().showMessage(f"清除 API 密钥失败：{error}")
            return
        self._api_key_edit.clear()
        self._update_api_key_status()
        self.statusBar().showMessage("API 密钥已清除")

    def _update_api_key_status(self) -> None:
        if self._settings.api_key is None:
            self._api_key_status.setText("未保存 API 密钥")
            self._api_key_status.setStyleSheet("color: #c62828;")
        else:
            self._api_key_status.setText("已保存 API 密钥")
            self._api_key_status.setStyleSheet("color: #2e7d32;")

    def _submission_guard(self) -> str | None:
        # 提交时重新探测：会话中途目录变不可写（如磁盘被移除）时仍能拦截提交；
        # 网关离线或尚未完成发现时同样阻止提交，且不会创建离线排队任务。
        output_error = self._settings.output_directory_error()
        if output_error:
            return output_error
        return self._discovery.submission_block_reason()

    def _refresh_output_state(self) -> None:
        self._output_error = self._settings.output_directory_error()
        self._revalidate()
        self._update_submit_state()

    def _update_submit_state(self) -> None:
        """网关离线或输出目录不可写时禁用提交，避免创建排队任务。"""
        block = self._submission_guard()
        self._edit_edit_submit.setEnabled(block is None and self._has_edit_models)
        if block is not None:
            self._submit.setEnabled(False)

    def _update_connection_status(self) -> None:
        state = self._discovery.state
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

    def _start_discovery(self) -> None:
        Thread(target=self._refresh_discovery, name="model-discovery", daemon=True).start()

    def _refresh_discovery(self) -> None:
        state = self._discovery.refresh()
        self._discovery_events.discovered.emit(state)

    @Slot(object)
    def _on_discovery_state(self, state: DiscoveryState) -> None:
        self._populate_models(state.model_ids)
        self._populate_edit_models(state.model_ids)
        self._update_connection_status()

    @Slot()
    def _start_connection_check(self) -> None:
        self._connection_test.setEnabled(False)
        self._connection_results.setText("正在检查网关连接…")
        Thread(target=self._run_connection_check, name="connection-check", daemon=True).start()

    def _run_connection_check(self) -> None:
        checks = run_connection_check(
            self._gateway,
            self._capabilities,
            self._diagnostics,
        )
        self._discovery_events.checked.emit(checks)

    @Slot(object)
    def _show_connection_check(self, checks: tuple[ConnectionCheck, ...]) -> None:
        self._connection_test.setEnabled(True)
        lines = []
        for check in checks:
            if check.ok is True:
                mark = "通过"
            elif check.ok is False:
                mark = "失败"
            else:
                mark = "跳过"
            lines.append(f"{_STAGE_LABELS[check.stage]}：{mark} — {check.message}")
        self._connection_results.setText("\n".join(lines))

    def _update_diagnostics_status(self) -> None:
        total = self._diagnostics.total_bytes
        segments = len(self._diagnostics.segments())
        self._diagnostics_status.setText(
            f"日志位置：{self._diagnostics.directory}\n"
            f"当前占用 {_format_bytes(total)}，"
            f"总容量上限 {_format_bytes(self._diagnostics.max_total_bytes)}（"
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
                f"• {entry.name}（{_format_bytes(entry.size)}）—— {entry.description}"
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
        self.statusBar().showMessage(
            f"诊断包已导出：{target}（含 {len(entries)} 个文件）"
        )

    def _build_task_center(self) -> None:
        self._task_list = QListWidget()
        self._task_list.currentRowChanged.connect(self._show_selected_result)
        self._result_list = QListWidget()
        self._result_list.currentRowChanged.connect(self._show_selected_image)
        self._preview = QLabel("提交任务后显示生成结果")
        self._preview.setMinimumSize(320, 320)
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self._concurrency_box = QSpinBox()
        self._concurrency_box.setRange(1, 6)
        self._concurrency_box.setValue(self._application.max_concurrency)
        self._concurrency_box.valueChanged.connect(self._on_concurrency_changed)
        self._cancel_task = QPushButton("取消选中任务")
        self._cancel_task.clicked.connect(self._cancel_selected_task)
        self._remove_task = QPushButton("从任务中心移除")
        self._remove_task.clicked.connect(self._remove_selected_task)
        self._save_copy = QPushButton("保存副本")
        self._save_copy.clicked.connect(self._save_selected_copy)
        self._copy_image = QPushButton("复制图片")
        self._copy_image.clicked.connect(self._copy_selected_image)
        self._open_directory = QPushButton("打开所在目录")
        self._open_directory.clicked.connect(self._open_selected_directory)
        controls = QHBoxLayout()
        controls.addWidget(QLabel("并发上限"))
        controls.addWidget(self._concurrency_box)
        controls.addWidget(self._cancel_task)
        controls.addWidget(self._remove_task)
        controls.addWidget(self._save_copy)
        controls.addWidget(self._copy_image)
        controls.addWidget(self._open_directory)
        controls.addStretch(1)

        layout = QVBoxLayout()
        layout.addWidget(QLabel("任务中心"))
        layout.addLayout(controls)
        layout.addWidget(self._task_list)
        layout.addWidget(QLabel("生成结果（选择一张进行操作）"))
        layout.addWidget(self._result_list)
        layout.addWidget(self._preview)
        task_container = QWidget()
        task_container.setLayout(layout)

        tabs = QTabWidget()
        tabs.addTab(self._form_container, "文生图")
        tabs.addTab(self._edit_form_container, "图片编辑")
        tabs.addTab(self._settings_container, "设置")
        root = QVBoxLayout()
        root.addWidget(self._connection_status)
        root.addWidget(tabs)
        root.addWidget(task_container)
        container = QWidget()
        container.setLayout(root)
        self.setCentralWidget(container)
        self._update_result_actions()

    def _build_edit_form(self) -> None:
        self._edit_model_combo = QComboBox()
        self._edit_model_combo.currentIndexChanged.connect(self._on_edit_model_changed)
        self._edit_prompt = QTextEdit()
        self._edit_prompt.setPlaceholderText("输入图片编辑提示词")
        self._edit_negative_prompt = QTextEdit()
        self._edit_negative_prompt.setPlaceholderText("输入负向提示词（可留空）")
        self._edit_size_combo = QComboBox()
        self._edit_size_combo.currentIndexChanged.connect(self._on_edit_size_changed)
        self._edit_width_box = QSpinBox()
        self._edit_width_box.setRange(1, 16384)
        self._edit_height_box = QSpinBox()
        self._edit_height_box.setRange(1, 16384)
        self._edit_references = _ReferenceListWidget()
        self._edit_references.files_dropped.connect(self._add_edit_paths)
        self._edit_references.model().rowsMoved.connect(lambda *_: self._renumber_references())
        self._edit_references.setToolTip("拖动条目可调整参考图顺序")
        self._edit_add = QPushButton("添加 PNG/JPEG 参考图")
        self._edit_add.clicked.connect(self._choose_edit_references)
        self._edit_count = QSpinBox()
        self._edit_count.setRange(1, 2)
        self._edit_edit_submit = QPushButton("提交图片编辑")
        self._edit_edit_submit.clicked.connect(self._submit_edit)
        self._edit_validation = QLabel()
        self._edit_validation.setWordWrap(True)
        self._edit_warnings = QLabel()
        self._edit_warnings.setWordWrap(True)
        self._edit_warnings.setStyleSheet("color: #996c00;")
        layout = QVBoxLayout()
        layout.addWidget(QLabel("支持图片编辑的模型"))
        layout.addWidget(self._edit_model_combo)
        layout.addWidget(self._edit_prompt)
        layout.addWidget(self._edit_negative_prompt)
        size_row = QHBoxLayout()
        size_row.addWidget(self._edit_size_combo, 1)
        size_row.addWidget(QLabel("宽"))
        size_row.addWidget(self._edit_width_box)
        size_row.addWidget(QLabel("高"))
        size_row.addWidget(self._edit_height_box)
        layout.addLayout(size_row)
        layout.addWidget(self._edit_references)
        controls = QHBoxLayout()
        controls.addWidget(self._edit_add)
        controls.addWidget(QLabel("出图数量"))
        controls.addWidget(self._edit_count)
        controls.addStretch(1)
        layout.addLayout(controls)
        layout.addWidget(self._edit_warnings)
        layout.addWidget(self._edit_validation)
        layout.addWidget(self._edit_edit_submit)
        self._edit_form_container = QWidget()
        self._edit_form_container.setLayout(layout)

    def _populate_edit_models(self, gateway_model_ids: tuple[str, ...]) -> None:
        selected_id = self._edit_model_combo.currentData()
        self._edit_model_combo.blockSignals(True)
        self._edit_model_combo.clear()
        added = 0
        for entry in self._capabilities.merge(gateway_model_ids):
            capability = entry.capability
            if capability is None or Workflow.IMAGE_EDIT not in capability.workflows:
                continue
            self._edit_model_combo.addItem(
                f"{entry.model_id}（{capability.display_name}）", entry.model_id
            )
            added += 1
        self._has_edit_models = added > 0
        if isinstance(selected_id, str):
            for index in range(self._edit_model_combo.count()):
                if self._edit_model_combo.itemData(index) == selected_id:
                    self._edit_model_combo.setCurrentIndex(index)
                    break
        self._edit_model_combo.blockSignals(False)
        self._on_edit_model_changed(self._edit_model_combo.currentIndex())
        self._update_submit_state()

    @Slot(int)
    def _on_edit_model_changed(self, index: int) -> None:
        capability = self._capabilities.capability(self._edit_model_combo.itemData(index))
        self._edit_negative_prompt.setVisible(
            capability is not None and capability.supports_negative_prompt
        )
        if capability is None:
            return
        self._edit_count.setRange(capability.min_images, capability.max_images)
        self._edit_size_combo.clear()
        if capability.size.auto_allowed:
            self._edit_size_combo.addItem("模型自动决定", (SizeMode.AUTO, None))
        for width, height in capability.size.presets:
            self._edit_size_combo.addItem(f"{width}×{height}", (SizeMode.PRESET, (width, height)))
        self._edit_size_combo.addItem("自定义…", (SizeMode.CUSTOM, None))
        self._edit_size_combo.setCurrentIndex(0)
        self._on_edit_size_changed()

    @Slot()
    def _on_edit_size_changed(self) -> None:
        data = self._edit_size_combo.currentData()
        self._edit_width_box.setVisible(data is not None and data[0] is SizeMode.CUSTOM)
        self._edit_height_box.setVisible(data is not None and data[0] is SizeMode.CUSTOM)
        if data is not None and data[0] is SizeMode.PRESET:
            self._edit_width_box.setValue(data[1][0])
            self._edit_height_box.setValue(data[1][1])

    @Slot()
    def _choose_edit_references(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择参考图", "", "图片 (*.png *.jpg *.jpeg)"
        )
        self._add_edit_paths(paths)

    def _add_edit_paths(self, paths: list[str]) -> None:
        existing = [self._edit_references.item(i).data(Qt.ItemDataRole.UserRole) for i in range(self._edit_references.count())]
        for path in paths:
            if path in existing or self._edit_references.count() >= 3:
                continue
            try:
                reference = inspect_reference_image(Path(path))
            except ValueError as error:
                self._edit_validation.setText(str(error))
                continue
            item = QListWidgetItem(QIcon(str(path)), f"{self._edit_references.count() + 1}. {Path(path).name}")
            item.setData(Qt.ItemDataRole.UserRole, path)
            item.setToolTip("；".join(reference.warnings) or "尺寸正常")
            self._edit_references.addItem(item)
        self._renumber_references()
        warnings = [
            self._edit_references.item(index).toolTip()
            for index in range(self._edit_references.count())
            if self._edit_references.item(index).toolTip() != "尺寸正常"
        ]
        self._edit_warnings.setText("；".join(warnings))

    def _renumber_references(self) -> None:
        for index in range(self._edit_references.count()):
            item = self._edit_references.item(index)
            item.setText(f"{index + 1}. {Path(item.data(Qt.ItemDataRole.UserRole)).name}")
        data = self._edit_size_combo.currentData()
        if self._edit_references.count() > 1 and (data is None or data[0] is SizeMode.AUTO):
            self._edit_validation.setText("多张参考图使用模型自动决定尺寸时，最后一张参考图会影响默认输出宽高比")

    @Slot()
    def _submit_edit(self) -> None:
        if self._output_error:
            self._edit_validation.setText(self._output_error)
            return
        self._renumber_references()
        size_data = self._edit_size_combo.currentData()
        size_mode = size_data[0] if size_data is not None else SizeMode.AUTO
        size_width = size_height = None
        if size_mode is SizeMode.CUSTOM:
            size_width, size_height = self._edit_width_box.value(), self._edit_height_box.value()
        elif size_mode is SizeMode.PRESET and size_data is not None:
            size_width, size_height = size_data[1]
        try:
            self._application.submit_edit(
                ImageEditDraft(
                    prompt=self._edit_prompt.toPlainText(),
                    negative_prompt=self._edit_negative_prompt.toPlainText() or None,
                    model_id=self._edit_model_combo.currentData(),
                    size_mode=size_mode,
                    size_width=size_width,
                    size_height=size_height,
                    image_count=self._edit_count.value(),
                    reference_paths=tuple(
                        Path(self._edit_references.item(i).data(Qt.ItemDataRole.UserRole))
                        for i in range(self._edit_references.count())
                    ),
                )
            )
        except ValueError as error:
            self._edit_validation.setText(str(error))

    def _populate_models(self, gateway_model_ids: tuple[str, ...]) -> None:
        selected_id = self._model_combo.currentData()
        enabled_indices: list[int] = []
        self._model_combo.blockSignals(True)
        self._model_combo.clear()
        for entry in self._capabilities.merge(gateway_model_ids):
            capability = entry.capability
            if capability is not None and Workflow.TEXT_TO_IMAGE not in capability.workflows:
                continue  # 文生图页不展示不支持文生图的模型
            if capability is not None:
                label = f"{entry.model_id}（{capability.display_name}）"
                enabled = True
            else:
                label = f"{entry.model_id}（未配置）"
                enabled = False
            self._model_combo.addItem(label, entry.model_id)
            index = self._model_combo.count() - 1
            if not enabled:
                model = cast(QStandardItemModel, self._model_combo.model())
                model.item(index).setEnabled(False)
            else:
                enabled_indices.append(index)
        self._has_configured_models = bool(enabled_indices)
        if isinstance(selected_id, str):
            for index in range(self._model_combo.count()):
                if self._model_combo.itemData(index) == selected_id:
                    self._model_combo.setCurrentIndex(index)
                    break
        elif enabled_indices:
            self._model_combo.setCurrentIndex(enabled_indices[0])
        self._model_combo.blockSignals(False)
        self._on_model_changed(self._model_combo.currentIndex())
        self._update_submit_state()

    @Slot(int)
    def _on_model_changed(self, index: int) -> None:
        capability = self._capabilities.capability(self._model_combo.itemData(index))
        self._negative_prompt.setVisible(
            capability is not None and capability.supports_negative_prompt
        )
        min_count = capability.min_images if capability is not None else 1
        max_count = capability.max_images if capability is not None else 1
        # 保留草稿出图数量：超出新模型范围时按边界显示，切回原模型后恢复。
        self._count_box.blockSignals(True)
        self._count_box.setRange(min_count, max_count)
        self._count_box.setValue(min(max(self._draft_count, min_count), max_count))
        self._count_box.blockSignals(False)
        if capability is None:
            self._size_combo.clear()
            self._revalidate()
            return
        self._refresh_size_controls(capability)
        self._revalidate()

    @Slot(int)
    def _on_count_changed(self, value: int) -> None:
        self._draft_count = value
        self._revalidate()

    def _refresh_size_controls(self, capability) -> None:
        """按当前模型重建尺寸选项；尽量保留当前选择，否则回退到首个允许模式。"""
        current_mode = self._current_size_mode()
        self._size_combo.blockSignals(True)
        self._size_combo.clear()
        modes: list[SizeMode] = []
        if capability.size.auto_allowed:
            self._size_combo.addItem("模型自动决定", (SizeMode.AUTO, None))
            modes.append(SizeMode.AUTO)
        for width, height in capability.size.presets:
            self._size_combo.addItem(f"{width}×{height}", (SizeMode.PRESET, (width, height)))
            modes.append(SizeMode.PRESET)
        self._size_combo.addItem(_CUSTOM_SIZE_LABEL, (SizeMode.CUSTOM, None))
        modes.append(SizeMode.CUSTOM)
        target = current_mode if current_mode in modes else modes[0]
        self._size_combo.setCurrentIndex(modes.index(target))
        self._size_combo.blockSignals(False)
        self._width_box.setVisible(SizeMode.CUSTOM == target)
        self._height_box.setVisible(SizeMode.CUSTOM == target)

    @Slot(int)
    def _on_size_mode_changed(self, index: int) -> None:
        self._width_box.setVisible(self._current_size_mode() is SizeMode.CUSTOM)
        self._height_box.setVisible(self._current_size_mode() is SizeMode.CUSTOM)
        self._revalidate()

    def _current_size_mode(self) -> SizeMode:
        data = self._size_combo.currentData()
        return data[0] if data is not None else SizeMode.AUTO

    def _read_draft(self) -> TextToImageDraft:
        data = self._size_combo.currentData()
        mode = data[0] if data is not None else SizeMode.AUTO
        size_width: int | None = None
        size_height: int | None = None
        if mode is SizeMode.CUSTOM:
            size_width, size_height = self._width_box.value(), self._height_box.value()
        elif mode is SizeMode.PRESET and data is not None and data[1] is not None:
            size_width, size_height = data[1]
        return TextToImageDraft(
            prompt=self._prompt.toPlainText(),
            model_id=self._model_combo.currentData(),
            negative_prompt=self._negative_prompt.toPlainText() or None,
            size_mode=mode,
            size_width=size_width,
            size_height=size_height,
            image_count=self._count_box.value(),
        )

    @Slot()
    def _revalidate(self) -> None:
        if self._output_error:
            self._validation_label.setText(self._output_error)
            self._submit.setEnabled(False)
            return
        block = self._discovery.submission_block_reason()
        if block is not None:
            self._validation_label.setText(block)
            self._submit.setEnabled(False)
            return
        if not self._has_configured_models:
            self._validation_label.setText("没有可用的已配置模型，无法提交")
            self._submit.setEnabled(False)
            return
        draft = self._read_draft()
        capability = (
            self._capabilities.capability(draft.model_id)
            if draft.model_id is not None
            else None
        )
        errors = draft_errors(draft, capability)
        if errors:
            self._validation_label.setText("；".join(errors))
            self._submit.setEnabled(False)
        else:
            self._validation_label.clear()
            self._submit.setEnabled(True)

    @Slot()
    def _submit_prompt(self) -> None:
        try:
            self._application.submit_text(self._read_draft())
        except ValueError as error:
            self.statusBar().showMessage(str(error))
        else:
            self._preset_application.mark_prompt_submitted()

    @Slot(int)
    def _on_concurrency_changed(self, value: int) -> None:
        try:
            self._settings.set_concurrency_limit(value)
            self._application.set_concurrency_limit(value)
        except ValueError as error:
            self.statusBar().showMessage(str(error))
            return
        self._sync_concurrency_controls(value)

    @Slot()
    def _cancel_selected_task(self) -> None:
        item = self._task_list.currentItem()
        if item is None:
            return
        task_id = item.data(Qt.ItemDataRole.UserRole)
        if task_id is not None and self._application.cancel(task_id):
            self.statusBar().showMessage("任务已取消，本地等待已停止，网关侧计算可能仍在继续")

    @Slot()
    def _remove_selected_task(self) -> None:
        item = self._task_list.currentItem()
        if item is None:
            return
        task_id = item.data(Qt.ItemDataRole.UserRole)
        if task_id is not None and self._application.remove_task(task_id):
            self._tasks.pop(task_id, None)
            self._removed_task_ids.add(task_id)
            self._selected_task_id = None
            row = self._task_list.row(item)
            self._task_list.takeItem(row)
            self._result_list.clear()
            self._preview.setText("提交任务后显示生成结果")
            self._update_result_actions()
            self.statusBar().showMessage("任务已从任务中心移除，磁盘结果未删除")

    @Slot(object)
    def _update_task(self, task: GenerationTask) -> None:
        if task.task_id in self._removed_task_ids:
            return
        is_new = task.task_id not in self._tasks
        self._tasks[task.task_id] = task
        label = f"{task.task_id[:8]}  {_STATUS_LABELS[task.status]}  {task.prompt}"
        if is_new:
            item = QListWidgetItem(label)
            item.setData(Qt.ItemDataRole.UserRole, task.task_id)
            self._task_list.addItem(item)
            if self._selected_task_id is None:
                self._task_list.setCurrentRow(self._task_list.count() - 1)
        else:
            row = next(
                (
                    i
                    for i in range(self._task_list.count())
                    if self._task_list.item(i).data(Qt.ItemDataRole.UserRole) == task.task_id
                ),
                None,
            )
            if row is None:
                return
            self._task_list.item(row).setText(label)
        if task.status is GenerationStatus.FAILED:
            self.statusBar().showMessage(task.error or "生成失败")
        elif task.status is GenerationStatus.SUCCEEDED:
            self.statusBar().showMessage(task.error or "生成结果已保存")
            if task.task_id == self._selected_task_id:
                self._show_result(task)
        elif task.status is GenerationStatus.PARTIALLY_SUCCEEDED:
            self.statusBar().showMessage(task.error or "部分生成结果已保存")
            if task.task_id == self._selected_task_id:
                self._show_result(task)
        elif task.status is GenerationStatus.CANCELLED:
            self.statusBar().showMessage(task.error or "任务已取消，网关侧计算可能仍在继续")

    @Slot(int)
    def _show_selected_result(self, row: int) -> None:
        if row < 0:
            self._selected_task_id = None
            return
        item = self._task_list.item(row)
        task_id = item.data(Qt.ItemDataRole.UserRole)
        if task_id in self._tasks:
            self._selected_task_id = task_id
            self._show_result(self._tasks[task_id])

    def _show_result(self, task: GenerationTask) -> None:
        current_path = self._selected_result_path()
        self._result_list.blockSignals(True)
        self._result_list.clear()
        for path in task.result_paths:
            if not path.is_file():
                continue
            item = QListWidgetItem(QIcon(str(path)), path.name)
            item.setData(Qt.ItemDataRole.UserRole, str(path))
            self._result_list.addItem(item)
        self._result_list.blockSignals(False)
        if self._result_list.count() == 0:
            self._preview.setText("当前任务没有可预览的结果")
            self._update_result_actions()
            return
        selected_row = 0
        if current_path is not None:
            for row in range(self._result_list.count()):
                if Path(self._result_list.item(row).data(Qt.ItemDataRole.UserRole)) == current_path:
                    selected_row = row
                    break
        self._result_list.setCurrentRow(selected_row)
        self._show_selected_image(selected_row)

    @Slot(int)
    def _show_selected_image(self, row: int) -> None:
        path = self._selected_result_path()
        if row < 0 or path is None or not path.is_file():
            self._preview.setText("当前任务没有可预览的结果")
            self._update_result_actions()
            return
        pixmap = QPixmap(str(path))
        if pixmap.isNull():
            self._preview.setText("结果图片无法预览")
        else:
            self._preview.setPixmap(
                pixmap.scaled(
                    self._preview.size(),
                    Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.SmoothTransformation,
                )
            )
        self._update_result_actions()

    def _selected_result_path(self) -> Path | None:
        item = self._result_list.currentItem()
        if item is None:
            return None
        value = item.data(Qt.ItemDataRole.UserRole)
        return Path(value) if isinstance(value, str) else None

    def _update_result_actions(self) -> None:
        enabled = self._selected_result_path() is not None
        self._save_copy.setEnabled(enabled)
        self._copy_image.setEnabled(enabled)
        self._open_directory.setEnabled(enabled)

    @Slot()
    def _save_selected_copy(self) -> None:
        source = self._selected_result_path()
        if source is None or not source.is_file():
            return
        target_name, _ = QFileDialog.getSaveFileName(
            self,
            "保存结果副本",
            source.name,
            "图片 (*.png *.jpg *.jpeg *.webp *.gif *.bmp *.tiff);;所有文件 (*)",
        )
        if not target_name:
            return
        target = Path(target_name)
        if target.resolve() == source.resolve():
            self.statusBar().showMessage("目标文件不能与原结果相同")
            return
        try:
            shutil.copyfile(source, target)
        except OSError as error:
            self.statusBar().showMessage(f"保存结果副本失败：{error}")
        else:
            self.statusBar().showMessage(f"结果副本已保存：{target}")

    @Slot()
    def _copy_selected_image(self) -> None:
        source = self._selected_result_path()
        if source is None or not source.is_file():
            return
        pixmap = QPixmap(str(source))
        if pixmap.isNull():
            self.statusBar().showMessage("结果图片无法复制")
            return
        QApplication.clipboard().setPixmap(pixmap)
        self.statusBar().showMessage("结果图片已复制到剪贴板")

    @Slot()
    def _open_selected_directory(self) -> None:
        source = self._selected_result_path()
        if source is None or not source.is_file():
            return
        if not QDesktopServices.openUrl(QUrl.fromLocalFile(str(source.parent))):
            self.statusBar().showMessage("无法打开结果所在目录")

    def closeEvent(self, event) -> None:
        if self._application.has_unfinished_tasks():
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
        self._diagnostics.system("应用关闭")
        self._application.close()
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
