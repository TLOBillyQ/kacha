"""任务中心操作策略，不依赖 Qt 控件状态。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from ..generation import GenerationStatus


class PrimaryTaskAction(StrEnum):
    CANCEL = "cancel"
    COPY_RESULT = "copy_result"
    REMOVE = "remove"


@dataclass(frozen=True)
class TaskActionPolicy:
    primary: PrimaryTaskAction
    show_result_actions: bool
    allow_removal: bool


def task_action_policy(
    status: GenerationStatus,
    *,
    has_usable_result: bool,
) -> TaskActionPolicy:
    is_active = status in {GenerationStatus.QUEUED, GenerationStatus.RUNNING}
    if is_active:
        primary = PrimaryTaskAction.CANCEL
    elif has_usable_result:
        primary = PrimaryTaskAction.COPY_RESULT
    else:
        primary = PrimaryTaskAction.REMOVE
    return TaskActionPolicy(
        primary=primary,
        show_result_actions=has_usable_result,
        allow_removal=not is_active,
    )
