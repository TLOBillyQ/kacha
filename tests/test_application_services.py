from __future__ import annotations

import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from ugc_image_tool.capabilities import ModelTier, Workflow
from ugc_image_tool.discovery import GatewayError, GatewayErrorCategory, ModelCache, ModelDiscovery
from ugc_image_tool.generation import (
    GatewayGenerationResult,
    GeneratedImage,
    ImageEditRequest,
    TextToImageDraft,
    TextToImageRequest,
)
from ugc_image_tool.services import ApplicationServices
from ugc_image_tool.settings import DEFAULT_BASE_URL, MemoryCredentialService


class FakeGateway:
    """测试用应用服务网关：模型列表与生成请求都立即成功。"""

    def __init__(self) -> None:
        self.base_url = DEFAULT_BASE_URL
        self.api_key = ""
        self.closed = False
        self.text_requests: list[TextToImageRequest] = []

    def list_models(self) -> tuple[str, ...]:
        return ("qwen-image-3.0-pro",)

    def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
        self.text_requests.append(request)
        return GatewayGenerationResult(
            images=(GeneratedImage(content=b"png", media_type="image/png"),)
        )

    def generate_image_edit(self, request: ImageEditRequest) -> GatewayGenerationResult:
        raise AssertionError("该测试替身只支持文生图")

    def set_base_url(self, value: str) -> None:
        self.base_url = value

    def set_api_key(self, value: str) -> None:
        self.api_key = value

    def close(self) -> None:
        self.closed = True


class FailingProvider:
    def list_models(self) -> tuple[str, ...]:
        raise GatewayError(GatewayErrorCategory.NETWORK, "测试网络不可达")


class BlockingGateway(FakeGateway):
    """生成请求阻塞，直到测试显式放行；用于验证应用服务接缝上的取消。"""

    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def generate_text(self, request: TextToImageRequest) -> GatewayGenerationResult:
        self.started.set()
        self.release.wait(timeout=2)
        return super().generate_text(request)


class ApplicationServicesTests(unittest.TestCase):
    def test_start_composes_settings_and_applies_hot_updates(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gateway = FakeGateway()
            services = ApplicationServices(
                user_data_dir=root / "user-data",
                output_root=root / "output",
                gateway=gateway,
                credentials=MemoryCredentialService(),
            )

            services.start()

            self.assertEqual(root / "output", services.settings.output_root)
            self.assertEqual(3, services.generation.max_concurrency)
            services.set_concurrency_limit(4)
            self.assertEqual(4, services.settings.concurrency_limit)
            self.assertEqual(4, services.generation.max_concurrency)
            services.set_base_url("https://gateway.example.com")
            self.assertEqual("https://gateway.example.com", services.settings.base_url)
            self.assertEqual("https://gateway.example.com", gateway.base_url)
            services.save_api_key("sk-test")
            self.assertEqual("sk-test", services.settings.api_key)
            self.assertEqual("sk-test", gateway.api_key)
            new_root = root / "new-output"
            services.set_output_root(new_root)
            self.assertEqual(new_root, services.results.output_root)
            services.close()

    def test_close_logs_shutdown_and_closes_generation(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gateway = FakeGateway()
            services = ApplicationServices(
                user_data_dir=root / "user-data",
                output_root=root / "output",
                gateway=gateway,
                credentials=MemoryCredentialService(),
            )
            services.start()
            discovery_state = services.discovery.refresh()
            self.assertTrue(discovery_state.online)

            services.close()

            self.assertIs(services.gateway, gateway)
            self.assertTrue(gateway.closed)
            with self.assertRaises(RuntimeError):
                services.generation.submit_text(
                    TextToImageDraft(prompt="关闭后提交", model_id="qwen-image-3.0-pro")
                )

    def test_submit_and_cancel_task_through_application_services(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gateway = BlockingGateway()
            services = ApplicationServices(
                user_data_dir=root / "user-data",
                output_root=root / "output",
                gateway=gateway,
                credentials=MemoryCredentialService(),
            )
            services.start()
            self.assertTrue(services.discovery.refresh().online)

            task_id = services.generation.submit_text(
                TextToImageDraft(prompt="取消测试", model_id="qwen-image-3.0-pro")
            )
            self.assertTrue(gateway.started.wait(timeout=1))
            self.assertTrue(services.generation.has_unfinished_tasks())

            self.assertTrue(services.generation.cancel(task_id))
            gateway.release.set()

            task = services.generation.task(task_id)
            self.assertEqual("cancelled", task.status.value)
            services.close()

    def test_export_diagnostics_through_application_services(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            services = ApplicationServices(
                user_data_dir=root / "user-data",
                output_root=root / "output",
                gateway=FakeGateway(),
                credentials=MemoryCredentialService(),
            )
            services.start()
            target = root / "diagnostics.zip"

            entries = services.diagnostic_exporter.export(target)

            self.assertTrue(target.is_file())
            self.assertTrue(entries)
            services.close()

    def test_submission_block_reason_prefers_output_directory_error(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output_file = root / "not-a-directory"
            output_file.write_text("occupied", encoding="utf-8")
            services = ApplicationServices(
                user_data_dir=root / "user-data",
                output_root=output_file,
                gateway=FakeGateway(),
                credentials=MemoryCredentialService(),
            )

            reason = services.submission_block_reason()

            self.assertIsNotNone(reason)
            assert reason is not None
            self.assertIn("输出根目录", reason)
            services.close()

    def test_offline_submission_block_reason_uses_discovery_state(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            discovery = ModelDiscovery(
                FailingProvider(),
                cache=ModelCache(root / "user-data"),
                max_retries=1,
            )
            services = ApplicationServices(
                user_data_dir=root / "user-data",
                output_root=root / "output",
                gateway=FakeGateway(),
                discovery=discovery,
                credentials=MemoryCredentialService(),
            )
            state = discovery.refresh()

            self.assertFalse(state.online)
            reason = services.submission_block_reason()

            self.assertIsNotNone(reason)
            assert reason is not None
            self.assertIn("离线", reason)
            services.close()


class CapabilityOverrideWiringTests(unittest.TestCase):
    """启动时把能力覆盖文件接线到合并视图；无效覆盖整份拒绝并回退内置表。"""

    def _write_override(self, directory: Path, models: list[dict]) -> None:
        (directory / "capability-override.json").write_text(
            json.dumps({"schema_version": 2, "models": models}, ensure_ascii=False),
            encoding="utf-8",
        )

    def _z_image_turbo_entry(self, **extra) -> dict:
        entry = {
            "model_id": "z-image-turbo",
            "display_name": "快速写实文生图",
            "workflows": [
                {
                    "workflow": "text_to_image",
                    "supports_negative_prompt": False,
                    "min_images": 1,
                    "max_images": 1,
                    "size": {"auto_allowed": True, "presets": [[1024, 1024]]},
                }
            ],
        }
        entry.update(extra)
        return entry

    def _qwen_economy_unshelf_entry(self) -> dict:
        return {
            "model_id": "qwen-image-3.0",
            "display_name": "Qwen Image 3.0 经济版",
            "workflows": [
                {
                    "workflow": "text_to_image",
                    "supports_negative_prompt": False,
                    "min_images": 1,
                    "max_images": 1,
                    "size": {"auto_allowed": True, "presets": [[1024, 1024]]},
                }
            ],
        }

    def test_override_file_in_user_data_dir_is_applied_at_startup(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            user_data = root / "user-data"
            user_data.mkdir()
            self._write_override(
                user_data,
                [self._qwen_economy_unshelf_entry(), self._z_image_turbo_entry(tier="economy")],
            )

            services = ApplicationServices(
                user_data_dir=user_data,
                output_root=root / "output",
                gateway=FakeGateway(),
                credentials=MemoryCredentialService(),
            )

            shelved = services.capabilities.resolve_tier(
                Workflow.TEXT_TO_IMAGE, ModelTier.ECONOMY
            )
            self.assertIsNotNone(shelved)
            assert shelved is not None
            self.assertEqual("z-image-turbo", shelved.model_id)
            self.assertIn("+override-", services.capabilities.version)
            services.close()

    def test_invalid_override_falls_back_to_builtin_table(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            user_data = root / "user-data"
            user_data.mkdir()
            (user_data / "capability-override.json").write_text(
                "{broken json", encoding="utf-8"
            )

            services = ApplicationServices(
                user_data_dir=user_data,
                output_root=root / "output",
                gateway=FakeGateway(),
                credentials=MemoryCredentialService(),
            )

            flagship = services.capabilities.resolve_tier(
                Workflow.TEXT_TO_IMAGE, ModelTier.FLAGSHIP
            )
            self.assertIsNotNone(flagship)
            assert flagship is not None
            self.assertEqual("qwen-image-3.0-pro", flagship.model_id)
            services.close()

    def test_conflicting_override_falls_back_to_builtin_table(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            user_data = root / "user-data"
            user_data.mkdir()
            challenger = {
                "model_id": "flag-challenger",
                "display_name": "旗舰挑战者",
                "tier": "flagship",
                "workflows": [
                    {
                        "workflow": "text_to_image",
                        "supports_negative_prompt": False,
                        "min_images": 1,
                        "max_images": 1,
                        "size": {"auto_allowed": True, "presets": [[1024, 1024]]},
                    }
                ],
            }
            self._write_override(user_data, [challenger])

            services = ApplicationServices(
                user_data_dir=user_data,
                output_root=root / "output",
                gateway=FakeGateway(),
                credentials=MemoryCredentialService(),
            )

            self.assertIsNone(
                services.capabilities.capability("flag-challenger"),
                "整份覆盖被拒绝，冲突模型不得生效",
            )
            services.close()


if __name__ == "__main__":
    unittest.main()