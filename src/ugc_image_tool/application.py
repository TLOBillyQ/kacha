from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from typing import Callable, Protocol
from uuid import uuid4

from .capabilities import CapabilityRegistry
from .generation import (
    GeneratedImage,
    GenerationStatus,
    GenerationTask,
    TextToImageDraft,
    TextToImageRequest,
    build_request,
    draft_errors,
)


class Gateway(Protocol):
    def generate_text(self, request: TextToImageRequest) -> GeneratedImage: ...


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
        capabilities: CapabilityRegistry | None = None,
        on_task_changed: TaskListener | None = None,
    ) -> None:
        self._gateway = gateway
        self._results = results
        self._capabilities = capabilities or CapabilityRegistry()
        self._on_task_changed = on_task_changed
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="generation")
        self._tasks: dict[str, GenerationTask] = {}
        self._futures: dict[str, Future[None]] = {}
        self._lock = Lock()

    def submit_text(self, draft: TextToImageDraft) -> str:
        """按目标模型能力校验草稿并冻结为提交快照，然后排队执行。"""
        if not draft.model_id:
            raise ValueError("请选择模型")
        capability = self._capabilities.capability(draft.model_id)
        errors = draft_errors(draft, capability)
        if errors:
            raise ValueError("；".join(errors))
        assert capability is not None  # draft_errors 对未配置模型必然返回错误
        request = build_request(draft, capability, self._capabilities.version)
        task = GenerationTask(
            task_id=uuid4().hex,
            request=request,
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
            image = self._gateway.generate_text(task.request)
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
