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
from .capabilities import Workflow
from .generation import (
    GeneratedImage,
    GatewayGenerationResult,
    GenerationStatus,
    GenerationTask,
    TextToImageDraft,
    TextToImageRequest,
    build_request,
    draft_errors,
    ImageEditDraft,
    ImageEditRequest,
    _snapshot_size,
    _size_errors,
)
from .references import inspect_reference_image


DEFAULT_CONCURRENCY_LIMIT = 3
MIN_CONCURRENCY_LIMIT = 1
MAX_CONCURRENCY_LIMIT = 6
GENERATION_TIMEOUT_SECONDS = 15 * 60
CANCELLED_ERROR = "已取消本地等待，网关侧计算可能仍在继续"
TIMEOUT_ERROR = "等待超过 15 分钟，结果未知"
CONNECTION_ERROR = "连接中断，结果未知"

GatewayResponse = (
    GeneratedImage
    | GatewayGenerationResult
    | tuple[GeneratedImage, ...]
    | list[GeneratedImage]
)


class Gateway(Protocol):
    def generate_text(self, request: TextToImageRequest) -> GatewayResponse: ...

    def generate_image_edit(self, request: ImageEditRequest) -> GatewayResponse: ...


class ResultRepository(Protocol):
    def save(self, task: GenerationTask, image: GeneratedImage) -> Path: ...

    def save_record(self, task: GenerationTask) -> None: ...

    def save_reference_snapshot(self, task_id: str, submitted_at: datetime, reference, index: int): ...


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

    def submit_edit(self, draft: ImageEditDraft) -> str:
        if not draft.model_id:
            raise ValueError("请选择模型")
        capability = self._capabilities.capability(draft.model_id)
        if capability is None or Workflow.IMAGE_EDIT not in capability.workflows:
            raise ValueError("该模型不支持图片编辑")
        if not draft.prompt.strip():
            raise ValueError("请输入正向提示词")
        if not capability.min_images <= draft.image_count <= capability.max_images:
            raise ValueError(f"出图数量需在 {capability.min_images}～{capability.max_images} 之间")
        if not 1 <= len(draft.reference_paths) <= 3:
            raise ValueError("参考图数量需为 1～3 张")
        errors = _size_errors(
            TextToImageDraft(size_mode=draft.size_mode, size_width=draft.size_width, size_height=draft.size_height),
            capability,
        )
        if errors:
            raise ValueError("；".join(errors))
        references = tuple(inspect_reference_image(path) for path in draft.reference_paths)
        task_id = uuid4().hex
        submitted_at = datetime.now(UTC)
        references = tuple(
            self._results.save_reference_snapshot(task_id, submitted_at, reference, index)
            for index, reference in enumerate(references, 1)
        )
        request = ImageEditRequest(
            prompt=draft.prompt.strip(),
            model_id=draft.model_id,
            capability_version=self._capabilities.version,
            references=references,
            negative_prompt=(draft.negative_prompt or "").strip() or None
            if capability.supports_negative_prompt
            else None,
            size=_snapshot_size(draft),
            image_count=draft.image_count,
        )
        task = GenerationTask(
            task_id=task_id,
            request=request,
            submitted_at=submitted_at,
            workflow=Workflow.IMAGE_EDIT,
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
        close_results = getattr(self._results, "close", None)
        if callable(close_results):
            close_results()

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
                response = (
                    self._gateway.generate_image_edit(task.request)
                    if task.workflow is Workflow.IMAGE_EDIT
                    else self._gateway.generate_text(task.request)
                )
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
        if not self._is_running(task.task_id):
            return
        try:
            images, request_id = _response_details(response)
        except TypeError as error:
            request_id = (
                response.request_id
                if isinstance(response, GatewayGenerationResult)
                else None
            )
            self._finish_without_results(
                task.task_id,
                GenerationStatus.FAILED,
                str(error),
                gateway_request_id=request_id,
            )
            return

        if not images:
            self._finish_without_results(
                task.task_id,
                GenerationStatus.FAILED,
                "网关未返回生成结果",
                gateway_request_id=request_id,
            )
            return

        paths: list[Path] = []
        save_errors: list[str] = []
        for image in images:
            if not self._is_running(task.task_id):
                return
            try:
                paths.append(self._results.save(task, image))
            except Exception as error:
                save_errors.append(str(error))

        if not paths:
            error = "；".join(save_errors) or "生成结果无法保存"
            self._finish_without_results(
                task.task_id,
                GenerationStatus.FAILED,
                error,
                gateway_request_id=request_id,
            )
            return

        count_error = None
        if len(images) != task.request.image_count:
            count_error = f"网关返回 {len(images)} 张结果，请求期望 {task.request.image_count} 张"
        if save_errors or count_error is not None:
            errors = [message for message in (count_error, *save_errors) if message]
            self._finish_with_results(
                task.task_id,
                GenerationStatus.PARTIALLY_SUCCEEDED,
                tuple(paths),
                "；".join(errors),
                gateway_request_id=request_id,
            )
            return
        self._finish_with_results(
            task.task_id,
            GenerationStatus.SUCCEEDED,
            tuple(paths),
            None,
            gateway_request_id=request_id,
        )

    def _finish_without_results(
        self,
        task_id: str,
        status: GenerationStatus,
        error: str,
        gateway_request_id: str | None = None,
    ) -> None:
        self._finish_with_results(
            task_id,
            status,
            (),
            error,
            gateway_request_id=gateway_request_id,
        )

    def _finish_with_results(
        self,
        task_id: str,
        status: GenerationStatus,
        result_paths: tuple[Path, ...],
        error: str | None,
        gateway_request_id: str | None = None,
    ) -> None:
        with self._lock:
            current = self._tasks.get(task_id)
            if current is None or current.status is not GenerationStatus.RUNNING:
                return
            candidate = current.with_status(
                status,
                result_paths=result_paths,
                error=error,
                gateway_request_id=gateway_request_id,
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
                combined_error = "；".join(
                    message
                    for message in (error, f"任务记录保存失败：{record_error}")
                    if message
                )
                candidate = current.with_status(
                    status,
                    result_paths=result_paths,
                    error=combined_error,
                    gateway_request_id=gateway_request_id,
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


def _response_details(response: GatewayResponse) -> tuple[tuple[GeneratedImage, ...], str | None]:
    if isinstance(response, GatewayGenerationResult):
        if all(isinstance(image, GeneratedImage) for image in response.images):
            return tuple(response.images), response.request_id
        raise TypeError("网关返回了无法识别的生成结果")
    if isinstance(response, GeneratedImage):
        return (response,), None
    if isinstance(response, (tuple, list)) and all(
        isinstance(image, GeneratedImage) for image in response
    ):
        return tuple(response), None
    raise TypeError("网关返回了无法识别的生成结果")
