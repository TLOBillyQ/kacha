"""图片编辑页：参考图、提示词、模型自适应参数与提交前校验。"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Signal, Slot
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSpinBox,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ...capabilities import Workflow
from ...generation import ImageEditDraft, SizeMode
from ...references import inspect_reference_image
from ...services import ApplicationServices
from ..presentation import combo_preset_size, combo_size_mode


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


class ImageEditPage(QWidget):
    """图片编辑输入页；只调用应用服务，不直接访问存储或网关。"""

    def __init__(
        self,
        services: ApplicationServices,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._services = services
        self._settings = services.settings
        self._capabilities = services.capabilities
        self._application = services.generation
        self._has_edit_models = False
        self._edit_max_references = 0
        self._output_error: str | None = None
        self._build_edit_form()
        self.refresh_output_state()

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
        self._edit_reference_hint = QLabel(
            "当前团队网关契约仅验证 1 张参考图，超出部分已禁用"
        )
        self._edit_reference_hint.setWordWrap(True)
        self._edit_reference_hint.setVisible(False)
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
        layout.addWidget(self._edit_reference_hint)
        controls = QHBoxLayout()
        controls.addWidget(self._edit_add)
        controls.addWidget(QLabel("出图数量"))
        controls.addWidget(self._edit_count)
        controls.addStretch(1)
        layout.addLayout(controls)
        layout.addWidget(self._edit_warnings)
        layout.addWidget(self._edit_validation)
        layout.addWidget(self._edit_edit_submit)
        self.setLayout(layout)

    def set_models(self, gateway_model_ids: tuple[str, ...]) -> None:
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
        edit = (
            capability.for_workflow(Workflow.IMAGE_EDIT)
            if capability is not None
            else None
        )
        self._edit_negative_prompt.setVisible(
            edit is not None and edit.supports_negative_prompt
        )
        self._edit_max_references = (
            edit.reference_limits.max_references if edit is not None else 0
        )
        self._edit_reference_hint.setVisible(
            edit is not None and edit.reference_limits.max_references == 1
        )
        if edit is None:
            return
        self._edit_count.setRange(edit.min_images, edit.max_images)
        self._edit_size_combo.clear()
        if edit.size.auto_allowed:
            self._edit_size_combo.addItem("模型自动决定", (SizeMode.AUTO, None))
        for width, height in edit.size.presets:
            self._edit_size_combo.addItem(f"{width}×{height}", (SizeMode.PRESET, (width, height)))
        if edit.size.custom_size_allowed:
            self._edit_size_combo.addItem("自定义…", (SizeMode.CUSTOM, None))
        self._edit_size_combo.setCurrentIndex(0)
        self._on_edit_size_changed()

    @Slot()
    def _on_edit_size_changed(self) -> None:
        data = self._edit_size_combo.currentData()
        mode = combo_size_mode(data)
        self._edit_width_box.setVisible(mode is SizeMode.CUSTOM)
        self._edit_height_box.setVisible(mode is SizeMode.CUSTOM)
        if mode is SizeMode.PRESET:
            preset_size = combo_preset_size(data)
            if preset_size is not None:
                self._edit_width_box.setValue(preset_size[0])
                self._edit_height_box.setValue(preset_size[1])

    @Slot()
    def _choose_edit_references(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择参考图", "", "图片 (*.png *.jpg *.jpeg)"
        )
        self._add_edit_paths(paths)

    def _add_edit_paths(self, paths: list[str]) -> None:
        existing = [self._edit_references.item(i).data(Qt.ItemDataRole.UserRole) for i in range(self._edit_references.count())]
        for path in paths:
            if path in existing or self._edit_references.count() >= self._edit_max_references:
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
        if self._edit_references.count() > 1 and combo_size_mode(data) is SizeMode.AUTO:
            self._edit_validation.setText("多张参考图使用模型自动决定尺寸时，最后一张参考图会影响默认输出宽高比")

    def refresh_output_state(self) -> None:
        self._output_error = self._settings.output_directory_error()
        self._update_submit_state()

    def _update_submit_state(self) -> None:
        """网关离线或输出目录不可写时禁用提交，避免创建排队任务。"""
        block = self._services.submission_block_reason()
        self._edit_edit_submit.setEnabled(block is None and self._has_edit_models)

    @Slot()
    def _submit_edit(self) -> None:
        if self._output_error:
            self._edit_validation.setText(self._output_error)
            return
        self._renumber_references()
        size_data = self._edit_size_combo.currentData()
        size_mode = combo_size_mode(size_data)
        size_width = size_height = None
        if size_mode is SizeMode.CUSTOM:
            size_width, size_height = self._edit_width_box.value(), self._edit_height_box.value()
        elif size_mode is SizeMode.PRESET:
            preset_size = combo_preset_size(size_data)
            if preset_size is not None:
                size_width, size_height = preset_size
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
