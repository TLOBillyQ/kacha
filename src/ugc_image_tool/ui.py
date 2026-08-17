from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QObject, Qt, Signal, Slot
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QLabel,
    QListWidget,
    QMainWindow,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .application import GenerationApplication
from .generation import GenerationStatus, GenerationTask
from .results import FileResultRepository
from .simulated_gateway import SimulatedGateway

_STATUS_LABELS = {
    GenerationStatus.QUEUED: "排队中",
    GenerationStatus.RUNNING: "生成中",
    GenerationStatus.SUCCEEDED: "成功",
    GenerationStatus.FAILED: "失败",
}


class _TaskEvents(QObject):
    changed = Signal(object)


class MainWindow(QMainWindow):
    def __init__(self, output_root: Path | None = None) -> None:
        super().__init__()
        self.setWindowTitle("UGC AI 生图工具")
        self.resize(900, 620)
        self._events = _TaskEvents()
        self._events.changed.connect(self._update_task)
        root = output_root or Path.home() / "Pictures" / "UGC AI 生图工具"
        self._application = GenerationApplication(
            gateway=SimulatedGateway(),
            results=FileResultRepository(root),
            on_task_changed=self._events.changed.emit,
        )
        self._tasks: dict[str, GenerationTask] = {}
        self._prompt = QTextEdit()
        self._prompt.setPlaceholderText("输入正向提示词")
        self._submit = QPushButton("提交生成")
        self._submit.clicked.connect(self._submit_prompt)
        self._task_list = QListWidget()
        self._task_list.currentRowChanged.connect(self._show_selected_result)
        self._preview = QLabel("提交任务后显示生成结果")
        self._preview.setMinimumSize(320, 320)
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)

        layout = QVBoxLayout()
        layout.addWidget(QLabel("文生图"))
        layout.addWidget(self._prompt)
        layout.addWidget(self._submit)
        layout.addWidget(QLabel("任务中心"))
        layout.addWidget(self._task_list)
        layout.addWidget(self._preview)
        container = QWidget()
        container.setLayout(layout)
        self.setCentralWidget(container)

    @Slot()
    def _submit_prompt(self) -> None:
        try:
            self._application.submit_text(self._prompt.toPlainText())
        except ValueError as error:
            self.statusBar().showMessage(str(error))

    @Slot(object)
    def _update_task(self, task: GenerationTask) -> None:
        is_new = task.task_id not in self._tasks
        self._tasks[task.task_id] = task
        label = f"{task.task_id[:8]}  {_STATUS_LABELS[task.status]}  {task.prompt}"
        if is_new:
            self._task_list.addItem(label)
        else:
            row = next(i for i in range(self._task_list.count()) if self._task_list.item(i).text().startswith(task.task_id[:8]))
            self._task_list.item(row).setText(label)
        if task.status is GenerationStatus.FAILED:
            self.statusBar().showMessage(task.error or "生成失败")
        elif task.status is GenerationStatus.SUCCEEDED:
            self.statusBar().showMessage("生成结果已保存")
            self._show_result(task)

    @Slot(int)
    def _show_selected_result(self, row: int) -> None:
        if row >= 0:
            task_id = next(iter(self._tasks)) if row == 0 else list(self._tasks)[row]
            self._show_result(self._tasks[task_id])

    def _show_result(self, task: GenerationTask) -> None:
        if task.result_paths and task.result_paths[0].is_file():
            self._preview.setPixmap(QPixmap(str(task.result_paths[0])).scaled(
                self._preview.size(), Qt.AspectRatioMode.KeepAspectRatio,
            ))

    def closeEvent(self, event) -> None:
        self._application.close()
        event.accept()


def run() -> int:
    app = QApplication.instance() or QApplication([])
    window = MainWindow()
    window.show()
    return app.exec()
