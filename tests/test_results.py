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
from ugc_image_tool.results import FileResultRepository


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

            result = repository.save(task, GeneratedImage(b"png-data", "image/png"))
            repository.save_record(task)

            self.assertEqual(b"png-data", result.read_bytes())
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

            first = repository.save(task, GeneratedImage(b"first", "image/png"))
            second = repository.save(task, GeneratedImage(b"second", "image/png"))

            self.assertEqual("result-1.png", first.name)
            self.assertEqual("result-2.png", second.name)
            self.assertEqual(b"first", first.read_bytes())
            self.assertEqual(b"second", second.read_bytes())


if __name__ == "__main__":
    unittest.main()
