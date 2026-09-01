"""生成页：合并文生图与图片编辑，参考图数量即任务类型，无模式开关。

正向提示词占据主要创作空间；参考图与负向提示词渐进披露，项目预设、
模型档位、生成尺寸、出图数量与提交动作集中在「本次生成」右栏。
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, cast

from PySide6.QtCore import QSize, Qt, Signal, Slot
from PySide6.QtGui import QAction, QIcon, QStandardItemModel
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QMenu,
    QPushButton,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QTextEdit,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from ...capabilities import ModelTier, Workflow
from ...generation import ImageEditDraft, SizeMode, generate_draft_errors
from ...presets import PresetProject, PresetStoreError, ProjectPreset
from ...references import inspect_reference_image
from ...services import ApplicationServices
from ..disclosure import CollapsibleSection
from ..presentation import (
    CUSTOM_SIZE_LABEL,
    SUBMIT_BUTTON_STYLE,
    UI_CARD_MARGIN,
    UI_ERROR,
    UI_HINT_BACKGROUND,
    UI_SPACING,
    UI_TEXT_MUTED,
    combo_preset_size,
    combo_size_mode,
)
from ..tier_switch import TierSegment, TierSwitch


class _ReferenceListWidget(QListWidget):
    files_dropped = Signal(list)
    remove_requested = Signal()

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

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key.Key_Delete:
            self.remove_requested.emit()
            event.accept()
            return
        super().keyPressEvent(event)


class GeneratePage(QWidget):
    """生成输入页；参考图数量决定任务类型，无模式开关。"""

    status_message = Signal(str)

    def __init__(
        self,
        services: ApplicationServices,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._services = services
        self._settings = services.settings
        self._presets = services.presets
        self._capabilities = services.capabilities
        self._application = services.generation
        self._updating_prompt_controls = False
        self._has_configured_models = False
        self._selected_tier: ModelTier | None = None
        self._tier_models: dict[ModelTier, str] = {}
        self._model_ids: tuple[str, ...] = ()
        self._edit_max_references = 0
        self._draft_count = 1
        self._output_error: str | None = None
        self._presets_initialized = False
        self._build_form()
        self._populate_presets()
        self.refresh_output_state()

    def _current_workflow(self) -> Workflow:
        """参考图数量决定任务类型：有→图片编辑，无→文生图。"""
        return Workflow.IMAGE_EDIT if self._references.count() > 0 else Workflow.TEXT_TO_IMAGE

    def _build_form(self) -> None:
        self._tier_switch = TierSwitch()
        self._tier_switch.tier_changed.connect(self._on_tier_changed)

        self._prompt = QTextEdit()
        self._prompt.setPlaceholderText("描述画面、角色、风格与构图……")
        self._prompt.textChanged.connect(self._on_prompt_changed)

        self._negative_prompt = QTextEdit()
        self._negative_prompt.setPlaceholderText("输入不希望出现的内容")
        self._negative_prompt.textChanged.connect(self._on_prompt_changed)

        self._preset_combo = QComboBox()
        self._preset_combo.setPlaceholderText("选择项目预设")
        self._preset_combo.currentIndexChanged.connect(self._update_preset_actions)
        self._preset_menu = QMenu(self)
        self._apply_preset = QAction("应用项目预设", self)
        self._apply_preset.triggered.connect(self._apply_selected_preset)
        self._copy_preset = QAction("复制为个人预设", self)
        self._copy_preset.triggered.connect(self._copy_selected_preset)
        self._save_preset = QAction("新建个人预设", self)
        self._save_preset.triggered.connect(self._save_personal_preset)
        self._edit_preset = QAction("编辑个人预设", self)
        self._edit_preset.triggered.connect(self._edit_selected_preset)
        self._delete_preset = QAction("删除个人预设", self)
        self._delete_preset.triggered.connect(self._delete_selected_preset)
        self._preset_menu.addActions(
            (
                self._apply_preset,
                self._copy_preset,
                self._save_preset,
                self._edit_preset,
                self._delete_preset,
            )
        )
        self._preset_actions = QToolButton()
        self._preset_actions.setText("预设操作…")
        self._preset_actions.setToolTip("应用、复制、新建、编辑或删除项目预设")
        self._preset_actions.setPopupMode(
            QToolButton.ToolButtonPopupMode.InstantPopup
        )
        self._preset_actions.setMenu(self._preset_menu)

        self._size_combo = QComboBox()
        self._size_combo.currentIndexChanged.connect(self._on_size_changed)
        self._width_box = QSpinBox()
        self._width_box.setRange(1, 16384)
        self._width_box.valueChanged.connect(self._revalidate)
        self._height_box = QSpinBox()
        self._height_box.setRange(1, 16384)
        self._height_box.valueChanged.connect(self._revalidate)
        self._count_box = QSpinBox()
        self._count_box.setRange(1, 1)
        self._count_box.valueChanged.connect(self._on_count_changed)

        self._references = _ReferenceListWidget()
        self._references.files_dropped.connect(self._add_reference_paths)
        self._references.remove_requested.connect(self._remove_selected_reference)
        self._references.model().rowsMoved.connect(lambda *_: self._renumber_references())
        self._references.itemSelectionChanged.connect(
            self._update_remove_reference_state
        )
        self._references.setToolTip("拖动条目可调整参考图顺序")
        self._references.setViewMode(QListWidget.ViewMode.ListMode)
        self._references.setIconSize(QSize(48, 48))
        self._references.setUniformItemSizes(True)
        self._add_reference = QPushButton("＋ 添加参考图（可选，最多 3 张）")
        self._add_reference.setToolTip("支持 PNG 和 JPEG")
        self._add_reference.clicked.connect(self._choose_references)
        self._remove_reference = QPushButton("移除所选参考图")
        self._remove_reference.setEnabled(False)
        self._remove_reference.clicked.connect(self._remove_selected_reference)
        self._reference_hint = QLabel(
            "当前团队网关契约仅验证 1 张参考图，超出部分已禁用"
        )
        self._reference_hint.setWordWrap(True)
        self._reference_hint.setVisible(False)
        self._reference_overflow = False
        self._reference_disabled = QLabel(
            "当前模型不支持图片编辑，参考图区已停用，将按文生图提交"
        )
        self._reference_disabled.setWordWrap(True)
        self._reference_disabled.setVisible(False)
        self._warnings = QLabel()
        self._warnings.setWordWrap(True)
        self._warnings.setStyleSheet("color: #996c00;")

        self._validation = QLabel()
        self._validation.setWordWrap(True)
        self._validation.setStyleSheet(f"color: {UI_ERROR};")

        self._submit = QPushButton("提交生成")
        self._submit.setObjectName("submit")
        self._submit.setStyleSheet(SUBMIT_BUTTON_STYLE)
        self._submit.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._submit.clicked.connect(self._submit_generate)

        reference_layout = QVBoxLayout()
        reference_layout.setContentsMargins(0, 0, 0, 0)
        reference_layout.setSpacing(UI_SPACING)
        reference_layout.addWidget(self._references, 1)
        reference_layout.addWidget(self._reference_hint)
        reference_layout.addWidget(self._reference_disabled)
        reference_layout.addWidget(self._warnings)
        reference_actions = QHBoxLayout()
        reference_actions.addWidget(self._add_reference)
        reference_actions.addWidget(self._remove_reference)
        reference_layout.addLayout(reference_actions)
        reference_help = QLabel(
            "拖放 PNG / JPEG 到这里；添加的参考图将用于图片编辑生成"
        )
        reference_help.setWordWrap(True)
        reference_help.setStyleSheet(f"color: {UI_TEXT_MUTED};")
        reference_layout.addWidget(reference_help)
        self._reference_section = CollapsibleSection(
            "参考图（可选）(&R)",
            expanded=self._settings.generation_reference_expanded(),
        )
        self._reference_section.set_content_layout(reference_layout)
        self._reference_section.toggled.connect(self._on_reference_toggled)

        negative_layout = QVBoxLayout()
        negative_layout.setContentsMargins(0, 0, 0, 0)
        negative_layout.addWidget(self._negative_prompt)
        self._negative_section = CollapsibleSection(
            "负向提示词(&N)",
            expanded=self._settings.generation_negative_prompt_enabled(),
        )
        self._negative_section.set_content_layout(negative_layout)
        self._negative_section.toggled.connect(self._toggle_negative_prompt)

        self._disclosure_hint = QWidget()
        self._disclosure_hint.setStyleSheet(
            f"background-color: {UI_HINT_BACKGROUND};"
        )
        hint_layout = QHBoxLayout(self._disclosure_hint)
        hint_layout.setContentsMargins(UI_SPACING, 4, 4, 4)
        hint_text = QLabel("参考图与负向提示词收在这里，点开即用")
        hint_text.setStyleSheet(f"color: {UI_TEXT_MUTED};")
        hint_layout.addWidget(hint_text, 1)
        self._dismiss_disclosure_hint = QToolButton()
        self._dismiss_disclosure_hint.setText("关闭")
        self._dismiss_disclosure_hint.clicked.connect(
            self._mark_disclosure_hint_seen
        )
        hint_layout.addWidget(self._dismiss_disclosure_hint)
        self._disclosure_hint.setVisible(
            not self._settings.generation_disclosure_hint_seen()
        )

        model_row = QHBoxLayout()
        model_row.setSpacing(UI_SPACING)
        model_row.addWidget(QLabel("模型档位"))
        model_row.addWidget(self._tier_switch, 1)

        size_row = QHBoxLayout()
        size_row.setSpacing(UI_SPACING)
        size_row.addWidget(QLabel("生成尺寸"))
        size_row.addWidget(self._size_combo, 1)

        self._custom_size = QWidget()
        custom_size_layout = QHBoxLayout(self._custom_size)
        custom_size_layout.setContentsMargins(0, 0, 0, 0)
        custom_size_layout.addWidget(QLabel("宽"))
        custom_size_layout.addWidget(self._width_box)
        custom_size_layout.addWidget(QLabel("高"))
        custom_size_layout.addWidget(self._height_box)
        self._custom_size.hide()

        prompt_group = QGroupBox("正向提示词")
        prompt_layout = QVBoxLayout(prompt_group)
        prompt_layout.setContentsMargins(
            UI_CARD_MARGIN, UI_CARD_MARGIN, UI_CARD_MARGIN, UI_CARD_MARGIN
        )
        prompt_layout.addWidget(self._prompt)

        count_layout = QHBoxLayout()
        count_layout.setContentsMargins(0, 0, 0, 0)
        count_layout.addWidget(self._count_box)
        count_layout.addStretch(1)
        self._count_section = CollapsibleSection(
            "出图数量(&C)",
            expanded=self._settings.generation_image_count_expanded(),
        )
        self._count_section.set_content_layout(count_layout)
        self._count_section.toggled.connect(
            self._settings.save_generation_image_count_expanded
        )

        preset_row = QHBoxLayout()
        preset_row.setSpacing(UI_SPACING)
        preset_row.addWidget(self._preset_combo, 1)
        preset_row.addWidget(self._preset_actions)

        self._generation_panel = QGroupBox("本次生成")
        preset_layout = QVBoxLayout(self._generation_panel)
        preset_layout.setContentsMargins(
            UI_CARD_MARGIN, UI_CARD_MARGIN, UI_CARD_MARGIN, UI_CARD_MARGIN
        )
        preset_layout.setSpacing(UI_SPACING)
        preset_layout.addWidget(QLabel("项目预设"))
        preset_layout.addLayout(preset_row)
        preset_layout.addLayout(model_row)
        preset_layout.addLayout(size_row)
        preset_layout.addWidget(self._custom_size)
        preset_layout.addWidget(self._count_section)
        preset_layout.addWidget(self._validation)
        preset_layout.addStretch(1)
        preset_layout.addWidget(self._submit)

        main_panel = QWidget()
        main_layout = QVBoxLayout(main_panel)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(UI_SPACING)
        main_layout.addWidget(prompt_group, 1)
        main_layout.addWidget(self._disclosure_hint)
        main_layout.addWidget(self._reference_section)
        main_layout.addWidget(self._negative_section)

        self._splitter = QSplitter(Qt.Orientation.Horizontal)
        self._splitter.addWidget(main_panel)
        self._splitter.addWidget(self._generation_panel)
        self._splitter.setChildrenCollapsible(False)
        self._splitter.setStretchFactor(0, 1)
        self._splitter.setStretchFactor(1, 0)
        self._splitter.setSizes([620, 280])

        layout = QVBoxLayout()
        layout.setContentsMargins(
            UI_CARD_MARGIN, UI_CARD_MARGIN, UI_CARD_MARGIN, UI_CARD_MARGIN
        )
        layout.setSpacing(UI_SPACING)
        layout.addWidget(self._splitter)
        self.setLayout(layout)

    # -- 模型档位 ------------------------------------------------------------

    def set_models(self, gateway_model_ids: tuple[str, ...]) -> None:
        """按上架档位与当前任务类型刷新分段开关。"""
        self._model_ids = gateway_model_ids
        self._rebuild_tiers()

    def _rebuild_tiers(self) -> None:
        """按当前任务类型（参考图有无）重建分段开关；未上架的档位不出现。"""
        workflow = self._current_workflow()
        available = set(self._model_ids)
        segments: dict[ModelTier, TierSegment] = {}
        self._tier_models = {}
        for tier in ModelTier:
            capability = self._capabilities.resolve_tier(workflow, tier)
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
        self._has_configured_models = bool(self._tier_models)
        self._apply_current_tier()
        self._update_submit_state()

    def _restore_tier_selection(self) -> None:
        """优先持久化档位（用户的真实选择），其次当前选择，最后回退旗舰档。"""
        persisted = self._settings.generation_tier()
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
        self._settings.save_generation_tier(tier)
        self._apply_current_tier()

    def _current_workflow_capability(self):
        """当前任务类型下选中模型的能力；不支持该工作流时返回 None。"""
        model_id = self._current_model_id()
        capability = (
            self._capabilities.capability(model_id) if model_id is not None else None
        )
        if capability is None:
            return None
        return capability.for_workflow(self._current_workflow())

    def _apply_current_tier(self) -> None:
        model_id = self._current_model_id()
        capability = (
            self._capabilities.capability(model_id) if model_id is not None else None
        )
        workflow = self._current_workflow()
        current = (
            capability.for_workflow(workflow) if capability is not None else None
        )
        edit = (
            capability.for_workflow(Workflow.IMAGE_EDIT)
            if capability is not None
            else None
        )
        supports_negative = current is not None and current.supports_negative_prompt
        self._negative_section.setVisible(supports_negative)
        self._edit_max_references = (
            edit.reference_limits.max_references if edit is not None else 0
        )
        self._apply_reference_state(edit)
        if current is None:
            self._size_combo.clear()
            self._custom_size.hide()
            self._revalidate()
            return
        self._count_box.blockSignals(True)
        self._count_box.setRange(current.min_images, current.max_images)
        self._count_box.setValue(
            min(max(self._draft_count, current.min_images), current.max_images)
        )
        self._count_box.blockSignals(False)
        self._refresh_size_controls(current)
        self._revalidate()

    def _apply_reference_state(self, edit_capability) -> None:
        """当前模型无图片编辑能力时停用参考图区并给原因（验收口径 #2）。"""
        if edit_capability is None:
            self._references.setEnabled(False)
            self._add_reference.setEnabled(False)
            self._remove_reference.setEnabled(False)
            self._reference_disabled.setVisible(True)
            self._reference_hint.setVisible(False)
            return
        self._references.setEnabled(True)
        self._add_reference.setEnabled(True)
        self._update_remove_reference_state()
        self._reference_disabled.setVisible(False)
        self._update_reference_hint()

    @Slot()
    def _on_size_changed(self) -> None:
        data = self._size_combo.currentData()
        mode = combo_size_mode(data)
        self._custom_size.setVisible(mode is SizeMode.CUSTOM)
        if mode is SizeMode.PRESET:
            preset_size = combo_preset_size(data)
            if preset_size is not None:
                self._width_box.setValue(preset_size[0])
                self._height_box.setValue(preset_size[1])
        self._revalidate()

    def _refresh_size_controls(self, capability) -> None:
        """按当前能力重建尺寸选项；尽量保留当前选择，否则回退到首个允许模式。"""
        current_mode = combo_size_mode(self._size_combo.currentData())
        self._size_combo.blockSignals(True)
        self._size_combo.clear()
        modes: list[SizeMode] = []
        if capability.size.auto_allowed:
            self._size_combo.addItem("模型自动决定", (SizeMode.AUTO, None))
            modes.append(SizeMode.AUTO)
        for width, height in capability.size.presets:
            self._size_combo.addItem(f"{width}×{height}", (SizeMode.PRESET, (width, height)))
            modes.append(SizeMode.PRESET)
        if capability.size.custom_size_allowed:
            self._size_combo.addItem(CUSTOM_SIZE_LABEL, (SizeMode.CUSTOM, None))
            modes.append(SizeMode.CUSTOM)
        target = current_mode if current_mode in modes else modes[0]
        self._size_combo.setCurrentIndex(modes.index(target))
        self._size_combo.blockSignals(False)
        self._custom_size.setVisible(SizeMode.CUSTOM == target)

    @Slot(bool)
    def _toggle_negative_prompt(self, expanded: bool) -> None:
        self._on_disclosure_toggled(
            expanded, self._settings.save_generation_negative_prompt_enabled
        )

    @Slot(bool)
    def _on_reference_toggled(self, expanded: bool) -> None:
        self._on_disclosure_toggled(
            expanded, self._settings.save_generation_reference_expanded
        )

    def _on_disclosure_toggled(self, expanded: bool, save_expanded) -> None:
        save_expanded(expanded)
        if expanded:
            self._mark_disclosure_hint_seen()

    @Slot()
    def _mark_disclosure_hint_seen(self) -> None:
        self._settings.save_generation_disclosure_hint_seen(True)
        self._disclosure_hint.hide()

    @Slot(int)
    def _on_count_changed(self, value: int) -> None:
        self._draft_count = value
        self._revalidate()

    # -- 参考图 --------------------------------------------------------------

    @Slot()
    def _choose_references(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择参考图", "", "图片 (*.png *.jpg *.jpeg)"
        )
        self._add_reference_paths(paths)

    def _add_reference_paths(self, paths: list[str]) -> None:
        existing = {
            self._references.item(i).data(Qt.ItemDataRole.UserRole)
            for i in range(self._references.count())
        }
        added = False
        overflow = False
        for path in paths:
            if path in existing:
                continue
            if self._references.count() >= self._edit_max_references:
                overflow = True
                continue
            try:
                reference = inspect_reference_image(Path(path))
            except ValueError as error:
                self._validation.setText(str(error))
                continue
            item = QListWidgetItem(
                QIcon(str(path)), f"{self._references.count() + 1}. {Path(path).name}"
            )
            item.setData(Qt.ItemDataRole.UserRole, path)
            item.setToolTip("；".join(reference.warnings) or "尺寸正常")
            self._references.addItem(item)
            existing.add(path)
            added = True
        if added:
            self._reference_overflow = overflow
            self._renumber_references()
        elif overflow:
            self._reference_overflow = True
            self._update_reference_hint()

    def _refresh_reference_warnings(self) -> None:
        warnings = [
            self._references.item(index).toolTip()
            for index in range(self._references.count())
            if self._references.item(index).toolTip() != "尺寸正常"
        ]
        self._warnings.setText("；".join(warnings))

    @Slot()
    def _remove_selected_reference(self) -> None:
        row = self._references.currentRow()
        if row < 0:
            return
        self._references.takeItem(row)
        self._reference_overflow = False
        self._renumber_references()

    @Slot()
    def _update_remove_reference_state(self) -> None:
        self._remove_reference.setEnabled(
            self._references.isEnabled() and self._references.currentRow() >= 0
        )

    def _renumber_references(self) -> None:
        for index in range(self._references.count()):
            item = self._references.item(index)
            item.setText(f"{index + 1}. {Path(item.data(Qt.ItemDataRole.UserRole)).name}")
        self._refresh_reference_warnings()
        self._on_references_changed()

    def _on_references_changed(self) -> None:
        """参考图数量变化即任务类型变化：重建档位并按新约束校验。"""
        self._reference_section.set_expanded(self._references.count() > 0)
        self._rebuild_tiers()
        data = self._size_combo.currentData()
        if self._references.count() > 1 and combo_size_mode(data) is SizeMode.AUTO:
            self._validation.setText(
                "多张参考图使用模型自动决定尺寸时，最后一张参考图会影响默认输出宽高比"
            )
        self._revalidate()
        self._update_reference_hint()

    def _update_reference_hint(self) -> None:
        if self._edit_max_references <= 0:
            self._reference_hint.setVisible(False)
            return
        if self._reference_overflow:
            self._reference_hint.setText(
                f"最多 {self._edit_max_references} 张参考图，已保留前 {self._edit_max_references} 张"
            )
            self._reference_hint.setVisible(True)
            return
        self._reference_hint.setText("当前团队网关契约仅验证 1 张参考图，超出部分已禁用")
        self._reference_hint.setVisible(self._edit_max_references == 1)

    # -- 项目预设 ------------------------------------------------------------

    def _populate_presets(self) -> None:
        current_id = self._preset_combo.currentData()
        persisted_id = self._settings.generation_selected_preset_id()
        selected_id = current_id if isinstance(current_id, str) else persisted_id
        default_preset = self._presets.first_builtin() if selected_id is None else None
        if default_preset is not None:
            selected_id = default_preset.preset_id
        self._preset_combo.blockSignals(True)
        self._preset_combo.clear()
        for project, presets in self._presets.grouped_presets().items():
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
        initial_preset = self._selected_preset() if not self._presets_initialized else None
        self._presets_initialized = True
        if initial_preset is not None:
            self._settings.save_generation_selected_preset_id(initial_preset.preset_id)
            self._presets.apply_preset(initial_preset.preset_id)
            self._set_prompt_values()

    def _selected_preset(self) -> ProjectPreset | None:
        preset_id = self._preset_combo.currentData()
        if not isinstance(preset_id, str):
            return None
        return self._presets.get(preset_id)

    @Slot(int)
    def _update_preset_actions(self, _index: int = -1) -> None:
        preset = self._selected_preset()
        self._apply_preset.setVisible(preset is not None)
        self._copy_preset.setVisible(preset is not None and preset.read_only)
        self._save_preset.setVisible(True)
        self._edit_preset.setVisible(preset is not None and not preset.read_only)
        self._delete_preset.setVisible(preset is not None and not preset.read_only)
        self._apply_preset.setEnabled(preset is not None)
        self._copy_preset.setEnabled(preset is not None and preset.read_only)
        self._edit_preset.setEnabled(preset is not None and not preset.read_only)
        self._delete_preset.setEnabled(preset is not None and not preset.read_only)

    @Slot()
    def _on_prompt_changed(self) -> None:
        if not self._updating_prompt_controls:
            self._presets.update_prompt(
                self._prompt.toPlainText(),
                self._negative_prompt.toPlainText() or None,
            )
        self._revalidate()

    def _set_prompt_values(self) -> None:
        values = self._presets.prompt_values
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
        if not self._presets.apply_preset(
            preset.preset_id,
            confirm_discard=self._confirm_discard_prompt_changes,
        ):
            self.status_message.emit("已取消应用项目预设")
            return
        self._settings.save_generation_selected_preset_id(preset.preset_id)
        self._set_prompt_values()
        self.status_message.emit(f"已应用项目预设：{preset.display_name}")

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
        project = next(
            project for project in PresetProject if project.display_name == project_name
        )
        try:
            preset = self._presets.save_personal_preset(name, project)
        except (ValueError, PresetStoreError) as error:
            self.status_message.emit(f"新建个人预设失败：{error}")
            return
        self._populate_presets()
        self._select_preset(preset.preset_id)
        self.status_message.emit(f"个人预设已保存：{preset.display_name}")

    @Slot()
    def _copy_selected_preset(self) -> None:
        source = self._selected_preset()
        if source is None:
            return
        self._modify_personal_preset(
            source,
            title="复制为个人预设",
            failure="复制个人预设失败",
            success="个人预设已创建",
            operation=lambda name: self._presets.copy_builtin_as_personal(
                source.preset_id,
                name,
            ),
        )

    @Slot()
    def _edit_selected_preset(self) -> None:
        source = self._selected_preset()
        if source is None or source.read_only:
            return
        self._modify_personal_preset(
            source,
            title="编辑个人预设",
            failure="编辑个人预设失败",
            success="个人预设已更新",
            operation=lambda name: self._presets.update_personal_preset(
                source.preset_id,
                name,
            ),
        )

    def _modify_personal_preset(
        self,
        source: ProjectPreset,
        *,
        title: str,
        failure: str,
        success: str,
        operation: Callable[[str], ProjectPreset],
    ) -> None:
        name, accepted = QInputDialog.getText(
            self,
            title,
            "显示名称",
            text=source.display_name,
        )
        if not accepted:
            return
        try:
            preset = operation(name)
        except (ValueError, PresetStoreError, KeyError) as error:
            self.status_message.emit(f"{failure}：{error}")
            return
        self._populate_presets()
        self._select_preset(preset.preset_id)
        self.status_message.emit(f"{success}：{preset.display_name}")

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
            self._presets.delete_personal_preset(preset.preset_id)
        except (KeyError, PermissionError, PresetStoreError) as error:
            self.status_message.emit(f"删除个人预设失败：{error}")
            return
        self._populate_presets()
        self.status_message.emit(f"个人预设已删除：{preset.display_name}")

    def _select_preset(self, preset_id: str) -> None:
        for index in range(self._preset_combo.count()):
            if self._preset_combo.itemData(index) == preset_id:
                self._preset_combo.setCurrentIndex(index)
                return

    # -- 草稿与提交 ----------------------------------------------------------

    def _read_draft(self) -> ImageEditDraft:
        data = self._size_combo.currentData()
        mode = combo_size_mode(data)
        size_width: int | None = None
        size_height: int | None = None
        if mode is SizeMode.CUSTOM:
            size_width, size_height = self._width_box.value(), self._height_box.value()
        elif mode is SizeMode.PRESET:
            preset_size = combo_preset_size(data)
            if preset_size is not None:
                size_width, size_height = preset_size
        return ImageEditDraft(
            prompt=self._prompt.toPlainText(),
            model_id=self._current_model_id(),
            # 取消勾选后文本保留在输入框里但不发送，重新勾选即可找回。
            negative_prompt=(
                (self._negative_prompt.toPlainText() or None)
                if self._negative_section.isVisible()
                and self._negative_section.is_expanded()
                else None
            ),
            size_mode=mode,
            size_width=size_width,
            size_height=size_height,
            image_count=self._count_box.value(),
            reference_paths=tuple(
                Path(self._references.item(i).data(Qt.ItemDataRole.UserRole))
                for i in range(self._references.count())
            ),
        )

    def refresh_output_state(self) -> None:
        self._output_error = self._settings.output_directory_error()
        self._revalidate()

    def _update_submit_state(self) -> None:
        """网关离线或输出目录不可写时禁用提交，避免创建排队任务。"""
        if self._services.submission_block_reason() is not None:
            self._submit.setEnabled(False)

    @Slot()
    def _revalidate(self) -> None:
        if self._output_error:
            self._validation.setText(self._output_error)
            self._submit.setEnabled(False)
            return
        block = self._services.discovery_block_reason()
        if block is not None:
            self._validation.setText(block)
            self._submit.setEnabled(False)
            return
        if not self._has_configured_models:
            self._validation.setText("没有可用的上架档位，无法提交")
            self._submit.setEnabled(False)
            return
        draft = self._read_draft()
        if draft.model_id is None:
            self._validation.setText("请选择模型")
            self._submit.setEnabled(False)
            return
        capability = self._capabilities.capability(draft.model_id)
        errors = generate_draft_errors(draft, capability)
        if errors:
            self._validation.setText("；".join(errors))
            self._submit.setEnabled(False)
        else:
            self._validation.clear()
            self._submit.setEnabled(True)

    @Slot()
    def _submit_generate(self) -> None:
        if self._output_error:
            self._validation.setText(self._output_error)
            return
        try:
            self._application.submit_generate(self._read_draft())
        except ValueError as error:
            self.status_message.emit(str(error))
        else:
            self._presets.mark_prompt_submitted()
