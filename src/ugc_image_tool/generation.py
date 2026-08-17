from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path


class GenerationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True)
class GeneratedImage:
    content: bytes
    media_type: str


@dataclass(frozen=True)
class GenerationTask:
    task_id: str
    prompt: str
    submitted_at: datetime
    status: GenerationStatus = GenerationStatus.QUEUED
    result_paths: tuple[Path, ...] = ()
    error: str | None = None

    def with_status(
        self,
        status: GenerationStatus,
        *,
        result_paths: tuple[Path, ...] = (),
        error: str | None = None,
    ) -> GenerationTask:
        return GenerationTask(
            task_id=self.task_id,
            prompt=self.prompt,
            submitted_at=self.submitted_at,
            status=status,
            result_paths=result_paths,
            error=error,
        )
