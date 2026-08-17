from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from typing import Callable, Protocol
from uuid import uuid4

from .generation import GeneratedImage, GenerationStatus, GenerationTask


class Gateway(Protocol):
    def generate_text(self, prompt: str) -> GeneratedImage: ...


class ResultRepository(Protocol):
    def save(self, task: GenerationTask, image: GeneratedImage) -> Path: ...

    def save_record(self, task: GenerationTask) -> None: ...


TaskListener = Callable[[GenerationTask], None]


class GenerationApplication:
    """Application seam shared by the Qt UI and lifecycle tests."""

    def __init__(
        self,
        *,
        gateway: Gateway,
        results: ResultRepository,
        on_task_changed: TaskListener | None = None,
    ) -> None:
        self._gateway = gateway
        self._results = results
        self._on_task_changed = on_task_changed
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="generation")
        self._tasks: dict[str, GenerationTask] = {}
        self._futures: dict[str, Future[None]] = {}
        self._lock = Lock()

    def submit_text(self, prompt: str) -> str:
        normalized_prompt = prompt.strip()
        if not normalized_prompt:
            raise ValueError("请输入正向提示词")
        task = GenerationTask(
            task_id=uuid4().hex,
            prompt=normalized_prompt,
            submitted_at=datetime.now(UTC),
        )
        with self._lock:
            self._tasks[task.task_id] = task
        self._notify(task)
        with self._lock:
            self._futures[task.task_id] = self._executor.submit(self._run, task)
        return task.task_id

    def task(self, task_id: str) -> GenerationTask:
        with self._lock:
            return self._tasks[task_id]

    def wait_for(self, task_id: str, timeout: float | None = None) -> GenerationTask:
        self._futures[task_id].result(timeout=timeout)
        return self.task(task_id)

    def close(self) -> None:
        self._on_task_changed = None
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _run(self, task: GenerationTask) -> None:
        running = task.with_status(GenerationStatus.RUNNING)
        self._replace(running)
        try:
            image = self._gateway.generate_text(task.prompt)
            result_path = self._results.save(task, image)
            succeeded = running.with_status(
                GenerationStatus.SUCCEEDED,
                result_paths=(result_path,),
            )
            self._results.save_record(succeeded)
        except Exception as error:  # boundary converts adapter/storage failures to task state
            failed = running.with_status(GenerationStatus.FAILED, error=str(error))
            self._replace(failed)
            try:
                self._results.save_record(failed)
            except Exception:
                pass
            return
        self._replace(succeeded)

    def _replace(self, task: GenerationTask) -> None:
        with self._lock:
            self._tasks[task.task_id] = task
        self._notify(task)

    def _notify(self, task: GenerationTask) -> None:
        if self._on_task_changed is not None:
            self._on_task_changed(task)
