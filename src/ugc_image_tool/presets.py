from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Any, Callable, Iterable, cast
from uuid import uuid4

from .settings import default_user_data_dir
from .storage import atomic_write_text


_PRESET_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class _Unset:
    pass


_UNSET = _Unset()


class PresetProject(StrEnum):
    EGG_PARTY = "egg_party"
    THOUSAND_STARS = "thousand_stars"

    @property
    def display_name(self) -> str:
        return {
            PresetProject.EGG_PARTY: "蛋仔派对",
            PresetProject.THOUSAND_STARS: "千星",
        }[self]


@dataclass(frozen=True)
class ProjectPreset:
    preset_id: str
    display_name: str
    project: PresetProject
    prompt: str
    negative_prompt: str | None = None
    read_only: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.preset_id, str) or not _PRESET_ID_PATTERN.fullmatch(
            self.preset_id
        ):
            raise ValueError("预设 ID 必须是稳定的非空标识符")
        if not isinstance(self.display_name, str) or not self.display_name.strip():
            raise ValueError("预设显示名称不能为空")
        try:
            project = PresetProject(self.project)
        except (TypeError, ValueError) as error:
            raise ValueError("预设项目必须是蛋仔派对或千星") from error
        if not isinstance(self.prompt, str) or not self.prompt.strip():
            raise ValueError("预设正向提示词不能为空")
        if self.negative_prompt is not None and not isinstance(self.negative_prompt, str):
            raise ValueError("预设负向提示词必须是字符串或空值")
        if not isinstance(self.read_only, bool):
            raise ValueError("预设只读标记必须是布尔值")
        object.__setattr__(self, "project", project)
        object.__setattr__(self, "display_name", self.display_name.strip())
        if self.negative_prompt is not None:
            object.__setattr__(self, "negative_prompt", self.negative_prompt.strip() or None)

    @property
    def positive_prompt(self) -> str:
        return self.prompt

    @property
    def is_builtin(self) -> bool:
        return self.read_only


# 在获得美术确认内容前保持为空，避免发布占位提示词。
BUILTIN_PRESETS: tuple[ProjectPreset, ...] = ()


@dataclass(frozen=True)
class PromptValues:
    prompt: str
    negative_prompt: str | None = None


class PromptPresetEditor:
    """应用层提示词编辑接缝，跟踪上次提交后的未提交修改。"""

    def __init__(self, prompt: str = "", negative_prompt: str | None = None) -> None:
        initial = PromptValues(prompt, negative_prompt)
        self._current = initial
        self._submitted = initial

    @property
    def values(self) -> PromptValues:
        return self._current

    @property
    def has_unsubmitted_changes(self) -> bool:
        return self._current != self._submitted

    def update(self, prompt: str, negative_prompt: str | None = None) -> None:
        self._current = PromptValues(prompt, negative_prompt)

    def mark_submitted(self) -> None:
        self._submitted = self._current

    def apply_preset(
        self,
        preset: ProjectPreset,
        *,
        confirm_discard: Callable[[], bool] | None = None,
    ) -> bool:
        if self.has_unsubmitted_changes and (
            confirm_discard is None or not confirm_discard()
        ):
            return False
        self._current = PromptValues(preset.prompt, preset.negative_prompt)
        return True


class PresetStoreError(ValueError):
    pass


class PresetStore:
    """只保存个人预设；内置预设由程序发布内容提供且永远不可写。"""

    SCHEMA_VERSION = 1
    FILENAME = "presets.json"

    def __init__(
        self,
        user_data_dir: Path | None = None,
        *,
        builtins: Iterable[ProjectPreset] = BUILTIN_PRESETS,
    ) -> None:
        self._user_data_dir = Path(user_data_dir) if user_data_dir is not None else default_user_data_dir()
        self._storage_path = self._user_data_dir / self.FILENAME
        self._builtins = _prepare_builtins(builtins)
        try:
            self._user_data_dir.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise PresetStoreError(f"无法创建用户数据目录：{self._user_data_dir}") from error
        self._personal = self._load_personal()

    @property
    def builtin_presets(self) -> tuple[ProjectPreset, ...]:
        return self._builtins

    @property
    def personal_presets(self) -> tuple[ProjectPreset, ...]:
        return self._personal

    @property
    def storage_path(self) -> Path:
        return self._storage_path

    def all_presets(self) -> tuple[ProjectPreset, ...]:
        return (*self._builtins, *self._personal)

    def grouped_presets(self) -> dict[PresetProject, tuple[ProjectPreset, ...]]:
        grouped: dict[PresetProject, tuple[ProjectPreset, ...]] = {}
        for preset in self.all_presets():
            grouped[preset.project] = (*grouped.get(preset.project, ()), preset)
        return grouped

    def get(self, preset_id: str) -> ProjectPreset | None:
        return next((preset for preset in self.all_presets() if preset.preset_id == preset_id), None)

    def create_personal(
        self,
        display_name: str,
        project: PresetProject,
        prompt: str,
        negative_prompt: str | None = None,
        *,
        preset_id: str | None = None,
    ) -> ProjectPreset:
        candidate = ProjectPreset(
            preset_id=preset_id or f"personal-{uuid4().hex}",
            display_name=display_name,
            project=project,
            prompt=prompt,
            negative_prompt=negative_prompt,
        )
        if self.get(candidate.preset_id) is not None:
            raise PresetStoreError(f"预设 ID 已存在：{candidate.preset_id}")
        self._replace_personal((*self._personal, candidate))
        return candidate

    def copy_as_personal(
        self,
        preset_id: str,
        display_name: str | None = None,
    ) -> ProjectPreset:
        source = self.get(preset_id)
        if source is None:
            raise KeyError(preset_id)
        if not source.read_only:
            raise PermissionError("只能复制内置预设为个人预设")
        return self.create_personal(
            display_name or source.display_name,
            source.project,
            source.prompt,
            source.negative_prompt,
        )

    def update_personal(
        self,
        preset_id: str,
        *,
        display_name: str | None = None,
        project: PresetProject | None = None,
        prompt: str | None = None,
        negative_prompt: str | None | _Unset = _UNSET,
    ) -> ProjectPreset:
        current = self._require_personal(preset_id)
        if negative_prompt is _UNSET:
            updated_negative_prompt = current.negative_prompt
        else:
            updated_negative_prompt = cast(str | None, negative_prompt)
        updated = ProjectPreset(
            preset_id=current.preset_id,
            display_name=display_name if display_name is not None else current.display_name,
            project=project if project is not None else current.project,
            prompt=prompt if prompt is not None else current.prompt,
            negative_prompt=updated_negative_prompt,
        )
        self._replace_personal(
            tuple(updated if item.preset_id == preset_id else item for item in self._personal)
        )
        return updated

    def delete_personal(self, preset_id: str) -> None:
        self._require_personal(preset_id)
        self._replace_personal(tuple(item for item in self._personal if item.preset_id != preset_id))

    def _require_personal(self, preset_id: str) -> ProjectPreset:
        builtin = next((item for item in self._builtins if item.preset_id == preset_id), None)
        if builtin is not None:
            raise PermissionError("内置预设只读，不能修改")
        personal = next((item for item in self._personal if item.preset_id == preset_id), None)
        if personal is None:
            raise KeyError(preset_id)
        return personal

    def _replace_personal(self, personal: tuple[ProjectPreset, ...]) -> None:
        self._persist(personal)
        self._personal = personal

    def _load_personal(self) -> tuple[ProjectPreset, ...]:
        if not self._storage_path.is_file():
            return ()
        try:
            raw = json.loads(self._storage_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PresetStoreError(f"无法读取个人预设：{error}") from error
        if not isinstance(raw, dict) or raw.get("schema_version") != self.SCHEMA_VERSION:
            raise PresetStoreError("个人预设文件版本无效")
        entries = raw.get("presets")
        if not isinstance(entries, list):
            raise PresetStoreError("个人预设文件的 presets 必须是数组")
        personal: list[ProjectPreset] = []
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise PresetStoreError(f"个人预设 {index} 必须是对象")
            if entry.get("read_only", False):
                raise PresetStoreError("个人预设不能包含只读标记")
            try:
                preset = ProjectPreset(
                    preset_id=entry["preset_id"],
                    display_name=entry["display_name"],
                    project=entry["project"],
                    prompt=entry["prompt"],
                    negative_prompt=entry.get("negative_prompt"),
                )
            except (KeyError, TypeError, ValueError) as error:
                raise PresetStoreError(f"个人预设 {index} 无效：{error}") from error
            if any(item.preset_id == preset.preset_id for item in (*self._builtins, *personal)):
                raise PresetStoreError(f"个人预设 ID 重复：{preset.preset_id}")
            personal.append(preset)
        return tuple(personal)

    def _persist(self, personal: tuple[ProjectPreset, ...]) -> None:
        content = json.dumps(
            {
                "schema_version": self.SCHEMA_VERSION,
                "presets": [_serialize_preset(preset) for preset in personal],
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n"
        try:
            atomic_write_text(self._storage_path, content)
        except OSError as error:
            raise PresetStoreError(f"无法保存个人预设：{error}") from error


class PresetApplication:
    """连接预设仓储与提示词编辑行为的应用层服务。"""

    def __init__(self, store: PresetStore) -> None:
        self._store = store
        self._editor = PromptPresetEditor()

    @property
    def prompt_values(self) -> PromptValues:
        return self._editor.values

    def update_prompt(self, prompt: str, negative_prompt: str | None = None) -> None:
        self._editor.update(prompt, negative_prompt)

    def mark_prompt_submitted(self) -> None:
        self._editor.mark_submitted()

    def grouped_presets(self) -> dict[PresetProject, tuple[ProjectPreset, ...]]:
        return self._store.grouped_presets()

    def first_builtin(self) -> ProjectPreset | None:
        return next(iter(self._store.builtin_presets), None)

    def get(self, preset_id: str) -> ProjectPreset | None:
        return self._store.get(preset_id)

    def apply_preset(
        self,
        preset_id: str,
        *,
        confirm_discard: Callable[[], bool] | None = None,
    ) -> bool:
        preset = self._store.get(preset_id)
        if preset is None:
            raise KeyError(preset_id)
        return self._editor.apply_preset(preset, confirm_discard=confirm_discard)

    def save_personal_preset(
        self,
        display_name: str,
        project: PresetProject,
    ) -> ProjectPreset:
        """把当前提示词草稿保存为新的个人预设。"""
        values = self._editor.values
        return self._store.create_personal(
            display_name,
            project,
            values.prompt,
            values.negative_prompt,
        )

    def copy_builtin_as_personal(
        self,
        preset_id: str,
        display_name: str | None = None,
    ) -> ProjectPreset:
        return self._store.copy_as_personal(preset_id, display_name)

    def update_personal_preset(
        self,
        preset_id: str,
        display_name: str,
    ) -> ProjectPreset:
        """把当前提示词草稿写回个人预设。"""
        values = self._editor.values
        return self._store.update_personal(
            preset_id,
            display_name=display_name,
            prompt=values.prompt,
            negative_prompt=values.negative_prompt,
        )

    def delete_personal_preset(self, preset_id: str) -> None:
        self._store.delete_personal(preset_id)


def _prepare_builtins(builtins: Iterable[ProjectPreset]) -> tuple[ProjectPreset, ...]:
    prepared: list[ProjectPreset] = []
    seen: set[str] = set()
    for preset in builtins:
        readonly = replace(preset, read_only=True)
        if readonly.preset_id in seen:
            raise PresetStoreError(f"内置预设 ID 重复：{readonly.preset_id}")
        seen.add(readonly.preset_id)
        prepared.append(readonly)
    return tuple(prepared)


def _serialize_preset(preset: ProjectPreset) -> dict[str, Any]:
    return {
        "preset_id": preset.preset_id,
        "display_name": preset.display_name,
        "project": preset.project.value,
        "prompt": preset.prompt,
        "negative_prompt": preset.negative_prompt,
    }
