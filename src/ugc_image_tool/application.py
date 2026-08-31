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
from .diagnostics import DiagnosticSink
from .discovery import GatewayError, GatewayErrorCategory
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
from .settings import (
    DEFAULT_CONCURRENCY_LIMIT,
    MAX_CONCURRENCY_LIMIT,
    validate_concurrency_limit,
)


GENERATION_TIMEOUT_SECONDS = 15 * 60
CANCELLED_ERROR = "已取消本地等待，网关侧计算可能仍在继续"
TIMEOUT_ERROR = "等待超过 15 分钟，结果未知"
CONNECTION_ERROR = "连接中断，结果未知"


class Gateway(Protocol):
    """生成网关；每个实现都必须返回统一的 GatewayGenerationResult。"""

    def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult: ...

    def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult: ...


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
        submission_guard: Callable[[], str | None] | None = None,
        diagnostics: DiagnosticSink | None = None,
    ) -> None:
        self._gateway = gateway
        self._results = results
        self._capabilities = capabilities or CapabilityRegistry()
        self._on_task_changed = on_task_changed
        self._max_concurrency = validate_concurrency_limit(max_concurrency)
        self._submission_guard = submission_guard
        self._diagnostics = diagnostics
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

    def set_concurrency_limit(self, value: int) -> None:
        limit = validate_concurrency_limit(value)
        with self._lock:
            self._ensure_open()
            self._max_concurrency = limit
            self._schedule_locked()

    def submit_generate(self, draft: ImageEditDraft) -> str:
        """合并页统一提交入口：参考图数量决定任务类型（有→图片编辑，无→文生图）。

        类型判定只有一个落点：按 draft.reference_paths 是否为空路由到
        submit_edit / submit_text，各自复用对应工作流现有的校验规则。
        """
        if draft.reference_paths:
            return self.submit_edit(draft)
        return self.submit_text(
            TextToImageDraft(
                prompt=draft.prompt,
                model_id=draft.model_id,
                negative_prompt=draft.negative_prompt,
                size_mode=draft.size_mode,
                size_width=draft.size_width,
                size_height=draft.size_height,
                image_count=draft.image_count,
            )
        )

    def submit_text(self, draft: TextToImageDraft) -> str:
        """Validate and freeze a draft, then place one task in the FIFO queue."""
        self._ensure_submission_allowed()
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
        self._log_transition(task, from_status=None)
        return task.task_id

    def submit_edit(self, draft: ImageEditDraft) -> str:
        self._ensure_submission_allowed()
        if not draft.model_id:
            raise ValueError("请选择模型")
        edit_capability = self._capabilities.workflow_capability(
            draft.model_id, Workflow.IMAGE_EDIT
        )
        if edit_capability is None:
            raise ValueError("该模型不支持图片编辑")
        if not draft.prompt.strip():
            raise ValueError("请输入正向提示词")
        if (draft.negative_prompt or "").strip() and not edit_capability.supports_negative_prompt:
            raise ValueError("该模型的图片编辑不支持负向提示词")
        if not edit_capability.min_images <= draft.image_count <= edit_capability.max_images:
            raise ValueError(
                f"出图数量需在 {edit_capability.min_images}～{edit_capability.max_images} 之间"
            )
        reference_limits = edit_capability.reference_limits
        if not (
            reference_limits.min_references
            <= len(draft.reference_paths)
            <= reference_limits.max_references
        ):
            if reference_limits.min_references == reference_limits.max_references:
                raise ValueError(
                    f"参考图数量需为 {reference_limits.min_references} 张"
                )
            raise ValueError(
                f"参考图数量需在 {reference_limits.min_references}～"
                f"{reference_limits.max_references} 之间"
            )
        errors = _size_errors(draft, edit_capability)
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
            negative_prompt=(draft.negative_prompt or "").strip() or None,
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
        self._log_transition(task, from_status=None)
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
        self._log_transition(
            cancelled,
            from_status=task.status.value,
            category="cancel",
            message=error,
        )
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
                self._log_transition(
                    cancelled,
                    from_status=task.status.value,
                    category="cancel",
                    message=CANCELLED_ERROR,
                )
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
                    error_category="timeout",
                )
                return
            except (GatewayResultUnknownError, OSError) as error:
                if not self._is_running(task_id):
                    return
                self._finish_without_results(
                    task_id,
                    GenerationStatus.UNKNOWN,
                    f"{CONNECTION_ERROR}：{error}",
                    error_category="network",
                )
                return
            except GatewayError as error:
                if not self._is_running(task_id):
                    return
                status, message = _gateway_error_outcome(error.category, error)
                self._finish_without_results(
                    task_id,
                    status,
                    message,
                    gateway_request_id=error.gateway_request_id,
                    error_category=error.category.value,
                    status_code=error.status_code,
                )
                return
            except Exception as error:
                if not self._is_running(task_id):
                    return
                self._finish_without_results(
                    task_id,
                    GenerationStatus.FAILED,
                    str(error),
                    error_category="unknown",
                )
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
        self._log_transition(running, from_status=task.status.value)
        return running

    def _call_gateway(self, task: GenerationTask) -> GatewayGenerationResult:
        result: Future[GatewayGenerationResult] = Future()

        def invoke() -> None:
            try:
                if task.workflow is Workflow.IMAGE_EDIT:
                    request = task.request
                    assert isinstance(request, ImageEditRequest)
                    response = self._gateway.generate_image_edit(request)
                else:
                    request = task.request
                    assert isinstance(request, TextToImageRequest)
                    response = self._gateway.generate_text(request)
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

    def _save_response(
        self, task: GenerationTask, response: GatewayGenerationResult
    ) -> None:
        if not self._is_running(task.task_id):
            return
        images = response.images
        request_id = response.request_id
        if not all(isinstance(image, GeneratedImage) for image in images):
            self._finish_without_results(
                task.task_id,
                GenerationStatus.FAILED,
                "网关返回了无法识别的生成结果",
                gateway_request_id=request_id,
                error_category="unknown",
            )
            return

        if not images:
            self._finish_without_results(
                task.task_id,
                GenerationStatus.FAILED,
                "网关未返回生成结果",
                gateway_request_id=request_id,
                error_category="rejected",
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
            fail_message = "；".join(save_errors) or "生成结果无法保存"
            self._finish_without_results(
                task.task_id,
                GenerationStatus.FAILED,
                fail_message,
                gateway_request_id=request_id,
                error_category="result_save",
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
                error_category="result_save",
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
        error_category: str | None = None,
        status_code: int | None = None,
    ) -> None:
        self._finish_with_results(
            task_id,
            status,
            (),
            error,
            gateway_request_id=gateway_request_id,
            error_category=error_category,
            status_code=status_code,
        )

    def _finish_with_results(
        self,
        task_id: str,
        status: GenerationStatus,
        result_paths: tuple[Path, ...],
        error: str | None,
        gateway_request_id: str | None = None,
        error_category: str | None = None,
        status_code: int | None = None,
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
        self._log_transition(
            candidate,
            from_status=GenerationStatus.RUNNING.value,
            category=error_category,
            status_code=status_code,
            message=error,
        )

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

    def _log_transition(
        self,
        task: GenerationTask,
        *,
        from_status: str | None,
        category: str | None = None,
        status_code: int | None = None,
        message: str | None = None,
    ) -> None:
        """记录任务状态迁移；日志只读，绝不修改任务状态。"""
        if self._diagnostics is None:
            return
        self._diagnostics.task_transition(
            task_id=task.task_id,
            model=task.request.model_id,
            from_status=from_status,
            to_status=task.status.value,
            workflow=task.workflow.value,
            gateway_request_id=task.gateway_request_id,
            category=category,
            status_code=status_code,
            message=message,
        )

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("任务中心已关闭")

    def _ensure_submission_allowed(self) -> None:
        if self._submission_guard is None:
            return
        message = self._submission_guard()
        if message:
            raise ValueError(message)


def _gateway_error_outcome(
    category: GatewayErrorCategory, error: GatewayError
) -> tuple[GenerationStatus, str]:
    """错误类别到任务状态和用户消息的唯一映射。

    生成接口只通过本函数决定网关错误如何呈现，避免状态与文案在不同
    模块各自维护。可以确定生成未开始的类别保持失败；结果未知的类别
    一律进入 unknown 且绝不自动重试。
    """
    if category is GatewayErrorCategory.AUTH:
        return GenerationStatus.FAILED, f"鉴权失败：{error}"
    if category is GatewayErrorCategory.CONFIG:
        return GenerationStatus.FAILED, f"配置错误：{error}"
    if category is GatewayErrorCategory.RATE_LIMIT:
        return GenerationStatus.FAILED, f"网关限流，请稍后重试：{error}"
    if category is GatewayErrorCategory.NETWORK:
        return GenerationStatus.UNKNOWN, f"{CONNECTION_ERROR}：{error}"
    if category is GatewayErrorCategory.SERVER:
        return GenerationStatus.FAILED, f"网关服务错误：{error}"
    if category is GatewayErrorCategory.SERVER_UNKNOWN:
        return GenerationStatus.UNKNOWN, f"网关服务错误，结果未知：{error}"
    if category is GatewayErrorCategory.UNKNOWN:
        return GenerationStatus.UNKNOWN, f"{CONNECTION_ERROR}：{error}"
    return GenerationStatus.FAILED, f"网关拒绝：{error}"
