from __future__ import annotations

import json
import unittest
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from ugc_image_tool.capabilities import CAPABILITY_TABLE_VERSION
from ugc_image_tool.generation import (
    GeneratedImage,
    GenerationStatus,
    GenerationTask,
    TextToImageRequest,
)
from ugc_image_tool.results import DownloadedImage, FileResultRepository


PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
)


class FileResultRepositoryTests(unittest.TestCase):
    def test_saves_image_and_non_credential_task_record(self) -> None:
        with TemporaryDirectory() as directory:
            repository = FileResultRepository(Path(directory))
            request = TextToImageRequest(
                prompt="一只蓝色小鸟",
                model_id="qwen-image-3.0-pro",
                capability_version=CAPABILITY_TABLE_VERSION,
                image_count=2,
            )
            task = GenerationTask(
                task_id="task-123",
                request=request,
                submitted_at=datetime(2026, 8, 17, 12, 0, tzinfo=UTC),
                status=GenerationStatus.SUCCEEDED,
                result_paths=(Path("result-1.png"),),
            )

            result = repository.save(task, GeneratedImage(PNG_1X1, "image/png"))
            repository.save_record(task)

            self.assertEqual(PNG_1X1, result.read_bytes())
            record = json.loads((result.parent / "task.json").read_text(encoding="utf-8"))
            self.assertEqual("task-123", record["task_id"])
            self.assertEqual("一只蓝色小鸟", record["prompt"])
            self.assertEqual("qwen-image-3.0-pro", record["model"])
            self.assertEqual(2, record["image_count"])
            self.assertEqual(
                {"mode": "auto", "width": None, "height": None},
                record["size"],
            )
            self.assertNotIn("credential", json.dumps(record))
            self.assertFalse(list(result.parent.glob("*.tmp")))

    def test_saves_multiple_results_without_overwriting(self) -> None:
        with TemporaryDirectory() as directory:
            repository = FileResultRepository(Path(directory))
            task = GenerationTask(
                task_id="task-many",
                request=TextToImageRequest(
                    prompt="two images",
                    model_id="qwen-image-3.0-pro",
                    capability_version=CAPABILITY_TABLE_VERSION,
                    image_count=2,
                ),
                submitted_at=datetime(2026, 8, 17, 12, 0, tzinfo=UTC),
                status=GenerationStatus.SUCCEEDED,
            )

            first = repository.save(task, GeneratedImage(PNG_1X1, "image/png"))
            second = repository.save(task, GeneratedImage(PNG_1X1, "image/png"))

            self.assertEqual("result-1.png", first.name)
            self.assertEqual("result-2.png", second.name)
            self.assertEqual(PNG_1X1, first.read_bytes())
            self.assertEqual(PNG_1X1, second.read_bytes())

    def test_retries_remote_result_until_third_attempt_and_keeps_original_format(self) -> None:
        class Fetcher:
            def __init__(self) -> None:
                self.calls = 0

            def fetch(self, url: str) -> DownloadedImage:
                self.calls += 1
                if self.calls < 3:
                    raise OSError("临时地址尚未可读")
                return DownloadedImage(PNG_1X1, "image/jpeg")

        with TemporaryDirectory() as directory:
            fetcher = Fetcher()
            repository = FileResultRepository(Path(directory), image_fetcher=fetcher)
            task = GenerationTask(
                task_id="task-remote",
                request=TextToImageRequest(
                    prompt="remote",
                    model_id="qwen-image-3.0-pro",
                    capability_version=CAPABILITY_TABLE_VERSION,
                ),
                submitted_at=datetime(2026, 8, 17, 12, 0, tzinfo=UTC),
            )

            result = repository.save(task, GeneratedImage(url="https://example.invalid/image"))

            self.assertEqual(3, fetcher.calls)
            self.assertEqual("result-1.png", result.name)
            self.assertEqual(PNG_1X1, result.read_bytes())
            self.assertFalse(list(result.parent.glob("*.tmp")))

    def test_rejects_invalid_remote_result_after_three_attempts_without_persisting_it(self) -> None:
        class Fetcher:
            def __init__(self) -> None:
                self.calls = 0

            def fetch(self, url: str) -> DownloadedImage:
                self.calls += 1
                return DownloadedImage(b"not an image", "image/png")

        with TemporaryDirectory() as directory:
            fetcher = Fetcher()
            repository = FileResultRepository(Path(directory), image_fetcher=fetcher)
            task = GenerationTask(
                task_id="task-invalid",
                request=TextToImageRequest(
                    prompt="invalid",
                    model_id="qwen-image-3.0-pro",
                    capability_version=CAPABILITY_TABLE_VERSION,
                ),
                submitted_at=datetime(2026, 8, 17, 12, 0, tzinfo=UTC),
            )

            with self.assertRaises(OSError):
                repository.save(task, GeneratedImage(url="https://example.invalid/image"))

            task_directory = Path(directory) / "2026-08-17" / "task-invalid"
            self.assertEqual(3, fetcher.calls)
            self.assertFalse(list(task_directory.glob("*")))

    def test_task_record_contains_request_id_and_redacts_authentication_from_errors(self) -> None:
        with TemporaryDirectory() as directory:
            repository = FileResultRepository(Path(directory))
            task = GenerationTask(
                task_id="task-record",
                request=TextToImageRequest(
                    prompt="record",
                    model_id="qwen-image-3.0-pro",
                    capability_version=CAPABILITY_TABLE_VERSION,
                ),
                submitted_at=datetime(2026, 8, 17, 12, 0, tzinfo=UTC),
                status=GenerationStatus.FAILED,
                error="Authorization: Bearer secret-token; api_key=another-secret",
                gateway_request_id="gateway-request-123",
            )

            repository.save_record(task)
            record_path = Path(directory) / "2026-08-17" / "task-record" / "task.json"
            serialized = record_path.read_text(encoding="utf-8")
            record = json.loads(serialized)

            self.assertEqual("gateway-request-123", record["gateway_request_id"])
            self.assertNotIn("secret-token", serialized)
            self.assertNotIn("another-secret", serialized)
            self.assertNotIn("Authorization:", serialized)


if __name__ == "__main__":
    unittest.main()
