from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from ugc_image_tool.presets import (
    PresetProject,
    PresetApplication,
    ProjectPreset,
    PromptPresetEditor,
    PresetStore,
    PresetStoreError,
)


class PresetCatalogTests(unittest.TestCase):
    def test_presets_have_required_metadata_and_group_only_projects_with_content(self) -> None:
        danzi = ProjectPreset(
            preset_id="danzi-cute-ui",
            display_name="可爱 UI",
            project=PresetProject.EGG_PARTY,
            prompt="明亮、可爱的 UI 插画",
            negative_prompt="模糊",
            read_only=True,
        )
        with TemporaryDirectory() as directory:
            store = PresetStore(Path(directory), builtins=[danzi])

            self.assertEqual("danzi-cute-ui", danzi.preset_id)
            self.assertEqual("可爱 UI", danzi.display_name)
            self.assertEqual(PresetProject.EGG_PARTY, danzi.project)
            self.assertEqual("明亮、可爱的 UI 插画", danzi.prompt)
            self.assertEqual("模糊", danzi.negative_prompt)
            self.assertEqual(
                {PresetProject.EGG_PARTY: (danzi,)},
                store.grouped_presets(),
            )


class PersonalPresetPersistenceTests(unittest.TestCase):
    def test_personal_preset_survives_reloading_from_user_data_directory(self) -> None:
        with TemporaryDirectory() as directory:
            user_data_dir = Path(directory)
            store = PresetStore(user_data_dir, builtins=[])
            self.assertTrue(user_data_dir.is_dir())

            personal = store.create_personal(
                "我的 UI 起点",
                PresetProject.EGG_PARTY,
                "保留清晰轮廓",
                "模糊、低清晰度",
            )

            reloaded = PresetStore(user_data_dir, builtins=[])

            self.assertFalse(personal.read_only)
            self.assertEqual((personal,), reloaded.personal_presets)
            self.assertTrue((user_data_dir / "presets.json").is_file())

    def test_personal_preset_survives_program_directory_replacement(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            program_dir = root / "program"
            user_data_dir = root / "user-data"
            program_dir.mkdir()
            (program_dir / "version.txt").write_text("old", encoding="utf-8")
            store = PresetStore(user_data_dir, builtins=[])
            personal = store.create_personal(
                "升级后仍在",
                PresetProject.THOUSAND_STARS,
                "保留个人内容",
            )

            (program_dir / "version.txt").unlink()
            program_dir.rmdir()
            program_dir.mkdir()
            (program_dir / "version.txt").write_text("new", encoding="utf-8")

            reloaded = PresetStore(user_data_dir, builtins=[])

            self.assertEqual((personal,), reloaded.personal_presets)

    def test_builtin_can_be_copied_but_not_updated_or_deleted(self) -> None:
        builtin = ProjectPreset(
            preset_id="qianxing-confirmed",
            display_name="千星风格",
            project=PresetProject.THOUSAND_STARS,
            prompt="经过确认的千星风格",
            read_only=True,
        )
        with TemporaryDirectory() as directory:
            store = PresetStore(Path(directory), builtins=[builtin])

            copied = store.copy_as_personal(builtin.preset_id, "我的千星风格")
            updated = store.update_personal(
                copied.preset_id,
                prompt="我的修改",
                negative_prompt="不要水印",
            )

            self.assertFalse(copied.read_only)
            self.assertNotEqual(builtin.preset_id, copied.preset_id)
            self.assertEqual("我的修改", updated.prompt)
            self.assertEqual("不要水印", updated.negative_prompt)
            with self.assertRaises(PermissionError):
                store.update_personal(builtin.preset_id, prompt="不能改")
            with self.assertRaises(PermissionError):
                store.delete_personal(builtin.preset_id)
            with self.assertRaises(PermissionError):
                store.copy_as_personal(copied.preset_id)

            store.delete_personal(copied.preset_id)
            self.assertEqual((), store.personal_presets)

    def test_invalid_personal_file_is_rejected_as_a_whole(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "presets.json"
            path.write_text(
                '{"schema_version": 1, "presets": ['
                '{"preset_id": "valid", "display_name": "有效", '
                '"project": "egg_party", "prompt": "有效"}, '
                '{"preset_id": "broken", "display_name": "", '
                '"project": "egg_party", "prompt": "无效"}'
                ']}',
                encoding="utf-8",
            )

            with self.assertRaises(PresetStoreError):
                PresetStore(Path(directory), builtins=[])


class PromptPresetEditorTests(unittest.TestCase):
    def test_dirty_editor_requires_confirmation_before_replacing_prompts(self) -> None:
        editor = PromptPresetEditor("原始提示词", "原始负向")
        editor.mark_submitted()
        editor.update("尚未提交的修改", "新的负向")
        preset = ProjectPreset(
            preset_id="preset-1",
            display_name="确认预设",
            project=PresetProject.EGG_PARTY,
            prompt="预设正向",
            negative_prompt="预设负向",
            read_only=True,
        )

        self.assertTrue(editor.has_unsubmitted_changes)
        self.assertFalse(editor.apply_preset(preset, confirm_discard=lambda: False))
        self.assertEqual("尚未提交的修改", editor.values.prompt)
        self.assertTrue(editor.apply_preset(preset, confirm_discard=lambda: True))
        self.assertEqual("预设正向", editor.values.prompt)
        self.assertEqual("预设负向", editor.values.negative_prompt)

    def test_submitted_editor_applies_preset_without_confirmation(self) -> None:
        editor = PromptPresetEditor("已提交", None)
        preset = ProjectPreset(
            preset_id="preset-2",
            display_name="无修改预设",
            project=PresetProject.THOUSAND_STARS,
            prompt="新正向",
        )

        self.assertTrue(editor.apply_preset(preset))
        self.assertEqual("新正向", editor.values.prompt)
        self.assertIsNone(editor.values.negative_prompt)


class PresetApplicationTests(unittest.TestCase):
    def test_application_service_applies_a_preset_without_qt(self) -> None:
        with TemporaryDirectory() as directory:
            preset = ProjectPreset(
                preset_id="application-preset",
                display_name="应用层预设",
                project=PresetProject.EGG_PARTY,
                prompt="应用层正向",
                negative_prompt="应用层负向",
                read_only=True,
            )
            application = PresetApplication(
                PresetStore(Path(directory), builtins=[preset])
            )
            application.update_prompt("未提交修改", "旧负向")

            self.assertFalse(
                application.apply_preset(preset.preset_id, confirm_discard=lambda: False)
            )
            self.assertTrue(
                application.apply_preset(preset.preset_id, confirm_discard=lambda: True)
            )
            self.assertEqual("应用层正向", application.prompt_values.prompt)
            self.assertEqual("应用层负向", application.prompt_values.negative_prompt)


if __name__ == "__main__":
    unittest.main()
