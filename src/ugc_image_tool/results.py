from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from .generation import GeneratedImage, GenerationTask
from .references import ReferenceImage


class FileResultRepository:
    def __init__(self, output_root: Path) -> None:
        self._output_root = output_root

    def save(self, task: GenerationTask, image: GeneratedImage) -> Path:
        task_directory = self._task_directory(task)
        task_directory.mkdir(parents=True, exist_ok=True)
        suffix = ".png" if image.media_type == "image/png" else ".jpg"
        index = 1
        while any(task_directory.glob(f"result-{index}.*")):
            index += 1
        temporary = task_directory / f"result-{index}{suffix}.tmp"
        result = task_directory / f"result-{index}{suffix}"
        temporary.write_bytes(image.content)
        temporary.replace(result)
        return result

    def save_record(self, task: GenerationTask) -> None:
        task_directory = self._task_directory(task)
        task_directory.mkdir(parents=True, exist_ok=True)
        request = task.request
        size = request.size
        record = task_directory / "task.json"
        record.write_text(
            json.dumps(
                {
                    "task_id": task.task_id,
                    "workflow": task.workflow.value,
                    "status": task.status.value,
                    "submitted_at": task.submitted_at.isoformat(),
                    "model": request.model_id,
                    "capability_version": request.capability_version,
                    "prompt": request.prompt,
                    "negative_prompt": request.negative_prompt,
                    "size": {
                        "mode": size.mode.value,
                        "width": size.width,
                        "height": size.height,
                    },
                    "image_count": request.image_count,
                    "result_files": [path.name for path in task.result_paths],
                    "error": task.error,
                    "reference_files": [reference.path.name for reference in getattr(request, "references", ())],
                    "reference_metadata": [
                        {
                            "file": reference.path.name,
                            "media_type": reference.media_type,
                            "width": reference.width,
                            "height": reference.height,
                            "size_bytes": reference.size_bytes,
                            "warnings": list(reference.warnings),
                        }
                        for reference in getattr(request, "references", ())
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    def save_reference_snapshot(
        self, task_id: str, submitted_at: datetime, reference: ReferenceImage, index: int
    ) -> ReferenceImage:
        task_directory = self._output_root / submitted_at.astimezone(UTC).date().isoformat() / task_id
        task_directory.mkdir(parents=True, exist_ok=True)
        suffix = ".png" if reference.media_type == "image/png" else ".jpg"
        path = task_directory / f"reference-{index}{suffix}"
        path.write_bytes(reference.content)
        return ReferenceImage(
            path=path,
            media_type=reference.media_type,
            width=reference.width,
            height=reference.height,
            size_bytes=reference.size_bytes,
            warnings=reference.warnings,
            content=reference.content,
        )

    def _task_directory(self, task: GenerationTask) -> Path:
        date = task.submitted_at.astimezone(UTC).date().isoformat()
        return self._output_root / date / task.task_id
