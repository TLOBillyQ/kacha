from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from ugc_image_tool.application import GenerationApplication
from ugc_image_tool.generation import GatewayGenerationResult, GeneratedImage, ImageEditDraft, TextToImageDraft
from ugc_image_tool.settings import (
    DEFAULT_BASE_URL,
    DEFAULT_CONCURRENCY_LIMIT,
    MemoryCredentialService,
    SettingsApplication,
    SettingsStore,
    SettingsStoreError,
    default_output_root,
    default_user_data_dir,
    validate_base_url,
    validate_concurrency_limit,
)


class SettingsDefaultsTests(unittest.TestCase):
    def test_defaults_apply_when_no_settings_file_exists(self) -> None:
        with TemporaryDirectory() as directory:
            store = SettingsStore(Path(directory))
            settings = store.settings

            self.assertEqual(default_output_root(), settings.output_root)
            self.assertEqual(DEFAULT_BASE_URL, settings.base_url)
            self.assertEqual(DEFAULT_CONCURRENCY_LIMIT, settings.concurrency_limit)
            self.assertTrue((Path(directory)).is_dir())
            self.assertFalse(store.storage_path.exists())

    def test_default_output_root_lives_under_pictures(self) -> None:
        self.assertEqual(
            Path.home() / "Pictures" / "UGC AI 生图工具",
            default_output_root(),
        )

    def test_default_user_data_dir_uses_localappdata(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"LOCALAPPDATA": "C:\\Users\\tester\\AppData\\Local"},
            clear=False,
        ):
            self.assertEqual(
                Path("C:\\Users\\tester\\AppData\\Local") / "ugc-image-tool",
                default_user_data_dir(),
            )


class SettingsPersistenceTests(unittest.TestCase):
    def test_settings_survive_reloading_from_user_data_directory(self) -> None:
        with TemporaryDirectory() as directory:
            user_data_dir = Path(directory)
            store = SettingsStore(user_data_dir)
            store.save_output_root(Path(directory) / "out")
            store.save_base_url("https://gateway.example.com:8443/")
            store.save_concurrency_limit(5)

            reloaded = SettingsStore(user_data_dir).settings

            self.assertEqual(Path(directory) / "out", reloaded.output_root)
            self.assertEqual("https://gateway.example.com:8443", reloaded.base_url)
            self.assertEqual(5, reloaded.concurrency_limit)
            self.assertTrue((user_data_dir / "settings.json").is_file())

    def test_settings_survive_program_directory_replacement(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            program_dir = root / "program"
            user_data_dir = root / "user-data"
            program_dir.mkdir()
            (program_dir / "version.txt").write_text("old", encoding="utf-8")
            store = SettingsStore(user_data_dir)
            store.save_output_root(root / "out")
            store.save_concurrency_limit(6)

            (program_dir / "version.txt").unlink()
            program_dir.rmdir()
            program_dir.mkdir()
            (program_dir / "version.txt").write_text("new", encoding="utf-8")

            reloaded = SettingsStore(user_data_dir).settings

            self.assertEqual(root / "out", reloaded.output_root)
            self.assertEqual(6, reloaded.concurrency_limit)

    def test_base_url_trailing_slash_is_normalized(self) -> None:
        with TemporaryDirectory() as directory:
            store = SettingsStore(Path(directory))
            store.save_base_url("http://lzxsvn.com:3001/")
            self.assertEqual("http://lzxsvn.com:3001", store.settings.base_url)


class SettingsValidationTests(unittest.TestCase):
    def test_concurrency_limit_rejects_out_of_range_values(self) -> None:
        with TemporaryDirectory() as directory:
            store = SettingsStore(Path(directory))
            for invalid in (0, 7, True, "3"):
                with self.assertRaises(ValueError):
                    store.save_concurrency_limit(invalid)  # type: ignore[arg-type]

    def test_concurrency_limit_accepts_one_to_six(self) -> None:
        for value in (1, 3, 6):
            self.assertEqual(value, validate_concurrency_limit(value))

    def test_base_url_rejects_invalid_values(self) -> None:
        for invalid in ("", "   ", "ftp://lzxsvn.com", "not-a-url", "//host"):
            with self.assertRaises(ValueError):
                validate_base_url(invalid)

    def test_base_url_accepts_http_and_https(self) -> None:
        self.assertEqual("http://lzxsvn.com:3001", validate_base_url("http://lzxsvn.com:3001"))
        self.assertEqual("https://gateway.example.com", validate_base_url("https://gateway.example.com/"))

    def test_invalid_settings_file_is_rejected_as_a_whole(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text('{"schema_version": 1, "concurrency_limit": 99}', encoding="utf-8")
            with self.assertRaises(SettingsStoreError):
                SettingsStore(Path(directory))

    def test_wrong_schema_version_is_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text('{"schema_version": 999}', encoding="utf-8")
            with self.assertRaises(SettingsStoreError):
                SettingsStore(Path(directory))


class SettingsApplicationTests(unittest.TestCase):
    def test_api_key_is_kept_only_in_credential_service(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            user_data_dir = root / "userdata"
            output_root = root / "output"
            credentials = MemoryCredentialService()
            application = SettingsApplication(
                SettingsStore(user_data_dir),
                credentials,
            )
            application.set_output_root(output_root)
            application.set_base_url("http://lzxsvn.com:3001")
            application.set_concurrency_limit(4)
            application.save_api_key("sk-test-secret-123")

            self.assertEqual("sk-test-secret-123", credentials.api_key())
            persisted = (user_data_dir / "settings.json").read_text(encoding="utf-8")
            self.assertNotIn("sk-test-secret-123", persisted)
            for file in sorted(root.rglob("*")):
                if file.is_file():
                    self.assertNotIn("sk-test-secret-123", file.read_text(encoding="utf-8"))

    def test_api_key_overwrite_and_clear(self) -> None:
        with TemporaryDirectory() as directory:
            credentials = MemoryCredentialService()
            application = SettingsApplication(SettingsStore(Path(directory)), credentials)
            application.save_api_key("first")
            application.save_api_key("second")
            self.assertEqual("second", application.api_key)
            application.clear_api_key()
            self.assertIsNone(application.api_key)

    def test_empty_api_key_is_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            application = SettingsApplication(
                SettingsStore(Path(directory)),
                MemoryCredentialService(),
            )
            with self.assertRaises(ValueError):
                application.save_api_key("   ")

    def test_set_output_root_persists_and_creates_directory(self) -> None:
        with TemporaryDirectory() as directory:
            application = SettingsApplication(
                SettingsStore(Path(directory)),
                MemoryCredentialService(),
            )
            output = Path(directory) / "nested" / "output"
            application.set_output_root(output)
            self.assertEqual(output, application.output_root)
            self.assertIsNone(application.output_directory_error())
            self.assertTrue(output.is_dir())

    def test_output_directory_error_guides_user_to_settings_when_unwritable(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            blocked = root / "blocked"
            blocked.write_text("not a directory", encoding="utf-8")
            application = SettingsApplication(
                SettingsStore(root),
                MemoryCredentialService(),
            )
            application.set_output_root(blocked)

            error = application.output_directory_error()

            self.assertIsNotNone(error)
            self.assertIn("设置", error or "")
            self.assertIn(str(blocked), error or "")

    def test_output_directory_error_returns_none_when_writable(self) -> None:
        with TemporaryDirectory() as directory:
            application = SettingsApplication(
                SettingsStore(Path(directory)),
                MemoryCredentialService(),
            )
            application.set_output_root(Path(directory) / "out")
            self.assertIsNone(application.output_directory_error())


class SubmissionGuardTests(unittest.TestCase):
    def test_guard_blocks_submit_text_with_actionable_message(self) -> None:
        application = GenerationApplication(
            gateway=_StubGateway(),
            results=_StubResults(),
            submission_guard=lambda: "输出根目录不可写：请到设置页修改输出根目录",
        )
        with self.assertRaises(ValueError) as raised:
            application.submit_text(TextToImageDraft(prompt="测试", model_id="qwen-image-3.0-pro"))
        self.assertIn("设置页", str(raised.exception))
        application.close()

    def test_guard_blocks_submit_edit(self) -> None:
        application = GenerationApplication(
            gateway=_StubGateway(),
            results=_StubResults(),
            submission_guard=lambda: "输出根目录不可写：请到设置页修改输出根目录",
        )
        with self.assertRaises(ValueError) as raised:
            application.submit_edit(
                ImageEditDraft(
                    prompt="编辑",
                    model_id="qwen-image-3.0-pro",
                    reference_paths=(Path("reference.png"),),
                )
            )
        self.assertIn("设置页", str(raised.exception))
        application.close()

    def test_guard_allows_submission_when_output_is_writable(self) -> None:
        application = GenerationApplication(
            gateway=_StubGateway(),
            results=_StubResults(),
            submission_guard=lambda: None,
        )
        task_id = application.submit_text(
            TextToImageDraft(prompt="测试", model_id="qwen-image-3.0-pro")
        )
        application.wait_for(task_id, timeout=1)
        self.assertEqual("测试", application.task(task_id).prompt)
        application.close()


class _StubGateway:
    def generate_text(self, request) -> GatewayGenerationResult:
        return GatewayGenerationResult(
            images=(GeneratedImage(content=b"png-data", media_type="image/png"),)
        )

    def generate_image_edit(self, request) -> GatewayGenerationResult:
        return GatewayGenerationResult(
            images=(GeneratedImage(content=b"png-data", media_type="image/png"),)
        )


class _StubResults:
    def save(self, task, image):
        return Path("result") / task.task_id / "result-1.png"

    def save_record(self, task) -> None:
        pass

    def save_reference_snapshot(self, task_id, submitted_at, reference, index):
        return reference

    def close(self) -> None:
        pass


if __name__ == "__main__":
    unittest.main()
