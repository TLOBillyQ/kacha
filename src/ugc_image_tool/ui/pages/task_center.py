"""统一任务中心与生成结果操作。"""

from __future__ import annotations

import shutil
from pathlib import Path

from PySide6.QtCore import QSize, QUrl, Qt, Signal, Slot
from PySide6.QtGui import QAction, QColor, QDesktopServices, QIcon, QPixmap, QResizeEvent
from PySide6.QtWidgets import (
    QAbstractScrollArea,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMenu,
    QSplitter,
    QStyle,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from ...generation import GenerationStatus, GenerationTask
from ...services import ApplicationServices
from ..presentation import STATUS_LABELS, UI_CARD_MARGIN, UI_SPACING, UI_TEXT_MUTED
from ..task_actions import PrimaryTaskAction, task_action_policy


_STATUS_COLORS = {
    GenerationStatus.QUEUED: "#9e9e9e",
    GenerationStatus.RUNNING: "#1976d2",
    GenerationStatus.SUCCEEDED: "#388e3c",
    GenerationStatus.PARTIALLY_SUCCEEDED: "#f57c00",
    GenerationStatus.FAILED: "#c62828",
    GenerationStatus.UNKNOWN: "#757575",
    GenerationStatus.CANCELLED: "#e65100",
}



class TaskCenterPage(QWidget):
    """任务中心与结果操作；只通过应用服务驱动任务生命周期。"""

    status_message = Signal(str)

    _TASK_ITEM_HEIGHT = 44
    _MAX_VISIBLE_TASKS = 4

    def __init__(
        self,
        services: ApplicationServices,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._services = services
        self._application = services.generation
        self._tasks: dict[str, GenerationTask] = {}
        self._removed_task_ids: set[str] = set()
        self._selected_task_id: str | None = None
        self._current_primary_action: PrimaryTaskAction | None = None
        self._current_preview: QPixmap | None = None
        self._build_task_center()
        self._update_actions()

    def _build_task_center(self) -> None:
        self._task_list = QListWidget()
        self._task_list.setSizeAdjustPolicy(
            QAbstractScrollArea.SizeAdjustPolicy.AdjustToContents
        )
        self._task_list.currentRowChanged.connect(self._show_selected_result)
        self._result_list = QListWidget()
        self._result_list.currentRowChanged.connect(self._show_selected_image)
        self._preview = QLabel("提交任务后显示生成结果")
        self._preview.setMinimumSize(200, 200)
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self._primary_action = QToolButton()
        self._primary_action.setToolButtonStyle(
            Qt.ToolButtonStyle.ToolButtonTextBesideIcon
        )
        self._primary_action.clicked.connect(self._run_primary_action)

        self._more_menu = QMenu(self)
        self._save_copy_action = QAction("保存副本", self)
        self._save_copy_action.setToolTip("保存当前生成结果的副本")
        self._save_copy_action.triggered.connect(self._save_selected_copy)
        self._open_directory_action = QAction("打开所在目录", self)
        self._open_directory_action.setToolTip("打开当前生成结果所在目录")
        self._open_directory_action.triggered.connect(self._open_selected_directory)
        self._remove_task_action = QAction("从任务中心移除", self)
        self._remove_task_action.setToolTip("从任务中心移除当前生成任务")
        self._remove_task_action.triggered.connect(self._remove_selected_task)
        self._more_actions = QToolButton()
        self._more_actions.setText("更多")
        self._more_actions.setToolButtonStyle(
            Qt.ToolButtonStyle.ToolButtonTextBesideIcon
        )
        self._more_actions.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self._more_actions.setMenu(self._more_menu)
        self._more_actions.setIcon(
            self.style().standardIcon(
                QStyle.StandardPixmap.SP_ToolBarHorizontalExtensionButton
            )
        )

        action_controls = QHBoxLayout()
        action_controls.setContentsMargins(0, 0, 0, 0)
        action_controls.addWidget(self._primary_action)
        action_controls.addStretch(1)
        action_controls.addWidget(self._more_actions)
        self._action_bar = QWidget()
        self._action_bar.setLayout(action_controls)

        # 变体 B（#30 决议）：预览优先竖排——预览占大头居顶，任务队列与结果列表依次在其下。
        self._content_splitter = QSplitter(Qt.Orientation.Vertical)
        self._content_splitter.addWidget(self._preview)
        self._content_splitter.addWidget(self._task_list)
        self._content_splitter.addWidget(self._result_list)
        self._content_splitter.setStretchFactor(0, 1)
        self._content_splitter.setStretchFactor(1, 0)
        self._content_splitter.setStretchFactor(2, 0)
        self._content_splitter.splitterMoved.connect(self._refresh_preview)

        self._empty_state = QLabel("生成结果会出现在这里")
        self._empty_state.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_state.setStyleSheet(f"color: {UI_TEXT_MUTED};")
        self._content_splitter.hide()
        self._action_bar.hide()

        layout = QVBoxLayout()
        layout.setContentsMargins(
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
        )
        layout.setSpacing(UI_SPACING)
        layout.addWidget(self._action_bar)
        layout.addWidget(self._empty_state, 1)
        layout.addWidget(self._content_splitter, 1)
        self.setLayout(layout)

    def _resize_task_list(self) -> None:
        visible_tasks = min(self._task_list.count(), self._MAX_VISIBLE_TASKS)
        task_height = (
            visible_tasks * self._TASK_ITEM_HEIGHT + 2 * self._task_list.frameWidth()
            if visible_tasks
            else 64
        )
        total_height = max(task_height + 200, self._content_splitter.height())
        result_height = max(80, (total_height - task_height) // 4)
        preview_height = max(120, total_height - task_height - result_height)
        self._content_splitter.setSizes([preview_height, task_height, result_height])

    def _update_task_item(self, item: QListWidgetItem, task: GenerationTask) -> None:
        item.setText(
            f"[{STATUS_LABELS[task.status]}]  {task.task_id[:8]}\n{task.prompt}"
        )
        item.setForeground(QColor(_STATUS_COLORS[task.status]))
        item.setSizeHint(QSize(0, self._TASK_ITEM_HEIGHT))

    @Slot()
    def _cancel_selected_task(self) -> None:
        item = self._task_list.currentItem()
        if item is None:
            return
        task_id = item.data(Qt.ItemDataRole.UserRole)
        if task_id is not None and self._application.cancel(task_id):
            self.status_message.emit("任务已取消，本地等待已停止，网关侧计算可能仍在继续")

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
            self._task_list.blockSignals(True)
            self._task_list.takeItem(row)
            self._task_list.setCurrentRow(-1)
            self._task_list.blockSignals(False)
            self._result_list.clear()
            self._current_preview = None
            self._preview.setText("提交任务后显示生成结果")
            self._resize_task_list()
            if self._task_list.count() == 0:
                self._content_splitter.hide()
                self._empty_state.show()
                self._update_actions()
            else:
                self._task_list.setCurrentRow(min(row, self._task_list.count() - 1))
            self.status_message.emit("任务已从任务中心移除，磁盘结果未删除")

    @Slot(object)
    def on_task_changed(self, task: GenerationTask) -> None:
        if task.task_id in self._removed_task_ids:
            return
        is_new = task.task_id not in self._tasks
        self._tasks[task.task_id] = task
        if is_new:
            self._empty_state.hide()
            self._content_splitter.show()
            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, task.task_id)
            self._update_task_item(item, task)
            self._task_list.addItem(item)
            if self._selected_task_id is None:
                self._task_list.setCurrentRow(self._task_list.count() - 1)
            self._resize_task_list()
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
            self._update_task_item(self._task_list.item(row), task)
        if task.status is GenerationStatus.FAILED:
            self.status_message.emit(task.error or "生成失败")
        elif task.status is GenerationStatus.SUCCEEDED:
            self.status_message.emit(task.error or "生成结果已保存")
        elif task.status is GenerationStatus.PARTIALLY_SUCCEEDED:
            self.status_message.emit(task.error or "部分生成结果已保存")
        elif task.status is GenerationStatus.CANCELLED:
            self.status_message.emit(task.error or "任务已取消，网关侧计算可能仍在继续")
        if task.task_id == self._selected_task_id:
            self._show_result(task)

    @Slot(int)
    def _show_selected_result(self, row: int) -> None:
        if row < 0:
            self._selected_task_id = None
            self._action_bar.hide()
            return
        item = self._task_list.item(row)
        task_id = item.data(Qt.ItemDataRole.UserRole)
        if task_id in self._tasks:
            self._selected_task_id = task_id
            self._action_bar.show()
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
            self._current_preview = None
            self._preview.setText("当前任务没有可预览的结果")
            self._update_actions()
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
            self._current_preview = None
            self._preview.setText("当前任务没有可预览的结果")
            self._update_actions()
            return
        pixmap = QPixmap(str(path))
        if pixmap.isNull():
            self._current_preview = None
            self._preview.setText("结果图片无法预览")
        else:
            self._current_preview = pixmap
            self._refresh_preview()
        self._update_actions()

    @Slot()
    def _refresh_preview(self) -> None:
        if self._current_preview is None:
            return
        self._preview.setPixmap(
            self._current_preview.scaled(
                self._preview.size(),
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
        )

    def resizeEvent(self, event: QResizeEvent) -> None:
        super().resizeEvent(event)
        self._refresh_preview()

    def _selected_result_path(self) -> Path | None:
        item = self._result_list.currentItem()
        if item is None:
            return None
        value = item.data(Qt.ItemDataRole.UserRole)
        return Path(value) if isinstance(value, str) else None

    def _selected_task(self) -> GenerationTask | None:
        if self._selected_task_id is None:
            return None
        return self._tasks.get(self._selected_task_id)

    def _selected_usable_result_path(self) -> Path | None:
        path = self._selected_result_path()
        return path if path is not None and path.is_file() else None

    def _set_primary_action(
        self,
        text: str,
        accessible_name: str,
        icon: QStyle.StandardPixmap,
    ) -> None:
        self._primary_action.setText(text)
        self._primary_action.setToolTip(accessible_name)
        self._primary_action.setAccessibleName(accessible_name)
        self._primary_action.setIcon(self.style().standardIcon(icon))

    def _update_actions(self) -> None:
        task = self._selected_task()
        if task is None:
            self._current_primary_action = None
            self._action_bar.hide()
            return
        has_result = self._selected_usable_result_path() is not None
        policy = task_action_policy(task.status, has_usable_result=has_result)
        self._current_primary_action = policy.primary
        if policy.primary is PrimaryTaskAction.CANCEL:
            self._set_primary_action(
                "取消任务",
                "取消当前生成任务",
                QStyle.StandardPixmap.SP_DialogCancelButton,
            )
        elif policy.primary is PrimaryTaskAction.COPY_RESULT:
            self._set_primary_action(
                "复制图片",
                "复制当前生成结果",
                QStyle.StandardPixmap.SP_FileIcon,
            )
        else:
            self._set_primary_action(
                "移除",
                "从任务中心移除当前生成任务",
                QStyle.StandardPixmap.SP_TrashIcon,
            )
        self._more_menu.clear()
        if policy.show_result_actions:
            self._more_menu.addAction(self._save_copy_action)
            self._more_menu.addAction(self._open_directory_action)
        if policy.allow_removal:
            if policy.show_result_actions:
                self._more_menu.addSeparator()
            self._more_menu.addAction(self._remove_task_action)
        if policy.show_result_actions and policy.allow_removal:
            more_name = "更多当前生成结果和任务操作"
        elif policy.show_result_actions:
            more_name = "更多当前生成结果操作"
        else:
            more_name = "更多当前生成任务操作"
        self._more_actions.setToolTip(more_name)
        self._more_actions.setAccessibleName(more_name)
        self._more_actions.setVisible(bool(self._more_menu.actions()))
        self._action_bar.show()

    @Slot()
    def _run_primary_action(self) -> None:
        if self._selected_task() is None or self._current_primary_action is None:
            return
        handlers = {
            PrimaryTaskAction.CANCEL: self._cancel_selected_task,
            PrimaryTaskAction.COPY_RESULT: self._copy_selected_image,
            PrimaryTaskAction.REMOVE: self._remove_selected_task,
        }
        handlers[self._current_primary_action]()

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
            self.status_message.emit("目标文件不能与原结果相同")
            return
        try:
            shutil.copyfile(source, target)
        except OSError as error:
            self.status_message.emit(f"保存结果副本失败：{error}")
        else:
            self.status_message.emit(f"结果副本已保存：{target}")

    @Slot()
    def _copy_selected_image(self) -> None:
        from PySide6.QtWidgets import QApplication

        source = self._selected_result_path()
        if source is None or not source.is_file():
            return
        pixmap = QPixmap(str(source))
        if pixmap.isNull():
            self.status_message.emit("结果图片无法复制")
            return
        QApplication.clipboard().setPixmap(pixmap)
        self.status_message.emit("结果图片已复制到剪贴板")

    @Slot()
    def _open_selected_directory(self) -> None:
        source = self._selected_result_path()
        if source is None or not source.is_file():
            return
        if not QDesktopServices.openUrl(QUrl.fromLocalFile(str(source.parent))):
            self.status_message.emit("无法打开结果所在目录")
