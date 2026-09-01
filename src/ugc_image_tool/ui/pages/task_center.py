"""统一任务中心与生成结果操作。"""

from __future__ import annotations

import shutil
from pathlib import Path

from PySide6.QtCore import QSize, QUrl, Qt, Signal, Slot
from PySide6.QtGui import QColor, QDesktopServices, QIcon, QPixmap, QResizeEvent
from PySide6.QtWidgets import (
    QAbstractScrollArea,
    QFileDialog,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ...generation import GenerationStatus, GenerationTask
from ...services import ApplicationServices
from ..presentation import STATUS_LABELS, UI_CARD_MARGIN, UI_SPACING


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
        self._current_preview: QPixmap | None = None
        self._build_task_center()
        self._update_result_actions()

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
        # 窄面板（默认 340px）下横向一排按钮会撑宽停靠面板，改为两列网格：
        # 左列为任务操作，右列为结果操作。
        action_controls = QGridLayout()
        action_controls.addWidget(self._cancel_task, 0, 0)
        action_controls.addWidget(self._remove_task, 1, 0)
        action_controls.addWidget(self._save_copy, 0, 1)
        action_controls.addWidget(self._copy_image, 1, 1)
        action_controls.addWidget(self._open_directory, 2, 1)
        action_controls.setColumnStretch(0, 1)
        action_controls.setColumnStretch(1, 1)

        # 变体 B（#30 决议）：预览优先竖排——预览占大头居顶，任务队列与结果列表依次在其下。
        self._content_splitter = QSplitter(Qt.Orientation.Vertical)
        self._content_splitter.addWidget(self._preview)
        self._content_splitter.addWidget(self._task_list)
        self._content_splitter.addWidget(self._result_list)
        self._content_splitter.setStretchFactor(0, 1)
        self._content_splitter.setStretchFactor(1, 0)
        self._content_splitter.setStretchFactor(2, 0)
        self._content_splitter.splitterMoved.connect(self._refresh_preview)

        layout = QVBoxLayout()
        layout.setContentsMargins(
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
            UI_CARD_MARGIN,
        )
        layout.setSpacing(UI_SPACING)
        layout.addLayout(action_controls)
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
            self._task_list.takeItem(row)
            self._result_list.clear()
            self._current_preview = None
            self._preview.setText("提交任务后显示生成结果")
            self._resize_task_list()
            self._update_result_actions()
            self.status_message.emit("任务已从任务中心移除，磁盘结果未删除")

    @Slot(object)
    def on_task_changed(self, task: GenerationTask) -> None:
        if task.task_id in self._removed_task_ids:
            return
        is_new = task.task_id not in self._tasks
        self._tasks[task.task_id] = task
        if is_new:
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
            if task.task_id == self._selected_task_id:
                self._show_result(task)
        elif task.status is GenerationStatus.PARTIALLY_SUCCEEDED:
            self.status_message.emit(task.error or "部分生成结果已保存")
            if task.task_id == self._selected_task_id:
                self._show_result(task)
        elif task.status is GenerationStatus.CANCELLED:
            self.status_message.emit(task.error or "任务已取消，网关侧计算可能仍在继续")

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
            self._current_preview = None
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
            self._current_preview = None
            self._preview.setText("当前任务没有可预览的结果")
            self._update_result_actions()
            return
        pixmap = QPixmap(str(path))
        if pixmap.isNull():
            self._current_preview = None
            self._preview.setText("结果图片无法预览")
        else:
            self._current_preview = pixmap
            self._refresh_preview()
        self._update_result_actions()

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
