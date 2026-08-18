from __future__ import annotations

import shutil
from pathlib import Path

from PySide6.QtCore import QObject, QUrl, Qt, Signal, Slot
from PySide6.QtGui import QDesktopServices, QIcon, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QTextEdit,
    QVBoxLayout,
    QWidget,
    QFileDialog,
    QTabWidget,
)

from .application import GenerationApplication
from .capabilities import CapabilityRegistry, Workflow
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


class _TaskEvents(QObject):
    changed = Signal(object)


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
    ) -> None:
        super().__init__()
        self.setWindowTitle("UGC AI 生图工具")
        self.resize(900, 620)
        self._events = _TaskEvents()
        self._events.changed.connect(self._update_task)
        root = output_root or Path.home() / "Pictures" / "UGC AI 生图工具"
        self._capabilities = capabilities or CapabilityRegistry()
        gateway = SimulatedGateway()
        self._application = GenerationApplication(
            gateway=gateway,
            results=FileResultRepository(root),
            capabilities=self._capabilities,
            on_task_changed=self._events.changed.emit,
        )
        self._tasks: dict[str, GenerationTask] = {}
        self._removed_task_ids: set[str] = set()
        self._selected_task_id: str | None = None
        self._has_configured_models = False
        self._draft_count = 1
        self._build_form()
        self._build_edit_form()
        self._build_task_center()
        self._populate_models(gateway.list_models())
        self._populate_edit_models(gateway.list_models())
        self._revalidate()

    def _build_form(self) -> None:
        self._model_combo = QComboBox()
        self._model_combo.currentIndexChanged.connect(self._on_model_changed)

        self._prompt = QTextEdit()
        self._prompt.setPlaceholderText("输入正向提示词")
        self._prompt.textChanged.connect(self._revalidate)

        self._negative_prompt = QTextEdit()
        self._negative_prompt.setPlaceholderText("输入负向提示词（可留空）")
        self._negative_prompt.textChanged.connect(self._revalidate)

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
        layout.addWidget(QLabel("文生图"))
        layout.addWidget(self._prompt)
        layout.addWidget(self._negative_prompt)
        layout.addWidget(QLabel("生成尺寸"))
        layout.addLayout(size_row)
        layout.addWidget(self._validation_label)
        layout.addWidget(self._submit)
        self._form_container = QWidget()
        self._form_container.setLayout(layout)

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
        root = QVBoxLayout()
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
        for entry in self._capabilities.merge(gateway_model_ids):
            capability = entry.capability
            if capability is None or Workflow.IMAGE_EDIT not in capability.workflows:
                continue
            self._edit_model_combo.addItem(
                f"{entry.model_id}（{capability.display_name}）", entry.model_id
            )

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
        enabled_indices: list[int] = []
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
                self._model_combo.model().item(index).setEnabled(False)
            else:
                enabled_indices.append(index)
        self._has_configured_models = bool(enabled_indices)
        if enabled_indices:
            self._model_combo.setCurrentIndex(enabled_indices[0])

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

    @Slot(int)
    def _on_concurrency_changed(self, value: int) -> None:
        try:
            self._application.set_concurrency_limit(value)
        except ValueError as error:
            self.statusBar().showMessage(str(error))

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
        self._application.close()
        event.accept()


def run() -> int:
    app = QApplication.instance() or QApplication([])
    window = MainWindow()
    window.show()
    return app.exec()
