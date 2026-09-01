from __future__ import annotations

import unittest
from datetime import UTC, datetime
from pathlib import Path
from threading import Condition, Event
from tempfile import TemporaryDirectory
from time import monotonic

from ugc_image_tool.application import GenerationApplication
from ugc_image_tool.generation import (
    GatewayGenerationResult,
    GeneratedImage,
    GenerationStatus,
    GenerationTask,
    TextToImageDraft,
    TextToImageRequest,
    ImageEditRequest,
)
from ugc_image_tool.results import FileResultRepository


PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
)


class GenerationStateTests(unittest.TestCase):
    def test_status_transitions_reject_skipping_and_terminal_transitions(self) -> None:
        task = GenerationTask(
            task_id="task-1",
            request=TextToImageRequest(
                prompt="a test image",
                model_id="model",
                capability_version="test-v1",
            ),
            submitted_at=datetime.now(UTC),
        )

        running = task.with_status(GenerationStatus.RUNNING)
        self.assertEqual(GenerationStatus.RUNNING, running.status)

        with self.assertRaises(ValueError):
            task.with_status(GenerationStatus.SUCCEEDED)

        cancelled = task.with_status(GenerationStatus.CANCELLED)
        with self.assertRaises(ValueError):
            cancelled.with_status(GenerationStatus.RUNNING)


class BlockingGateway:
    def __init__(self) -> None:
        self.image = GeneratedImage(content=b"png-data", media_type="image/png")
        self.release = Event()
        self._condition = Condition()
        self._release_by_prompt: dict[str, Event] = {}
        self.calls: list[str] = []
        self.active = 0
        self.max_active = 0

    def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
        raise AssertionError("该测试替身只支持文生图")

    def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
        with self._condition:
            self.calls.append(request.prompt)
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self._condition.notify_all()
            prompt_release = self._release_by_prompt.setdefault(request.prompt, Event())
        while not self.release.is_set() and not prompt_release.wait(timeout=0.01):
            pass
        with self._condition:
            self.active -= 1
            self._condition.notify_all()
        return GatewayGenerationResult(images=(self.image,))

    def wait_for_calls(self, count: int, timeout: float = 1) -> bool:
        with self._condition:
            return self._condition.wait_for(lambda: len(self.calls) >= count, timeout)

    def release_prompt(self, prompt: str) -> None:
        with self._condition:
            self._release_by_prompt.setdefault(prompt, Event()).set()


class InMemoryResults:
    def __init__(self) -> None:
        self.saved: list[str] = []
        self.records: list[GenerationTask] = []

    def save(self, task: GenerationTask, image: GeneratedImage) -> Path:
        self.saved.append(task.task_id)
        return Path(task.task_id) / "result-1.png"

    def save_record(self, task: GenerationTask) -> None:
        self.records.append(task)

    def save_reference_snapshot(self, task_id, submitted_at, reference, index):
        return reference


class GenerationQueueTests(unittest.TestCase):
    def test_concurrency_limit_is_restricted_to_one_through_six(self) -> None:
        application = GenerationApplication(
            gateway=BlockingGateway(),
            results=InMemoryResults(),
        )
        try:
            for invalid in (0, 7):
                with self.assertRaises(ValueError):
                    application.set_concurrency_limit(invalid)
        finally:
            application.close()

    def test_default_limit_runs_three_tasks_and_completes_all(self) -> None:
        gateway = BlockingGateway()
        application = GenerationApplication(gateway=gateway, results=InMemoryResults())
        task_ids = []
        try:
            for index in range(5):
                task_ids.append(
                    application.submit_text(
                        TextToImageDraft(prompt=f"job-{index}", model_id="qwen-image-3.0-pro")
                    )
                )

            self.assertTrue(gateway.wait_for_calls(3))
            self.assertEqual(3, len(gateway.calls))
            self.assertLessEqual(gateway.max_active, 3)

            gateway.release_prompt("job-0")
            self.assertTrue(gateway.wait_for_calls(4))
            gateway.release_prompt("job-1")
            self.assertTrue(gateway.wait_for_calls(5))
            gateway.release_prompt("job-2")
            gateway.release_prompt("job-3")
            gateway.release_prompt("job-4")
            for task_id in task_ids:
                self.assertEqual(
                    GenerationStatus.SUCCEEDED,
                    application.wait_for(task_id, timeout=2).status,
                )
        finally:
            gateway.release.set()
            application.close()

        # 并发 worker 进入网关的先后顺序非确定（线程调度），只断言执行了全部任务。
        self.assertEqual(
            sorted(f"job-{index}" for index in range(5)),
            sorted(gateway.calls),
        )

    def test_lowering_limit_does_not_cancel_running_tasks(self) -> None:
        gateway = BlockingGateway()
        application = GenerationApplication(gateway=gateway, results=InMemoryResults())
        task_ids = []
        try:
            for index in range(4):
                task_ids.append(
                    application.submit_text(
                        TextToImageDraft(prompt=f"job-{index}", model_id="qwen-image-3.0-pro")
                    )
                )
            self.assertTrue(gateway.wait_for_calls(3))

            application.set_concurrency_limit(1)
            self.assertEqual(1, application.max_concurrency)
            gateway.release.set()

            for task_id in task_ids:
                self.assertEqual(
                    GenerationStatus.SUCCEEDED,
                    application.wait_for(task_id, timeout=2).status,
                )
        finally:
            gateway.release.set()
            application.close()

        self.assertEqual(3, gateway.max_active)
        # 并发 worker 进入网关的顺序非确定，只断言执行了全部任务。
        self.assertEqual(
            sorted(f"job-{index}" for index in range(4)),
            sorted(gateway.calls),
        )


class GenerationCancellationTests(unittest.TestCase):
    def test_only_terminal_tasks_can_be_removed(self) -> None:
        gateway = BlockingGateway()
        application = GenerationApplication(
            gateway=gateway,
            results=InMemoryResults(),
            max_concurrency=1,
        )
        try:
            running = application.submit_text(
                TextToImageDraft(prompt="running", model_id="qwen-image-3.0-pro")
            )
            self.assertTrue(gateway.wait_for_calls(1))
            queued = application.submit_text(
                TextToImageDraft(prompt="queued", model_id="qwen-image-3.0-pro")
            )

            self.assertFalse(application.remove_task(running))
            self.assertFalse(application.remove_task(queued))
            self.assertTrue(application.cancel(queued))
            self.assertTrue(application.remove_task(queued))
            self.assertTrue(application.cancel(running))
            self.assertTrue(application.remove_task(running))
        finally:
            gateway.release.set()
            application.close()

    def test_queued_task_can_be_cancelled_without_calling_gateway(self) -> None:
        gateway = BlockingGateway()
        results = InMemoryResults()
        application = GenerationApplication(
            gateway=gateway,
            results=results,
            max_concurrency=1,
        )
        try:
            first = application.submit_text(
                TextToImageDraft(prompt="first", model_id="qwen-image-3.0-pro")
            )
            self.assertTrue(gateway.wait_for_calls(1))
            second = application.submit_text(
                TextToImageDraft(prompt="second", model_id="qwen-image-3.0-pro")
            )

            self.assertTrue(application.cancel(second))
            self.assertEqual(GenerationStatus.CANCELLED, application.wait_for(second).status)
            gateway.release.set()
            self.assertEqual(
                GenerationStatus.SUCCEEDED,
                application.wait_for(first, timeout=2).status,
            )
        finally:
            gateway.release.set()
            application.close()

        self.assertEqual(["first"], gateway.calls)
        self.assertFalse(application.cancel(second))

    def test_running_cancellation_ignores_late_gateway_result(self) -> None:
        gateway = BlockingGateway()
        results = InMemoryResults()
        application = GenerationApplication(
            gateway=gateway,
            results=results,
            max_concurrency=1,
        )
        try:
            task_id = application.submit_text(
                TextToImageDraft(prompt="cancel me", model_id="qwen-image-3.0-pro")
            )
            self.assertTrue(gateway.wait_for_calls(1))

            self.assertTrue(application.cancel(task_id))
            self.assertEqual(
                GenerationStatus.CANCELLED,
                application.wait_for(task_id, timeout=1).status,
            )
            gateway.release.set()
        finally:
            gateway.release.set()
            application.close()

        self.assertEqual([], results.saved)


class GenerationUncertaintyTests(unittest.TestCase):
    def test_wait_timeout_marks_unknown_without_retrying_generation(self) -> None:
        started = Event()
        release = Event()
        calls = []

        class HangingGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                calls.append(request.prompt)
                started.set()
                release.wait(timeout=2)
                return GatewayGenerationResult(
                    images=(GeneratedImage(b"late", "image/png"),)
                )

        results = InMemoryResults()
        application = GenerationApplication(
            gateway=HangingGateway(),
            results=results,
            timeout_seconds=0.03,
        )
        try:
            task_id = application.submit_text(
                TextToImageDraft(prompt="unknown", model_id="qwen-image-3.0-pro")
            )
            self.assertTrue(started.wait(timeout=1))
            before = monotonic()
            task = application.wait_for(task_id, timeout=1)
            elapsed = monotonic() - before
            self.assertEqual(GenerationStatus.UNKNOWN, task.status)
            self.assertLess(elapsed, 0.5)
            self.assertEqual(["unknown"], calls)
            self.assertEqual([], results.saved)
        finally:
            release.set()
            application.close()

    def test_connection_interruption_marks_unknown_without_retrying_generation(self) -> None:
        calls = []

        class DisconnectedGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                calls.append(request.prompt)
                raise OSError("socket closed")

        application = GenerationApplication(
            gateway=DisconnectedGateway(),
            results=InMemoryResults(),
        )
        try:
            task_id = application.submit_text(
                TextToImageDraft(prompt="disconnected", model_id="qwen-image-3.0-pro")
            )
            task = application.wait_for(task_id, timeout=1)
            self.assertEqual(GenerationStatus.UNKNOWN, task.status)
            self.assertIn("结果未知", task.error or "")
            self.assertEqual(["disconnected"], calls)
        finally:
            application.close()

    def test_gateway_timeout_exception_marks_unknown_immediately(self) -> None:
        calls = []

        class TimedOutGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                calls.append(request.prompt)
                raise TimeoutError("gateway read timed out")

        application = GenerationApplication(
            gateway=TimedOutGateway(),
            results=InMemoryResults(),
        )
        try:
            task_id = application.submit_text(
                TextToImageDraft(prompt="gateway timeout", model_id="qwen-image-3.0-pro")
            )
            task = application.wait_for(task_id, timeout=1)
            self.assertEqual(GenerationStatus.UNKNOWN, task.status)
            self.assertEqual(["gateway timeout"], calls)
        finally:
            application.close()


class GenerationResultStatusTests(unittest.TestCase):
    def test_incomplete_gateway_response_is_partially_succeeded(self) -> None:
        class ShortGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                return GatewayGenerationResult(
                    images=(GeneratedImage(b"one", "image/png"),)
                )

        results = InMemoryResults()
        application = GenerationApplication(
            gateway=ShortGateway(),
            results=results,
        )
        try:
            task_id = application.submit_text(
                TextToImageDraft(
                    prompt="uncertain response",
                    model_id="qwen-image-3.0-pro",
                    image_count=2,
                )
            )
            task = application.wait_for(task_id, timeout=1)
        finally:
            application.close()

        self.assertEqual(GenerationStatus.PARTIALLY_SUCCEEDED, task.status)
        self.assertEqual([task_id], results.saved)

    def test_empty_gateway_response_is_failed(self) -> None:
        class EmptyGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                return GatewayGenerationResult(images=())

        results = InMemoryResults()
        application = GenerationApplication(
            gateway=EmptyGateway(),
            results=results,
        )
        try:
            task_id = application.submit_text(
                TextToImageDraft(prompt="empty", model_id="qwen-image-3.0-pro")
            )
            task = application.wait_for(task_id, timeout=1)
        finally:
            application.close()

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertEqual((), task.result_paths)
        self.assertEqual("网关未返回生成结果", task.error)

    def test_saving_one_of_two_results_is_partially_succeeded(self) -> None:
        images = [GeneratedImage(b"one", "image/png"), GeneratedImage(b"two", "image/png")]

        class PartialGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                return GatewayGenerationResult(images=tuple(images))

        class FailingAfterOneResults(InMemoryResults):
            def save(self, task: GenerationTask, image: GeneratedImage) -> Path:
                if self.saved:
                    raise OSError("第二张结果无法保存")
                return super().save(task, image)

        results = FailingAfterOneResults()
        application = GenerationApplication(
            gateway=PartialGateway(),
            results=results,
        )
        try:
            task_id = application.submit_text(
                TextToImageDraft(
                    prompt="partial",
                    model_id="qwen-image-3.0-pro",
                    image_count=2,
                )
            )
            task = application.wait_for(task_id, timeout=1)
        finally:
            application.close()

        self.assertEqual(GenerationStatus.PARTIALLY_SUCCEEDED, task.status)
        self.assertEqual(1, len(task.result_paths))
        self.assertEqual("第二张结果无法保存", task.error)

    def test_later_result_is_saved_when_an_earlier_result_fails(self) -> None:
        images = [GeneratedImage(b"one", "image/png"), GeneratedImage(b"two", "image/png")]

        class PartialGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                return GatewayGenerationResult(images=tuple(images))

        class FailingBeforeFirstResults(InMemoryResults):
            def __init__(self) -> None:
                super().__init__()
                self.failed = False

            def save(self, task: GenerationTask, image: GeneratedImage) -> Path:
                if not self.failed:
                    self.failed = True
                    raise OSError("第一张结果无法保存")
                return super().save(task, image)

        results = FailingBeforeFirstResults()
        application = GenerationApplication(
            gateway=PartialGateway(),
            results=results,
        )
        try:
            task_id = application.submit_text(
                TextToImageDraft(
                    prompt="first failure",
                    model_id="qwen-image-3.0-pro",
                    image_count=2,
                )
            )
            task = application.wait_for(task_id, timeout=1)
        finally:
            application.close()

        self.assertEqual(GenerationStatus.PARTIALLY_SUCCEEDED, task.status)
        self.assertEqual(1, len(task.result_paths))
        self.assertIn("第一张结果无法保存", task.error or "")

    def test_removing_completed_task_keeps_disk_result(self) -> None:
        class ImmediateGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                return GatewayGenerationResult(
                    images=(GeneratedImage(PNG_1X1, "image/png"),)
                )

        with TemporaryDirectory() as directory:
            application = GenerationApplication(
                gateway=ImmediateGateway(),
                results=FileResultRepository(Path(directory)),
            )
            try:
                task_id = application.submit_text(
                    TextToImageDraft(prompt="keep file", model_id="qwen-image-3.0-pro")
                )
                task = application.wait_for(task_id, timeout=1)
                result_path = task.result_paths[0]

                self.assertTrue(application.remove_task(task_id))
                self.assertFalse(application.remove_task(task_id))
                self.assertTrue(result_path.is_file())
            finally:
                application.close()


if __name__ == "__main__":
    unittest.main()
