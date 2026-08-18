from __future__ import annotations

import json
import zipfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from ugc_image_tool.application import GenerationApplication
from ugc_image_tool.capabilities import CapabilityRegistry
from ugc_image_tool.diagnostics import (
    DEFAULT_MAX_LOG_BYTES,
    DiagnosticExporter,
    DiagnosticLogger,
    MANIFEST_FILENAME,
    PackageEntry,
    app_version,
)
from ugc_image_tool.discovery import (
    ConnectionStage,
    GatewayError,
    GatewayErrorCategory,
    ModelCache,
    ModelDiscovery,
    run_connection_check,
)
from ugc_image_tool.generation import (
    GatewayGenerationResult,
    GenerationStatus,
    GenerationTask,
    GeneratedImage,
    TextToImageDraft,
    TextToImageRequest,
)
from ugc_image_tool.results import FileResultRepository

PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
)

SK_SECRET = "sk-SENSITIVE-API-KEY-0123456789"
BEARER_SECRET = "SENSITIVE-BEARER-TOKEN-9876"
URL_SECRET = "https://example.invalid/dl/SENSITIVE-URL-TOKEN?expires=9999&sig=abc"
PROMPT_MARKER = "完整提示词 SENSITIVE-PROMPT-CONTENT"
# 真实形状的图片内容：1×1 PNG 的 base64 数据块。
IMAGE_BLOB = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQ"
    "AAAAABJRU5ErkJggg=="
)

KNOWN_MODELS = ("qwen-image-3.0-pro", "wan2.7-image", "z-image-turbo")


def make_draft(prompt: str) -> TextToImageDraft:
    return TextToImageDraft(prompt=prompt, model_id="qwen-image-3.0-pro")


class FakeDiagnostics:
    """测试用诊断接收端：记录事件，不落盘。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, object]]] = []

    def task_transition(
        self,
        task_id: str,
        model: str,
        from_status: str | None,
        to_status: str,
        **kwargs,
    ) -> None:
        self.events.append(
            (
                "task",
                {
                    "task_id": task_id,
                    "model": model,
                    "from_status": from_status,
                    "to_status": to_status,
                    **kwargs,
                },
            )
        )

    def connection(self, **kwargs) -> None:
        self.events.append(("connection", kwargs))

    def download(self, **kwargs) -> None:
        self.events.append(("download", kwargs))

    def system(self, message: str) -> None:
        self.events.append(("system", {"message": message}))


class ScriptedProvider:
    def __init__(self, *outcomes) -> None:
        self.outcomes = list(outcomes)

    def list_models(self):
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class DiagnosticLoggerTests(unittest.TestCase):
    def test_writes_structured_sanitized_entries(self) -> None:
        with TemporaryDirectory() as directory:
            logger = DiagnosticLogger(Path(directory))
            logger.task_transition(
                "task-abc123",
                "qwen-image-3.0-pro",
                "running",
                "failed",
                workflow="text_to_image",
                gateway_request_id="gw-req-001",
                category="auth",
                status_code=401,
                message=(
                    f"鉴权失败 Authorization: Bearer {BEARER_SECRET} "
                    f"{SK_SECRET} {URL_SECRET}"
                ),
            )
            (log_path,) = logger.segments()

            line = log_path.read_text(encoding="utf-8").strip()
            record = json.loads(line)

            self.assertEqual("task", record["event"])
            self.assertEqual("task-abc123", record["task_id"])
            self.assertEqual("qwen-image-3.0-pro", record["model"])
            self.assertEqual("running", record["from_status"])
            self.assertEqual("failed", record["to_status"])
            self.assertEqual("failed", record["status"])
            self.assertEqual("auth", record["category"])
            self.assertEqual(401, record["status_code"])
            self.assertEqual("gw-req-001", record["gateway_request_id"])
            self.assertTrue(record["ts"])
            self.assertTrue(record["app_version"])
            self.assertNotIn(BEARER_SECRET, line)
            self.assertNotIn(SK_SECRET, line)
            self.assertNotIn(URL_SECRET, line)
            self.assertIn("[REDACTED]", line)
            self.assertIn("[REDACTED_URL]", line)

    def test_logs_app_version_from_runtime(self) -> None:
        with TemporaryDirectory() as directory:
            logger = DiagnosticLogger(Path(directory))
            logger.system("启动")
            record = json.loads(logger.segments()[0].read_text(encoding="utf-8"))

            self.assertEqual(app_version(), record["app_version"])
            self.assertTrue(record["app_version"])

    def test_never_records_prompt_or_image_content(self) -> None:
        with TemporaryDirectory() as directory:
            logger = DiagnosticLogger(Path(directory))
            logger.download(
                task_id="task-prompt",
                model="qwen-image-3.0-pro",
                ok=False,
                attempts=3,
                category="result_save",
                message=f"失败：{IMAGE_BLOB}",
            )
            logger.system("应用启动")

            content = logger.segments()[0].read_text(encoding="utf-8")

            # 图片内容（真实 base64 数据块）必须被整体替换。
            self.assertNotIn(IMAGE_BLOB, content)
            self.assertIn("[REDACTED]", content)
            # 日志结构不允许出现提示词或内容字段。
            for line in content.splitlines():
                record = json.loads(line)
                self.assertNotIn("prompt", record)
                self.assertNotIn("content", record)
                self.assertNotIn("image", record)

    def test_rotation_enforces_total_size_cap_and_keeps_newest_segment(self) -> None:
        with TemporaryDirectory() as directory:
            logger = DiagnosticLogger(
                Path(directory),
                max_total_bytes=900,
                segment_bytes=300,
            )
            for index in range(40):
                logger.task_transition(
                    f"task-{index:04d}",
                    "qwen-image-3.0-pro",
                    "running",
                    "succeeded",
                    workflow="text_to_image",
                    gateway_request_id=f"gw-{index:04d}",
                    status_code=200,
                    message="ok",
                )

            segments = logger.segments()

            self.assertGreaterEqual(len(segments), 2)
            self.assertEqual("diagnostics.log", segments[0].name)
            self.assertEqual("diagnostics.1.log", segments[1].name)
            self.assertLessEqual(logger.total_bytes, 900)
            self.assertLessEqual(sum(p.stat().st_size for p in segments), 900)

    def test_unwritable_directory_degrades_silently(self) -> None:
        with TemporaryDirectory() as directory:
            blocked = Path(directory) / "blocked"
            blocked.write_text("不是一个目录", encoding="utf-8")
            logger = DiagnosticLogger(blocked)

            logger.system("不应抛出")

            self.assertEqual(0, logger.total_bytes)
            self.assertEqual((), logger.segments())

    def test_default_caps_are_documented_constants(self) -> None:
        self.assertEqual(512 * 1024, DEFAULT_MAX_LOG_BYTES)
        with self.assertRaises(ValueError):
            DiagnosticLogger(max_total_bytes=2, segment_bytes=4)
        with self.assertRaises(ValueError):
            DiagnosticLogger(max_total_bytes=1, segment_bytes=2)


class DiagnosticExporterTests(unittest.TestCase):
    def test_preview_lists_only_logs_and_manifest(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            logger = DiagnosticLogger(root)
            logger.system("启动")
            exporter = DiagnosticExporter(root)

            preview = exporter.preview()

            self.assertEqual(
                ("diagnostics.log", MANIFEST_FILENAME),
                tuple(entry.name for entry in preview),
            )
            self.assertEqual(logger.total_bytes, preview[0].size)
            self.assertIn("诊断包说明", preview[1].description)

    def test_export_creates_zip_matching_preview_and_re_sanitizes(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            logger = DiagnosticLogger(root)
            logger.task_transition(
                "task-export",
                "qwen-image-3.0-pro",
                "running",
                "failed",
                category="auth",
                message=f"Authorization: Bearer {BEARER_SECRET}；{SK_SECRET}；{URL_SECRET}",
            )
            # 绕过记录器直接写入的未脱敏内容也必须被再次脱敏。
            with (root / "diagnostics.log").open("a", encoding="utf-8") as stream:
                stream.write(
                    f"Authorization: Bearer {BEARER_SECRET} "
                    f"api_key={SK_SECRET} {URL_SECRET}\n"
                )
            exporter = DiagnosticExporter(root)
            target = root / "out" / "diag.zip"

            exported = exporter.export(target)

            self.assertTrue(target.is_file())
            self.assertEqual(
                tuple(entry.name for entry in exporter.preview()),
                tuple(entry.name for entry in exported),
            )
            with zipfile.ZipFile(target) as archive:
                names = archive.namelist()
                self.assertEqual(
                    ("diagnostics.log", MANIFEST_FILENAME),
                    tuple(names),
                )
                log_text = archive.read("diagnostics.log").decode("utf-8")
                self.assertNotIn(SK_SECRET, log_text)
                self.assertNotIn(BEARER_SECRET, log_text)
                self.assertNotIn(URL_SECRET, log_text)
                self.assertIn("[REDACTED]", log_text)
                manifest = json.loads(archive.read(MANIFEST_FILENAME).decode("utf-8"))
                self.assertEqual(1, manifest["schema_version"])
                self.assertTrue(manifest["app_version"])
                self.assertIn("再次执行脱敏", manifest["note"])
                self.assertEqual(
                    ("diagnostics.log", MANIFEST_FILENAME),
                    tuple(item["name"] for item in manifest["files"]),
                )

    def test_export_does_not_collect_other_user_data(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            logger = DiagnosticLogger(root)
            logger.task_transition(
                "task-pack",
                "qwen-image-3.0-pro",
                "queued",
                "running",
            )
            # 目录里存在设置、任务记录与图片，绝不能被装进诊断包。
            (root / "settings.json").write_text(
                json.dumps({"api_key": SK_SECRET}), encoding="utf-8"
            )
            (root / "task.json").write_text(
                json.dumps({"prompt": PROMPT_MARKER}), encoding="utf-8"
            )
            (root / "image.png").write_bytes(PNG_1X1)
            exporter = DiagnosticExporter(root)
            target = root / "diag.zip"

            exported = exporter.export(target)

            self.assertEqual(
                tuple(entry.name for entry in exporter.preview()),
                tuple(entry.name for entry in exported),
            )
            with zipfile.ZipFile(target) as archive:
                names = archive.namelist()
                self.assertNotIn("settings.json", names)
                self.assertNotIn("task.json", names)
                self.assertNotIn("image.png", names)
                content = "".join(
                    archive.read(name).decode("utf-8") for name in names
                )
                self.assertNotIn(SK_SECRET, content)
                self.assertNotIn(PROMPT_MARKER, content)

    def test_export_creates_parent_directories(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            logger = DiagnosticLogger(root)
            logger.system("启动")
            exporter = DiagnosticExporter(root)
            target = root / "nested" / "deeper" / "diag.zip"

            exporter.export(target)

            self.assertTrue(target.is_file())


class DiagnosticsWiringTests(unittest.TestCase):
    def test_task_lifecycle_is_logged_without_mutating_state(self) -> None:
        class IdentifiedGateway:
            def list_models(self) -> tuple[str, ...]:
                return KNOWN_MODELS

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                return GatewayGenerationResult(
                    images=(GeneratedImage(PNG_1X1, "image/png"),),
                    request_id="gateway-request-123",
                )

        with TemporaryDirectory() as directory:
            diagnostics = FakeDiagnostics()
            application = GenerationApplication(
                gateway=IdentifiedGateway(),
                results=FileResultRepository(Path(directory) / "out"),
                diagnostics=diagnostics,
            )
            try:
                task_id = application.submit_text(make_draft(f"标记 {SK_SECRET}"))
                task = application.wait_for(task_id, timeout=5)
            finally:
                application.close()

            self.assertEqual(GenerationStatus.SUCCEEDED, task.status)
            transitions = [
                kwargs
                for kind, kwargs in diagnostics.events
                if kind == "task" and kwargs["task_id"] == task_id
            ]
            self.assertEqual(
                [None, "queued", "running"],
                [item["from_status"] for item in transitions],
            )
            self.assertEqual(
                ["queued", "running", "succeeded"],
                [item["to_status"] for item in transitions],
            )
            self.assertEqual("gateway-request-123", transitions[-1]["gateway_request_id"])
            for kind, kwargs in diagnostics.events:
                serialized = json.dumps(kwargs, ensure_ascii=False)
                self.assertNotIn(SK_SECRET, serialized)
                self.assertNotIn(PROMPT_MARKER, serialized)

    def test_gateway_error_transition_records_category_status_and_request_id(self) -> None:
        class FailingGateway:
            def list_models(self) -> tuple[str, ...]:
                return KNOWN_MODELS

            def generate_text(self, request: TextToImageRequest) -> None:
                raise GatewayError(
                    GatewayErrorCategory.AUTH,
                    f"密钥无效 {SK_SECRET}",
                    gateway_request_id="gw-req-456",
                    status_code=401,
                )

        class InMemoryResults:
            def save(self, task, image: GeneratedImage):
                raise AssertionError("不应保存结果")

            def save_record(self, task) -> None:
                pass

        diagnostics = FakeDiagnostics()
        application = GenerationApplication(
            gateway=FailingGateway(),
            results=InMemoryResults(),
            diagnostics=diagnostics,
        )
        try:
            task_id = application.submit_text(make_draft("鉴权失败"))
            task = application.wait_for(task_id, timeout=5)
        finally:
            application.close()

        self.assertEqual(GenerationStatus.FAILED, task.status)
        final = [
            kwargs
            for kind, kwargs in diagnostics.events
            if kind == "task" and kwargs["task_id"] == task_id
        ][-1]
        self.assertEqual("failed", final["to_status"])
        self.assertEqual("auth", final["category"])
        self.assertEqual(401, final["status_code"])
        self.assertEqual("gw-req-456", final["gateway_request_id"])

    def test_connection_events_are_recorded_by_discovery_and_check(self) -> None:
        with TemporaryDirectory() as directory:
            diagnostics = FakeDiagnostics()
            discovery = ModelDiscovery(
                ScriptedProvider(
                    GatewayError(GatewayErrorCategory.REJECTED, "拒绝", status_code=403)
                ),
                cache=ModelCache(Path(directory)),
                max_retries=1,
                retry_delay=0.0,
                diagnostics=diagnostics,
            )

            discovery.refresh()

            connection_events = [
                kwargs for kind, kwargs in diagnostics.events if kind == "connection"
            ]
            self.assertTrue(connection_events)
            self.assertFalse(connection_events[0]["ok"])
            self.assertEqual("rejected", connection_events[0]["category"])
            self.assertEqual(403, connection_events[0]["status_code"])

        diagnostics = FakeDiagnostics()
        run_connection_check(
            ScriptedProvider(KNOWN_MODELS),
            CapabilityRegistry(),
            diagnostics,
        )
        by_stage = {
            kwargs["stage"]: kwargs
            for kind, kwargs in diagnostics.events
            if kind == "connection"
        }
        self.assertTrue(by_stage[ConnectionStage.DNS_OR_CONNECT.value]["ok"])
        self.assertTrue(by_stage[ConnectionStage.AUTH.value]["ok"])
        self.assertTrue(by_stage[ConnectionStage.MODEL_LIST.value]["ok"])
        self.assertTrue(by_stage[ConnectionStage.CAPABILITY.value]["ok"])

    def test_download_issue_is_logged_without_the_temporary_url(self) -> None:
        class FailingFetcher:
            def fetch(self, url: str):
                raise OSError(f"临时地址不可读：{URL_SECRET}")

        with TemporaryDirectory() as directory:
            root = Path(directory)
            logger = DiagnosticLogger(root / "data")
            repository = FileResultRepository(
                root / "out",
                image_fetcher=FailingFetcher(),  # type: ignore[arg-type]
                diagnostics=logger,
            )
            task = GenerationTask(
                task_id="task-download",
                request=TextToImageRequest(
                    prompt="下载失败",
                    model_id="qwen-image-3.0-pro",
                    capability_version="capabilities-v1",
                ),
                submitted_at=datetime(2026, 8, 17, 12, 0, tzinfo=UTC),
                status=GenerationStatus.RUNNING,
            )

            with self.assertRaises(OSError):
                repository.save(task, GeneratedImage(url=URL_SECRET))

            content = logger.segments()[0].read_text(encoding="utf-8")
            record = json.loads(content)
            self.assertEqual("download", record["event"])
            self.assertEqual("task-download", record["task_id"])
            self.assertFalse(record["ok"])
            self.assertEqual("result_save", record["category"])
            self.assertNotIn(URL_SECRET, content)
            self.assertIn("[REDACTED_URL]", content)

    def test_full_loop_export_contains_no_forbidden_markers(self) -> None:
        class IdentifiedGateway:
            def list_models(self) -> tuple[str, ...]:
                return KNOWN_MODELS

            def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
                return GatewayGenerationResult(
                    images=(GeneratedImage(PNG_1X1, "image/png"),),
                    request_id="gateway-request-999",
                )

        with TemporaryDirectory() as directory:
            root = Path(directory)
            logger = DiagnosticLogger(root / "data")
            application = GenerationApplication(
                gateway=IdentifiedGateway(),
                results=FileResultRepository(root / "out", diagnostics=logger),
                diagnostics=logger,
            )
            try:
                task_id = application.submit_text(
                    make_draft(f"敏感提示词 {PROMPT_MARKER}")
                )
                application.wait_for(task_id, timeout=5)
            finally:
                application.close()
            logger.system(f"标记 {SK_SECRET} Bearer {BEARER_SECRET} {URL_SECRET}")

            exporter = DiagnosticExporter(root / "data")
            target = root / "diag.zip"
            exporter.export(target)

            with zipfile.ZipFile(target) as archive:
                content = "".join(
                    archive.read(name).decode("utf-8") for name in archive.namelist()
                )
            self.assertNotIn(SK_SECRET, content)
            self.assertNotIn(BEARER_SECRET, content)
            self.assertNotIn(URL_SECRET, content)
            self.assertNotIn(PROMPT_MARKER, content)
            self.assertIn("[REDACTED]", content)


if __name__ == "__main__":
    unittest.main()