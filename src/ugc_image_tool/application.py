from __future__ import annotations

from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from datetime import UTC, datetime
from pathlib import Path
from threading import Event, RLock, Thread
from time import monotonic
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


DEFAULT_CONCURRENCY_LIMIT = 3
MIN_CONCURRENCY_LIMIT = 1
MAX_CONCURRENCY_LIMIT = 6
GENERATION_TIMEOUT_SECONDS = 15 * 60
CANCELLED_ERROR = "已取消本地等待，网关侧计算可能仍在继续"
TIMEOUT_ERROR = "等待超过 15 分钟，结果未知"
CONNECTION_ERROR = "连接中断，结果未知"

GatewayResponse = GeneratedImage | tuple[GeneratedImage, ...] | list[GeneratedImage]


class Gateway(Protocol):
    def generate_text(self, request: TextToImageRequest) -> GatewayResponse: ...


class ResultRepository(Protocol):
    def save(self, task: GenerationTask, image: GeneratedImage) -> Path: ...

    def save_record(self, task: GenerationTask) -> None: ...


TaskListener = Callable[[GenerationTask], None]


class GatewayResultUnknownError(Exception):
    """Gateway could not determine whether generation completed."""


class _GatewayAbandoned(Exception):
    pass


class _GatewayTimedOut(Exception):
    pass


class GenerationApplication:
    """Application seam shared by the Qt UI and lifecycle tests."""

    def __init__(
        self,
        *,
        gateway: Gateway,
        results: ResultRepository,
        capabilities: CapabilityRegistry | None = None,
        on_task_changed: TaskListener | None = None,
        max_concurrency: int = DEFAULT_CONCURRENCY_LIMIT,
        timeout_seconds: float = GENERATION_TIMEOUT_SECONDS,
    ) -> None:
        self._gateway = gateway
        self._results = results
        self._capabilities = capabilities or CapabilityRegistry()
        self._on_task_changed = on_task_changed
        self._max_concurrency = _validate_concurrency_limit(max_concurrency)
        if timeout_seconds <= 0:
            raise ValueError("生成等待超时必须大于 0 秒")
        self._timeout_seconds = timeout_seconds

        # The scheduler enforces the user-facing limit; six workers cover its
        # maximum without rebuilding an executor when the setting changes.
        self._executor = ThreadPoolExecutor(
            max_workers=MAX_CONCURRENCY_LIMIT,
            thread_name_prefix="generation",
        )
        self._tasks: dict[str, GenerationTask] = {}
        self._completion_futures: dict[str, Future[GenerationTask]] = {}
        self._worker_futures: dict[str, Future[None]] = {}
        self._stop_events: dict[str, Event] = {}
        self._queue: deque[str] = deque()
        self._active_ids: set[str] = set()
        self._abandoned_ids: set[str] = set()
        self._lock = RLock()
        self._closed = False

    @property
    def max_concurrency(self) -> int:
        with self._lock:
            return self._max_concurrency

    @max_concurrency.setter
    def max_concurrency(self, value: int) -> None:
        self.set_concurrency_limit(value)

    def set_concurrency_limit(self, value: int) -> None:
        limit = _validate_concurrency_limit(value)
        with self._lock:
            self._ensure_open()
            self._max_concurrency = limit
            self._schedule_locked()

    def submit_text(self, draft: TextToImageDraft) -> str:
        """Validate and freeze a draft, then place one task in the FIFO queue."""
        if not draft.model_id:
            raise ValueError("请选择模型")
        capability = self._capabilities.capability(draft.model_id)
        errors = draft_errors(draft, capability)
        if errors:
            raise ValueError("；".join(errors))
        assert capability is not None  # draft_errors rejects an unknown model
        request = build_request(draft, capability, self._capabilities.version)
        task = GenerationTask(
            task_id=uuid4().hex,
            request=request,
            submitted_at=datetime.now(UTC),
        )
        with self._lock:
            self._ensure_open()
            self._tasks[task.task_id] = task
            self._completion_futures[task.task_id] = Future()
            self._stop_events[task.task_id] = Event()
            self._queue.append(task.task_id)
            self._notify(task)
            self._schedule_locked()
        return task.task_id

    def task(self, task_id: str) -> GenerationTask:
        with self._lock:
            return self._tasks[task_id]

    def tasks(self) -> tuple[GenerationTask, ...]:
        with self._lock:
            return tuple(self._tasks.values())

    def wait_for(self, task_id: str, timeout: float | None = None) -> GenerationTask:
        with self._lock:
            completion = self._completion_futures[task_id]
        return completion.result(timeout=timeout)

    def cancel(self, task_id: str) -> bool:
        """Cancel a queued task or stop waiting for a running task locally."""
        with self._lock:
            task = self._tasks[task_id]
            if task.status not in {GenerationStatus.QUEUED, GenerationStatus.RUNNING}:
                return False
            error = CANCELLED_ERROR if task.status is GenerationStatus.RUNNING else None
            cancelled = self._cancel_locked(task, error)
            self._notify(cancelled)
            self._complete_locked(cancelled)
            self._schedule_locked()
        self._try_save_record(cancelled)
        return True

    def has_unfinished_tasks(self) -> bool:
        with self._lock:
            return any(
                task.status in {GenerationStatus.QUEUED, GenerationStatus.RUNNING}
                for task in self._tasks.values()
            )

    def remove_task(self, task_id: str) -> bool:
        """Remove a terminal task from this session without touching its files."""
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.status in {
                GenerationStatus.QUEUED,
                GenerationStatus.RUNNING,
            }:
                return False
            del self._tasks[task_id]
            self._completion_futures.pop(task_id, None)
            self._stop_events.pop(task_id, None)
            self._abandoned_ids.discard(task_id)
            return True

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._on_task_changed = None
            self._queue.clear()
            for task_id, task in tuple(self._tasks.items()):
                if task.status not in {GenerationStatus.QUEUED, GenerationStatus.RUNNING}:
                    continue
                cancelled = self._cancel_locked(task, CANCELLED_ERROR)
                self._complete_locked(cancelled)
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _run(self, task_id: str) -> None:
        try:
            running = self._begin_running(task_id)
            if running is None:
                return
            try:
                response = self._call_gateway(running)
            except _GatewayAbandoned:
                return
            except _GatewayTimedOut:
                self._finish_without_results(
                    task_id,
                    GenerationStatus.UNKNOWN,
                    TIMEOUT_ERROR,
                )
                return
            except (GatewayResultUnknownError, OSError) as error:
                if not self._is_running(task_id):
                    return
                self._finish_without_results(
                    task_id,
                    GenerationStatus.UNKNOWN,
                    f"{CONNECTION_ERROR}：{error}",
                )
                return
            except Exception as error:
                if not self._is_running(task_id):
                    return
                self._finish_without_results(task_id, GenerationStatus.FAILED, str(error))
                return
            self._save_response(running, response)
        finally:
            self._worker_finished(task_id)

    def _begin_running(self, task_id: str) -> GenerationTask | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.status is not GenerationStatus.QUEUED:
                return None
            running = task.with_status(GenerationStatus.RUNNING)
            self._tasks[task_id] = running
            self._notify(running)
            return running

    def _call_gateway(self, task: GenerationTask) -> GatewayResponse:
        result: Future[GatewayResponse] = Future()

        def invoke() -> None:
            try:
                response = self._gateway.generate_text(task.request)
            except Exception as error:
                result.set_exception(error)
            else:
                result.set_result(response)

        # A gateway implementation may block in a socket read that cannot be
        # interrupted by Python. This daemon thread lets local cancel/timeout
        # return without retrying or waiting for that remote operation.
        Thread(target=invoke, name=f"gateway-{task.task_id[:8]}", daemon=True).start()
        stop_event = self._stop_events[task.task_id]
        deadline = monotonic() + self._timeout_seconds
        while True:
            if stop_event.is_set():
                raise _GatewayAbandoned()
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise _GatewayTimedOut()
            try:
                return result.result(timeout=min(0.05, remaining))
            except TimeoutError:
                if result.done():
                    return result.result()
                continue

    def _save_response(self, task: GenerationTask, response: GatewayResponse) -> None:
        with self._lock:
            if not self._is_running(task.task_id):
                return
            try:
                images = _response_images(response)
            except TypeError as error:
                self._finish_without_results(task.task_id, GenerationStatus.FAILED, str(error))
                return

            if len(images) != task.request.image_count:
                self._finish_without_results(
                    task.task_id,
                    GenerationStatus.UNKNOWN,
                    "网关返回结果数量与请求不一致，结果未知",
                )
                return

            paths: list[Path] = []
            save_error: Exception | None = None
            for image in images:
                try:
                    paths.append(self._results.save(task, image))
                except Exception as error:
                    save_error = error
                    break

            if not paths:
                error = str(save_error) if save_error is not None else "网关未返回生成结果"
                self._finish_without_results(task.task_id, GenerationStatus.FAILED, error)
                return

            if save_error is not None:
                self._finish_with_results(
                    task.task_id,
                    GenerationStatus.PARTIALLY_SUCCEEDED,
                    tuple(paths),
                    str(save_error),
                )
                return
            self._finish_with_results(
                task.task_id,
                GenerationStatus.SUCCEEDED,
                tuple(paths),
                None,
            )

    def _finish_without_results(
        self,
        task_id: str,
        status: GenerationStatus,
        error: str,
    ) -> None:
        self._finish_with_results(task_id, status, (), error)

    def _finish_with_results(
        self,
        task_id: str,
        status: GenerationStatus,
        result_paths: tuple[Path, ...],
        error: str | None,
    ) -> None:
        with self._lock:
            current = self._tasks.get(task_id)
            if current is None or current.status is not GenerationStatus.RUNNING:
                return
            candidate = current.with_status(
                status,
                result_paths=result_paths,
                error=error,
            )
            record_error: Exception | None = None
            try:
                self._results.save_record(candidate)
            except Exception as save_error:
                record_error = save_error

            if record_error is not None and status in {
                GenerationStatus.SUCCEEDED,
                GenerationStatus.PARTIALLY_SUCCEEDED,
            }:
                candidate = current.with_status(
                    GenerationStatus.FAILED,
                    result_paths=(),
                    error=str(record_error),
                )
                self._try_save_record(candidate)

            current = self._tasks.get(task_id)
            if current is None or current.status is not GenerationStatus.RUNNING:
                return
            self._tasks[task_id] = candidate
            self._notify(candidate)
            self._complete_locked(candidate)

    def _try_save_record(self, task: GenerationTask) -> None:
        try:
            self._results.save_record(task)
        except Exception:
            pass

    def _cancel_locked(self, task: GenerationTask, error: str | None) -> GenerationTask:
        cancelled = task.with_status(GenerationStatus.CANCELLED, error=error)
        self._tasks[task.task_id] = cancelled
        self._abandoned_ids.add(task.task_id)
        self._stop_events[task.task_id].set()
        self._active_ids.discard(task.task_id)
        try:
            self._queue.remove(task.task_id)
        except ValueError:
            pass
        return cancelled

    def _is_running(self, task_id: str) -> bool:
        with self._lock:
            return (
                task_id not in self._abandoned_ids
                and self._tasks.get(task_id, None) is not None
                and self._tasks[task_id].status is GenerationStatus.RUNNING
            )

    def _complete_locked(self, task: GenerationTask) -> None:
        completion = self._completion_futures.get(task.task_id)
        if completion is not None and not completion.done():
            completion.set_result(task)

    def _worker_finished(self, task_id: str) -> None:
        with self._lock:
            self._worker_futures.pop(task_id, None)
            self._active_ids.discard(task_id)
            if not self._closed:
                self._schedule_locked()

    def _schedule_locked(self) -> None:
        while len(self._active_ids) < self._max_concurrency and self._queue:
            task_id = self._queue.popleft()
            task = self._tasks.get(task_id)
            if task is None or task.status is not GenerationStatus.QUEUED:
                continue
            self._active_ids.add(task_id)
            self._worker_futures[task_id] = self._executor.submit(self._run, task_id)

    def _notify(self, task: GenerationTask) -> None:
        if self._on_task_changed is not None:
            self._on_task_changed(task)

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("任务中心已关闭")


def _validate_concurrency_limit(value: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not MIN_CONCURRENCY_LIMIT <= value <= MAX_CONCURRENCY_LIMIT
    ):
        raise ValueError("并发上限必须是 1～6 的整数")
    return value


def _response_images(response: GatewayResponse) -> tuple[GeneratedImage, ...]:
    if isinstance(response, GeneratedImage):
        return (response,)
    if isinstance(response, (tuple, list)) and all(
        isinstance(image, GeneratedImage) for image in response
    ):
        return tuple(response)
    raise TypeError("网关返回了无法识别的生成结果")
