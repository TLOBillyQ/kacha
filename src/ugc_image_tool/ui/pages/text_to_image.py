"""文生图页：提示词、项目预设、模型、尺寸、出图数量与提交。"""

from __future__ import annotations

from pathlib import Path
from typing import cast

from PySide6.QtCore import Signal, Slot
from PySide6.QtGui import QStandardItemModel
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ...capabilities import Workflow
from ...generation import SizeMode, TextToImageDraft, draft_errors
from ...presets import PresetProject, PresetStoreError, ProjectPreset
from ...services import ApplicationServices
from ..presentation import CUSTOM_SIZE_LABEL, combo_preset_size, combo_size_mode


class TextToImagePage(QWidget):
    """文生图输入页；只调用应用服务，不直接访问存储、凭据库或网关。"""

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
        self._draft_count = 1
        self._output_error: str | None = None
        self._build_form()
        self._populate_presets()
        self.refresh_output_state()

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
        self.setLayout(layout)

    # -- 项目预设 ------------------------------------------------------------

    def _populate_presets(self) -> None:
        selected_id = self._preset_combo.currentData()
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

    def _selected_preset(self) -> ProjectPreset | None:
        preset_id = self._preset_combo.currentData()
        if not isinstance(preset_id, str):
            return None
        return self._presets.get(preset_id)

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
        project = next(project for project in PresetProject if project.display_name == project_name)
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
        name, accepted = QInputDialog.getText(
            self,
            "复制为个人预设",
            "显示名称",
            text=source.display_name,
        )
        if not accepted:
            return
        try:
            preset = self._presets.copy_builtin_as_personal(source.preset_id, name)
        except (ValueError, PresetStoreError, KeyError) as error:
            self.status_message.emit(f"复制个人预设失败：{error}")
            return
        self._populate_presets()
        self._select_preset(preset.preset_id)
        self.status_message.emit(f"个人预设已创建：{preset.display_name}")

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
            preset = self._presets.update_personal_preset(source.preset_id, name)
        except (ValueError, PresetStoreError, KeyError) as error:
            self.status_message.emit(f"编辑个人预设失败：{error}")
            return
        self._populate_presets()
        self._select_preset(preset.preset_id)
        self.status_message.emit(f"个人预设已更新：{preset.display_name}")

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

    # -- 模型与草稿 ----------------------------------------------------------

    def set_models(self, gateway_model_ids: tuple[str, ...]) -> None:
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
        text = (
            capability.for_workflow(Workflow.TEXT_TO_IMAGE)
            if capability is not None
            else None
        )
        self._negative_prompt.setVisible(
            text is not None and text.supports_negative_prompt
        )
        min_count = text.min_images if text is not None else 1
        max_count = text.max_images if text is not None else 1
        # 保留草稿出图数量：超出新模型范围时按边界显示，切回原模型后恢复。
        self._count_box.blockSignals(True)
        self._count_box.setRange(min_count, max_count)
        self._count_box.setValue(min(max(self._draft_count, min_count), max_count))
        self._count_box.blockSignals(False)
        if text is None:
            self._size_combo.clear()
            self._revalidate()
            return
        self._refresh_size_controls(text)
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
        if capability.size.custom_size_allowed:
            self._size_combo.addItem(CUSTOM_SIZE_LABEL, (SizeMode.CUSTOM, None))
            modes.append(SizeMode.CUSTOM)
        target = current_mode if current_mode in modes else modes[0]
        self._size_combo.setCurrentIndex(modes.index(target))
        self._size_combo.blockSignals(False)
        self._width_box.setVisible(SizeMode.CUSTOM == target)
        self._height_box.setVisible(SizeMode.CUSTOM == target)

    @Slot(int)
    def _on_size_mode_changed(self, index: int) -> None:
        mode = combo_size_mode(self._size_combo.currentData())
        self._width_box.setVisible(mode is SizeMode.CUSTOM)
        self._height_box.setVisible(mode is SizeMode.CUSTOM)
        self._revalidate()

    def _current_size_mode(self) -> SizeMode:
        return combo_size_mode(self._size_combo.currentData())

    def _read_draft(self) -> TextToImageDraft:
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
        return TextToImageDraft(
            prompt=self._prompt.toPlainText(),
            model_id=self._model_combo.currentData(),
            negative_prompt=self._negative_prompt.toPlainText() or None,
            size_mode=mode,
            size_width=size_width,
            size_height=size_height,
            image_count=self._count_box.value(),
        )

    # -- 提交前校验 ----------------------------------------------------------

    def refresh_output_state(self) -> None:
        self._output_error = self._settings.output_directory_error()
        self._revalidate()
        self._update_submit_state()

    def _update_submit_state(self) -> None:
        """网关离线或输出目录不可写时禁用提交，避免创建排队任务。"""
        if self._services.submission_block_reason() is not None:
            self._submit.setEnabled(False)

    @Slot()
    def _revalidate(self) -> None:
        if self._output_error:
            self._validation_label.setText(self._output_error)
            self._submit.setEnabled(False)
            return
        block = self._services.discovery_block_reason()
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
            self.status_message.emit(str(error))
        else:
            self._presets.mark_prompt_submitted()
