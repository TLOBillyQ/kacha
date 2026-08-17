from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from .generation import GeneratedImage, GenerationTask


class FileResultRepository:
    def __init__(self, output_root: Path) -> None:
        self._output_root = output_root

    def save(self, task: GenerationTask, image: GeneratedImage) -> Path:
        task_directory = self._task_directory(task)
        task_directory.mkdir(parents=True, exist_ok=True)
        suffix = ".png" if image.media_type == "image/png" else ".jpg"
        temporary = task_directory / f"result-1{suffix}.tmp"
        result = task_directory / f"result-1{suffix}"
        temporary.write_bytes(image.content)
        temporary.replace(result)
        return result

    def save_record(self, task: GenerationTask) -> None:
        task_directory = self._task_directory(task)
        task_directory.mkdir(parents=True, exist_ok=True)
        record = task_directory / "task.json"
        record.write_text(
            json.dumps(
                {
                    "task_id": task.task_id,
                    "workflow": "text_to_image",
                    "status": task.status.value,
                    "submitted_at": task.submitted_at.isoformat(),
                    "model": "模拟模型",
                    "prompt": task.prompt,
                    "result_files": [path.name for path in task.result_paths],
                    "error": task.error,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    def _task_directory(self, task: GenerationTask) -> Path:
        date = task.submitted_at.astimezone(UTC).date().isoformat()
        return self._output_root / date / task.task_id
