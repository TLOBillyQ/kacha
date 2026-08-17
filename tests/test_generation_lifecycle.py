from __future__ import annotations

import threading
import time
import unittest
from dataclasses import dataclass
from pathlib import Path

from ugc_image_tool.application import GenerationApplication
from ugc_image_tool.generation import GenerationStatus, GeneratedImage


@dataclass
class FakeGateway:
    image: GeneratedImage
    started: threading.Event

    def generate_text(self, prompt: str) -> GeneratedImage:
        self.started.set()
        return self.image


class InMemoryResultRepository:
    def __init__(self) -> None:
        self.saved: list[tuple[str, str, GeneratedImage]] = []
        self.records = []

    def save(self, task, image: GeneratedImage) -> Path:
        path = Path("2026-08-17") / task.task_id / "result-1.png"
        self.saved.append((task.task_id, task.prompt, image))
        return path

    def save_record(self, task) -> None:
        self.records.append(task)


class GenerationLifecycleTests(unittest.TestCase):
    def test_prompt_creates_independent_task_and_saves_result(self) -> None:
        gateway = FakeGateway(
            image=GeneratedImage(content=b"png-data", media_type="image/png"),
            started=threading.Event(),
        )
        repository = InMemoryResultRepository()
        visible_statuses = []
        application = GenerationApplication(
            gateway=gateway,
            results=repository,
            on_task_changed=lambda task: visible_statuses.append(task.status),
        )

        task_id = application.submit_text("一只蓝色小鸟")

        self.assertTrue(gateway.started.wait(timeout=1))
        task = application.wait_for(task_id, timeout=1)
        self.assertEqual(GenerationStatus.SUCCEEDED, task.status)
        self.assertEqual("一只蓝色小鸟", task.prompt)
        self.assertEqual(Path("2026-08-17") / task_id / "result-1.png", task.result_paths[0])
        self.assertEqual([(task_id, "一只蓝色小鸟", gateway.image)], repository.saved)
        self.assertEqual([GenerationStatus.SUCCEEDED], [record.status for record in repository.records])
        self.assertEqual(
            [GenerationStatus.QUEUED, GenerationStatus.RUNNING, GenerationStatus.SUCCEEDED],
            visible_statuses,
        )

    def test_submit_does_not_wait_for_gateway_work(self) -> None:
        release = threading.Event()

        class BlockingGateway:
            def generate_text(self, prompt: str) -> GeneratedImage:
                release.wait(timeout=1)
                return GeneratedImage(b"png-data", "image/png")

        application = GenerationApplication(
            gateway=BlockingGateway(),
            results=InMemoryResultRepository(),
        )

        task_id = application.submit_text("后台生成")

        self.assertIn(
            application.task(task_id).status,
            (GenerationStatus.QUEUED, GenerationStatus.RUNNING),
        )
        release.set()
        self.assertEqual(
            GenerationStatus.SUCCEEDED,
            application.wait_for(task_id, timeout=1).status,
        )

    def test_gateway_failure_is_visible_as_failed_task(self) -> None:
        class FailingGateway:
            def generate_text(self, prompt: str) -> GeneratedImage:
                raise RuntimeError("模拟网关不可用")

        repository = InMemoryResultRepository()
        visible_statuses = []
        application = GenerationApplication(
            gateway=FailingGateway(),
            results=repository,
            on_task_changed=lambda task: visible_statuses.append(task.status),
        )

        task_id = application.submit_text("测试失败")
        task = application.wait_for(task_id, timeout=1)

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertEqual("模拟网关不可用", task.error)
        self.assertEqual(GenerationStatus.FAILED, repository.records[0].status)
        self.assertEqual(
            [GenerationStatus.QUEUED, GenerationStatus.RUNNING, GenerationStatus.FAILED],
            visible_statuses,
        )

    def test_record_failure_does_not_report_success(self) -> None:
        class FailingRecordRepository(InMemoryResultRepository):
            def save_record(self, task) -> None:
                raise OSError("任务记录不可写")

        gateway = FakeGateway(
            image=GeneratedImage(content=b"png-data", media_type="image/png"),
            started=threading.Event(),
        )
        application = GenerationApplication(
            gateway=gateway,
            results=FailingRecordRepository(),
        )

        task = application.wait_for(application.submit_text("记录失败"), timeout=1)

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertEqual("任务记录不可写", task.error)

    def test_close_does_not_wait_for_running_gateway_work(self) -> None:
        started = threading.Event()
        release = threading.Event()

        class BlockingGateway:
            def generate_text(self, prompt: str) -> GeneratedImage:
                started.set()
                release.wait(timeout=1)
                return GeneratedImage(b"png-data", "image/png")

        application = GenerationApplication(
            gateway=BlockingGateway(),
            results=InMemoryResultRepository(),
        )
        application.submit_text("关闭窗口")
        self.assertTrue(started.wait(timeout=1))

        before = time.monotonic()
        application.close()
        elapsed = time.monotonic() - before
        release.set()

        self.assertLess(elapsed, 0.1)


if __name__ == "__main__":
    unittest.main()
