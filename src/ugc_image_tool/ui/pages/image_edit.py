"""图片编辑页：参考图、提示词、模型自适应参数与提交前校验。"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QSize, Qt, Signal, Slot
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ...capabilities import ModelTier, Workflow
from ...generation import ImageEditDraft, SizeMode
from ...references import inspect_reference_image
from ...services import ApplicationServices
from ..presentation import (
    SUBMIT_BUTTON_STYLE,
    UI_CARD_MARGIN,
    UI_ERROR,
    UI_SPACING,
    combo_preset_size,
    combo_size_mode,
)
from ..tier_switch import TierSegment, TierSwitch


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
        self._selected_tier: ModelTier | None = None
        self._tier_models: dict[ModelTier, str] = {}
        self._edit_max_references = 0
        self._output_error: str | None = None
        self._build_edit_form()
        self.refresh_output_state()

    def _build_edit_form(self) -> None:
        self._tier_switch = TierSwitch()
        self._tier_switch.tier_changed.connect(self._on_tier_changed)
        self._edit_prompt = QTextEdit()
        self._edit_prompt.setPlaceholderText("输入正向提示词")
        self._edit_negative_prompt = QTextEdit()
        self._edit_negative_prompt.setPlaceholderText("输入负向提示词（可留空）")
        self._edit_negative_prompt_group = QGroupBox("负向提示词")
        self._edit_negative_prompt_group.setCheckable(True)
        self._edit_negative_prompt_group.setChecked(False)
        negative_layout = QVBoxLayout(self._edit_negative_prompt_group)
        negative_layout.setContentsMargins(
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
        )
        negative_layout.addWidget(self._edit_negative_prompt)
        self._edit_negative_prompt_group.toggled.connect(
            self._toggle_negative_prompt
        )
        self._edit_negative_prompt.setVisible(False)
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
        self._edit_references.setViewMode(QListWidget.ViewMode.ListMode)
        self._edit_references.setIconSize(QSize(48, 48))
        self._edit_references.setUniformItemSizes(True)
        self._edit_add = QPushButton("添加参考图")
        self._edit_add.setToolTip("支持 PNG 和 JPEG")
        self._edit_add.clicked.connect(self._choose_edit_references)
        self._edit_reference_hint = QLabel(
            "当前团队网关契约仅验证 1 张参考图，超出部分已禁用"
        )
        self._edit_reference_hint.setWordWrap(True)
        self._edit_reference_hint.setVisible(False)
        self._edit_count = QSpinBox()
        self._edit_count.setRange(1, 2)
        self._edit_edit_submit = QPushButton("提交图片编辑")
        self._edit_edit_submit.setObjectName("submit")
        self._edit_edit_submit.setStyleSheet(SUBMIT_BUTTON_STYLE)
        self._edit_edit_submit.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Fixed,
        )
        self._edit_edit_submit.clicked.connect(self._submit_edit)
        self._edit_validation = QLabel()
        self._edit_validation.setWordWrap(True)
        self._edit_validation.setStyleSheet(f"color: {UI_ERROR};")
        self._edit_warnings = QLabel()
        self._edit_warnings.setWordWrap(True)
        self._edit_warnings.setStyleSheet("color: #996c00;")

        reference_panel = QGroupBox("参考图")
        reference_layout = QVBoxLayout(reference_panel)
        reference_layout.setContentsMargins(
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
        )
        reference_layout.setSpacing(UI_SPACING)
        reference_layout.addWidget(self._edit_references, 1)
        reference_layout.addWidget(self._edit_reference_hint)
        reference_layout.addWidget(self._edit_warnings)
        reference_layout.addWidget(self._edit_add)

        model_row = QHBoxLayout()
        model_row.setSpacing(UI_SPACING)
        model_row.addWidget(QLabel("模型档位"))
        model_row.addWidget(self._tier_switch, 1)
        model_row.addWidget(QLabel("尺寸"))
        model_row.addWidget(self._edit_size_combo, 1)
        model_row.addWidget(QLabel("宽"))
        model_row.addWidget(self._edit_width_box)
        model_row.addWidget(QLabel("高"))
        model_row.addWidget(self._edit_height_box)

        prompt_group = QGroupBox("正向提示词")
        prompt_layout = QVBoxLayout(prompt_group)
        prompt_layout.setContentsMargins(
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
        )
        prompt_layout.addWidget(self._edit_prompt)

        controls = QHBoxLayout()
        controls.setSpacing(UI_SPACING)
        controls.addWidget(QLabel("出图数量"))
        controls.addWidget(self._edit_count)
        controls.addStretch(1)
        controls.addWidget(self._edit_edit_submit, 1)

        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(UI_SPACING)
        right_layout.addLayout(model_row)
        right_layout.addWidget(prompt_group, 1)
        right_layout.addWidget(self._edit_negative_prompt_group)
        right_layout.addWidget(self._edit_validation)
        right_layout.addLayout(controls)

        self._edit_splitter = QSplitter(Qt.Orientation.Horizontal)
        self._edit_splitter.addWidget(reference_panel)
        self._edit_splitter.addWidget(right_panel)
        self._edit_splitter.setChildrenCollapsible(False)
        self._edit_splitter.setStretchFactor(0, 0)
        self._edit_splitter.setStretchFactor(1, 1)
        self._edit_splitter.setSizes([190, 710])

        layout = QVBoxLayout()
        layout.setContentsMargins(
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
        )
        layout.setSpacing(UI_SPACING)
        layout.addWidget(self._edit_splitter)
        self.setLayout(layout)

    def set_models(self, gateway_model_ids: tuple[str, ...]) -> None:
        """按上架档位刷新分段开关；不支持图片编辑的档位不出现。"""
        available = set(gateway_model_ids)
        segments: dict[ModelTier, TierSegment] = {}
        self._tier_models = {}
        for tier in ModelTier:
            capability = self._capabilities.resolve_tier(Workflow.IMAGE_EDIT, tier)
            if capability is None:
                segments[tier] = TierSegment(visible=False, enabled=False)
            elif capability.model_id in available:
                segments[tier] = TierSegment(
                    visible=True, enabled=True, model_id=capability.model_id
                )
                self._tier_models[tier] = capability.model_id
            else:
                segments[tier] = TierSegment(
                    visible=True,
                    enabled=False,
                    reason="网关当前未提供该档模型，暂时无法使用",
                )
        self._tier_switch.apply(segments)
        self._restore_tier_selection()
        self._has_edit_models = bool(self._tier_models)
        self._apply_current_tier()
        self._update_submit_state()

    def _restore_tier_selection(self) -> None:
        """优先持久化档位（用户的真实选择），其次当前选择，最后回退旗舰档。"""
        persisted = self._settings.selected_tier(Workflow.IMAGE_EDIT)
        candidates = (persisted, self._selected_tier, *ModelTier)
        for candidate in candidates:
            if candidate is not None and candidate in self._tier_models:
                self._selected_tier = candidate
                break
        else:
            self._selected_tier = None
        self._tier_switch.select(self._selected_tier)

    def _current_model_id(self) -> str | None:
        """当前选中档位解析到的模型 ID；已提交任务按此 ID 执行。"""
        if self._selected_tier is None:
            return None
        return self._tier_models.get(self._selected_tier)

    @Slot(ModelTier)
    def _on_tier_changed(self, tier: ModelTier) -> None:
        self._selected_tier = tier
        self._settings.save_selected_tier(Workflow.IMAGE_EDIT, tier)
        self._apply_current_tier()

    def _apply_current_tier(self) -> None:
        model_id = self._current_model_id()
        capability = (
            self._capabilities.capability(model_id) if model_id is not None else None
        )
        edit = (
            capability.for_workflow(Workflow.IMAGE_EDIT)
            if capability is not None
            else None
        )
        supports_negative = edit is not None and edit.supports_negative_prompt
        self._edit_negative_prompt_group.setVisible(supports_negative)
        if not supports_negative:
            self._edit_negative_prompt.setVisible(False)
        else:
            self._toggle_negative_prompt(
                self._edit_negative_prompt_group.isChecked()
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

    @Slot(bool)
    def _toggle_negative_prompt(self, expanded: bool) -> None:
        self._edit_negative_prompt.setVisible(expanded)

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
                    model_id=self._current_model_id(),
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
