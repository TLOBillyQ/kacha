from __future__ import annotations

import json
import threading
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

from ugc_image_tool.application import GenerationApplication
from ugc_image_tool.capabilities import (
    CAPABILITY_TABLE_VERSION,
    CapabilityRegistry,
)
from ugc_image_tool.discovery import GatewayError, GatewayErrorCategory
from ugc_image_tool.generation import (
    GatewayGenerationResult,
    GenerationStatus,
    GeneratedImage,
    GenerationTask,
    ImageEditRequest,
    TextToImageDraft,
    TextToImageRequest,
)

Z_IMAGE_TURBO_OVERRIDE = {
    "schema_version": 2,
    "models": [
        {
            "model_id": "z-image-turbo",
            "display_name": "快速写实文生图",
            "workflows": [
                {
                    "workflow": "text_to_image",
                    "supports_negative_prompt": False,
                    "min_images": 1,
                    "max_images": 1,
                    "size": {"auto_allowed": True, "presets": [[1024, 1024]]},
                }
            ],
        }
    ],
}


def make_draft(prompt: str, model_id: str = "qwen-image-3.0-pro", **overrides: object) -> TextToImageDraft:
    draft = TextToImageDraft(prompt=prompt, model_id=model_id)
    for key, value in overrides.items():
        setattr(draft, key, value)
    return draft


@dataclass
class FakeGateway:
    image: GeneratedImage
    started: threading.Event

    def __init__(self, image: GeneratedImage) -> None:
        self.image = image
        self.started = threading.Event()
        self.requests: list[TextToImageRequest] = []

    def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
        raise AssertionError("该测试替身只支持文生图")

    def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
        self.requests.append(request)
        self.started.set()
        return GatewayGenerationResult(images=(self.image,))


class InMemoryResultRepository:
    def __init__(self) -> None:
        self.saved: list[tuple[str, str, GeneratedImage]] = []
        self.records: list[GenerationTask] = []

    def save(self, task, image: GeneratedImage) -> Path:
        path = Path("2026-08-17") / task.task_id / "result-1.png"
        self.saved.append((task.task_id, task.prompt, image))
        return path

    def save_record(self, task) -> None:
        self.records.append(task)

    def save_reference_snapshot(self, task_id, submitted_at, reference, index):
        return reference


class GenerationLifecycleTests(unittest.TestCase):
    def test_prompt_creates_independent_task_and_saves_result(self) -> None:
        gateway = FakeGateway(image=GeneratedImage(content=b"png-data", media_type="image/png"))
        repository = InMemoryResultRepository()
        visible_statuses = []
        application = GenerationApplication(
            gateway=gateway,
            results=repository,
            on_task_changed=lambda task: visible_statuses.append(task.status),
        )

        task_id = application.submit_text(make_draft("一只蓝色小鸟"))

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
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                release.wait(timeout=1)
                return GatewayGenerationResult(
                    images=(GeneratedImage(b"png-data", "image/png"),)
                )

        application = GenerationApplication(
            gateway=BlockingGateway(),
            results=InMemoryResultRepository(),
        )

        task_id = application.submit_text(make_draft("后台生成"))

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
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                raise RuntimeError("模拟网关不可用")

        repository = InMemoryResultRepository()
        visible_statuses = []
        application = GenerationApplication(
            gateway=FailingGateway(),
            results=repository,
            on_task_changed=lambda task: visible_statuses.append(task.status),
        )

        task_id = application.submit_text(make_draft("测试失败"))
        task = application.wait_for(task_id, timeout=1)

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertEqual("模拟网关不可用", task.error)
        self.assertEqual(GenerationStatus.FAILED, repository.records[0].status)
        self.assertEqual(
            [GenerationStatus.QUEUED, GenerationStatus.RUNNING, GenerationStatus.FAILED],
            visible_statuses,
        )

    def test_record_failure_keeps_saved_result_status(self) -> None:
        class FailingRecordRepository(InMemoryResultRepository):
            def save_record(self, task) -> None:
                raise OSError("任务记录不可写")

        application = GenerationApplication(
            gateway=FakeGateway(image=GeneratedImage(content=b"png-data", media_type="image/png")),
            results=FailingRecordRepository(),
        )

        task = application.wait_for(application.submit_text(make_draft("记录失败")), timeout=1)

        self.assertEqual(GenerationStatus.SUCCEEDED, task.status)
        self.assertIn("任务记录不可写", task.error or "")
        self.assertEqual(1, len(task.result_paths))

    def test_close_does_not_wait_for_running_gateway_work(self) -> None:
        started = threading.Event()
        release = threading.Event()

        class BlockingGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                started.set()
                release.wait(timeout=1)
                return GatewayGenerationResult(
                    images=(GeneratedImage(b"png-data", "image/png"),)
                )

        application = GenerationApplication(
            gateway=BlockingGateway(),
            results=InMemoryResultRepository(),
        )
        application.submit_text(make_draft("关闭窗口"))
        self.assertTrue(started.wait(timeout=1))

        before = time.monotonic()
        application.close()
        elapsed = time.monotonic() - before
        release.set()

        self.assertLess(elapsed, 0.1)


class SubmissionCapabilityTests(unittest.TestCase):
    def test_gateway_receives_frozen_snapshot_with_capability_version(self) -> None:
        gateway = FakeGateway(image=GeneratedImage(content=b"png-data", media_type="image/png"))
        application = GenerationApplication(
            gateway=gateway,
            results=InMemoryResultRepository(),
        )

        task_id = application.submit_text(make_draft("快照", image_count=2))
        application.wait_for(task_id, timeout=1)

        self.assertTrue(gateway.requests)
        request = gateway.requests[0]

        self.assertEqual("快照", request.prompt)
        self.assertEqual("qwen-image-3.0-pro", request.model_id)
        self.assertEqual(CAPABILITY_TABLE_VERSION, request.capability_version)
        self.assertEqual(2, request.image_count)
        self.assertIn(("watermark", False), request.params)

    def test_unsupported_draft_fields_are_filtered_before_gateway(self) -> None:
        with TemporaryDirectory() as directory:
            override = Path(directory) / "override.json"
            override.write_text(json.dumps(Z_IMAGE_TURBO_OVERRIDE), encoding="utf-8")
            gateway = FakeGateway(image=GeneratedImage(content=b"png-data", media_type="image/png"))
            application = GenerationApplication(
                gateway=gateway,
                results=InMemoryResultRepository(),
                capabilities=CapabilityRegistry(override),
            )

            task_id = application.submit_text(
                make_draft("快速写实", model_id="z-image-turbo", negative_prompt="不要文字")
            )
            application.wait_for(task_id, timeout=1)

        self.assertEqual(1, len(gateway.requests))
        request = gateway.requests[0]
        self.assertIsNone(request.negative_prompt)
        self.assertEqual((), request.params)

    def test_unknown_model_cannot_be_submitted(self) -> None:
        application = GenerationApplication(
            gateway=FakeGateway(image=GeneratedImage(content=b"png-data", media_type="image/png")),
            results=InMemoryResultRepository(),
        )

        with self.assertRaises(ValueError) as raised:
            application.submit_text(make_draft("未知模型", model_id="wan2.7-image"))

        self.assertIn("模型未配置", str(raised.exception))

    def test_invalid_image_count_cannot_be_submitted(self) -> None:
        application = GenerationApplication(
            gateway=FakeGateway(image=GeneratedImage(content=b"png-data", media_type="image/png")),
            results=InMemoryResultRepository(),
        )

        with self.assertRaises(ValueError) as raised:
            application.submit_text(make_draft("超量", image_count=9))

        self.assertIn("出图数量", str(raised.exception))

    def test_draft_mutations_after_submit_do_not_affect_snapshot(self) -> None:
        gateway = FakeGateway(image=GeneratedImage(content=b"png-data", media_type="image/png"))
        application = GenerationApplication(
            gateway=gateway,
            results=InMemoryResultRepository(),
        )
        draft = make_draft("原始提示词", negative_prompt="旧负向")
        task_id = application.submit_text(draft)

        draft.prompt = "改过的提示词"
        draft.negative_prompt = None
        application.wait_for(task_id, timeout=1)

        self.assertEqual("原始提示词", gateway.requests[0].prompt)
        self.assertEqual("旧负向", gateway.requests[0].negative_prompt)
        self.assertEqual("原始提示词", application.task(task_id).prompt)

    def test_gateway_request_id_is_kept_in_task_record(self) -> None:
        class IdentifiedGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                return GatewayGenerationResult(
                    images=(GeneratedImage(b"png-data", "image/png"),),
                    request_id="gateway-request-123",
                )

        results = InMemoryResultRepository()
        application = GenerationApplication(
            gateway=IdentifiedGateway(),
            results=results,
        )
        try:
            task_id = application.submit_text(make_draft("identified"))
            task = application.wait_for(task_id, timeout=1)
        finally:
            application.close()

        self.assertEqual(GenerationStatus.SUCCEEDED, task.status)
        self.assertEqual("gateway-request-123", task.gateway_request_id)
        self.assertEqual("gateway-request-123", results.records[0].gateway_request_id)

    def test_invalid_result_with_request_id_keeps_that_id_in_failed_record(self) -> None:
        class InvalidIdentifiedGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                return GatewayGenerationResult(
                    images=(object(),),  # type: ignore[arg-type]
                    request_id="gateway-request-invalid",
                )

        results = InMemoryResultRepository()
        application = GenerationApplication(
            gateway=InvalidIdentifiedGateway(),
            results=results,
        )
        try:
            task_id = application.submit_text(make_draft("invalid identified"))
            task = application.wait_for(task_id, timeout=1)
        finally:
            application.close()

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertEqual("gateway-request-invalid", task.gateway_request_id)
        self.assertEqual("gateway-request-invalid", results.records[0].gateway_request_id)


class GatewayErrorHandlingTests(unittest.TestCase):
    def _run_with_error(self, error: Exception) -> GenerationTask:
        class RaisingGateway:
            def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
                raise AssertionError("该测试替身只支持文生图")

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                raise error

        application = GenerationApplication(
            gateway=RaisingGateway(),
            results=InMemoryResultRepository(),
        )
        try:
            task_id = application.submit_text(make_draft("网关错误分类"))
            return application.wait_for(task_id, timeout=1)
        finally:
            application.close()

    def test_auth_error_fails_task_with_auth_message(self) -> None:
        task = self._run_with_error(
            GatewayError(GatewayErrorCategory.AUTH, "无效令牌")
        )

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertIn("鉴权失败", task.error or "")

    def test_network_error_marks_task_unknown(self) -> None:
        task = self._run_with_error(
            GatewayError(GatewayErrorCategory.NETWORK, "连接中断")
        )

        self.assertEqual(GenerationStatus.UNKNOWN, task.status)
        self.assertIn("连接中断", task.error or "")

    def test_rejected_error_fails_task_with_rejection_message(self) -> None:
        task = self._run_with_error(
            GatewayError(GatewayErrorCategory.REJECTED, "模型不可用")
        )

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertIn("网关拒绝", task.error or "")

    def test_server_error_fails_task_with_server_message(self) -> None:
        task = self._run_with_error(
            GatewayError(GatewayErrorCategory.SERVER, "网关繁忙")
        )

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertIn("网关服务错误", task.error or "")

    def test_503_no_available_channel_stays_failed(self) -> None:
        task = self._run_with_error(
            GatewayError(
                GatewayErrorCategory.SERVER,
                "无可用渠道",
                status_code=503,
            )
        )

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertIn("网关服务错误", task.error or "")
        self.assertIn("无可用渠道", task.error or "")

    def test_ambiguous_server_errors_mark_task_unknown(self) -> None:
        for status in (500, 502, 504):
            with self.subTest(status=status):
                task = self._run_with_error(
                    GatewayError(
                        GatewayErrorCategory.SERVER_UNKNOWN,
                        f"网关返回 {status}",
                        status_code=status,
                    )
                )

                self.assertEqual(GenerationStatus.UNKNOWN, task.status)
                self.assertIn("结果未知", task.error or "")
                self.assertIn(str(status), task.error or "")

    def test_config_error_fails_task_with_config_message(self) -> None:
        task = self._run_with_error(
            GatewayError(GatewayErrorCategory.CONFIG, "地址无效")
        )

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertIn("配置错误", task.error or "")

    def test_unknown_category_error_marks_task_unknown(self) -> None:
        task = self._run_with_error(
            GatewayError(GatewayErrorCategory.UNKNOWN, "结果未知")
        )

        self.assertEqual(GenerationStatus.UNKNOWN, task.status)
        self.assertIn("结果未知", task.error or "")

    def test_gateway_error_request_id_is_kept_in_failed_task(self) -> None:
        task = self._run_with_error(
            GatewayError(
                GatewayErrorCategory.AUTH,
                "无效令牌",
                gateway_request_id="gw-req-456",
            )
        )

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertEqual("gw-req-456", task.gateway_request_id)


if __name__ == "__main__":
    unittest.main()
