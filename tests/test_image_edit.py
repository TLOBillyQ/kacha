from __future__ import annotations

import json
import struct
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from ugc_image_tool.application import GenerationApplication
from ugc_image_tool.capabilities import Workflow
from ugc_image_tool.generation import (
    GatewayGenerationResult,
    GeneratedImage,
    GenerationStatus,
    ImageEditDraft,
    ImageEditRequest,
    SizeMode,
)
from ugc_image_tool.references import inspect_reference_image
from ugc_image_tool.results import FileResultRepository


PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
)


class EditGateway:
    def __init__(self) -> None:
        self.requests: list[ImageEditRequest] = []

    def generate_text(self, request) -> GatewayGenerationResult:
        raise AssertionError("图片编辑不应调用文生图入口")

    def generate_image_edit(self, request) -> GatewayGenerationResult:
        self.requests.append(request)
        return GatewayGenerationResult(
            images=(GeneratedImage(PNG_1X1, "image/png"),)
        )


class ImageEditTests(unittest.TestCase):
    def test_reference_warning_uses_2048px_advisory_upper_bound(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "reference.png"
            content = bytearray(PNG_1X1)
            content[16:24] = struct.pack(">II", 2049, 384)
            path.write_bytes(content)

            reference = inspect_reference_image(path)

            self.assertEqual((2049, 384), (reference.width, reference.height))
            self.assertIn("384～2048px", reference.warnings[0])

    def test_reference_metadata_and_size_limit(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "reference.png"
            path.write_bytes(PNG_1X1)
            reference = inspect_reference_image(path)
            self.assertEqual((1, 1), (reference.width, reference.height))
            self.assertEqual("image/png", reference.media_type)

            with self.assertRaises(ValueError):
                inspect_reference_image(path, max_bytes=1)

    def test_edit_submission_copies_ordered_snapshots(self) -> None:
        with TemporaryDirectory() as directory:
            source = Path(directory) / "reference.png"
            source.write_bytes(PNG_1X1)
            gateway = EditGateway()
            output = Path(directory) / "output"
            application = GenerationApplication(
                gateway=gateway,
                results=FileResultRepository(output),
            )
            try:
                task_id = application.submit_edit(
                    ImageEditDraft(
                        prompt="保留构图",
                        model_id="qwen-image-3.0-pro",
                        reference_paths=(source,),
                    )
                )
                source.write_bytes(b"changed")
                task = application.wait_for(task_id, timeout=1)
            finally:
                application.close()

            self.assertEqual(GenerationStatus.SUCCEEDED, task.status)
            request = gateway.requests[0]
            self.assertEqual(Workflow.IMAGE_EDIT, task.workflow)
            self.assertEqual((1, 1), (request.references[0].width, request.references[0].height))
            self.assertEqual(PNG_1X1, request.references[0].path.read_bytes())
            record = json.loads((output / task.submitted_at.date().isoformat() / task_id / "task.json").read_text())
            self.assertEqual("image_edit", record["workflow"])
            self.assertEqual(["reference-1.png"], record["reference_files"])

    def test_edit_submission_forwards_negative_prompt(self) -> None:
        with TemporaryDirectory() as directory:
            source = Path(directory) / "reference.png"
            source.write_bytes(PNG_1X1)
            gateway = EditGateway()
            application = GenerationApplication(
                gateway=gateway,
                results=FileResultRepository(Path(directory) / "output"),
            )
            try:
                task_id = application.submit_edit(
                    ImageEditDraft(
                        prompt="保留构图",
                        model_id="qwen-image-3.0-pro",
                        negative_prompt="不要模糊",
                        reference_paths=(source,),
                    )
                )
                task = application.wait_for(task_id, timeout=1)
            finally:
                application.close()

            self.assertEqual(GenerationStatus.SUCCEEDED, task.status)
            self.assertEqual("不要模糊", gateway.requests[0].negative_prompt)

    def test_image_edit_only_uses_models_with_image_edit_capability(self) -> None:
        with self.assertRaises(ValueError) as raised:
            from ugc_image_tool.application import GenerationApplication
            from ugc_image_tool.generation import TextToImageDraft

            application = GenerationApplication(gateway=EditGateway(), results=FileResultRepository(Path(".")))
            try:
                application.submit_edit(
                    ImageEditDraft(
                        prompt="x",
                        model_id="z-image-turbo",
                        reference_paths=(),
                    )
                )
            finally:
                application.close()
        self.assertIn("图片编辑", str(raised.exception))


class EditContractEnforcementTests(unittest.TestCase):
    """提交前按已实测契约拒绝未验证草稿，且不得留下任何任务或快照副作用。"""

    def _application(self, output: Path) -> GenerationApplication:
        application = GenerationApplication(
            gateway=EditGateway(),
            results=FileResultRepository(output),
        )
        self.addCleanup(application.close)
        return application

    def _write_png(self, directory: Path, name: str) -> Path:
        path = Path(directory) / name
        path.write_bytes(PNG_1X1)
        return path

    def _assert_no_side_effects(self, application: GenerationApplication, output: Path) -> None:
        self.assertEqual((), application.tasks())
        if output.exists():
            self.assertEqual([], list(output.iterdir()))

    def test_four_references_rejected_before_snapshot_or_task(self) -> None:
        """能力表开放 1～3 张参考图；第 4 张在提交前拒绝且无副作用。"""
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            application = self._application(output)
            references = tuple(
                self._write_png(root, f"reference-{index}.png") for index in range(4)
            )

            with self.assertRaises(ValueError) as raised:
                application.submit_edit(
                    ImageEditDraft(
                        prompt="保留构图",
                        model_id="qwen-image-3.0-pro",
                        reference_paths=references,
                    )
                )

            self.assertIn("参考图", str(raised.exception))
            self._assert_no_side_effects(application, output)

    def test_negative_prompt_rejected_before_snapshot_or_task(self) -> None:
        """能力表收紧（如 override 关闭负向提示词）时应用层拒绝且无副作用。"""
        from ugc_image_tool.capabilities import CapabilityRegistry

        override = {
            "schema_version": 2,
            "models": [
                {
                    "model_id": "qwen-image-3.0-pro",
                    "display_name": "Qwen Image 3.0",
                    "workflows": [
                        {
                            "workflow": "image_edit",
                            "supports_negative_prompt": False,
                            "min_images": 1,
                            "max_images": 1,
                            "size": {"auto_allowed": True, "presets": []},
                            "reference_limits": {"min_references": 1, "max_references": 1},
                        }
                    ],
                }
            ],
        }
        with TemporaryDirectory() as directory:
            root = Path(directory)
            override_path = root / "override.json"
            override_path.write_text(json.dumps(override, ensure_ascii=False), encoding="utf-8")
            output = root / "output"
            application = GenerationApplication(
                gateway=EditGateway(),
                results=FileResultRepository(output),
                capabilities=CapabilityRegistry(override_path),
            )
            self.addCleanup(application.close)
            reference = self._write_png(root, "reference.png")

            with self.assertRaises(ValueError) as raised:
                application.submit_edit(
                    ImageEditDraft(
                        prompt="保留构图",
                        model_id="qwen-image-3.0-pro",
                        negative_prompt="不要模糊",
                        reference_paths=(reference,),
                    )
                )

            self.assertIn("负向提示词", str(raised.exception))
            self._assert_no_side_effects(application, output)

    def test_out_of_range_custom_size_rejected_before_snapshot_or_task(self) -> None:
        """尺寸已开放预设与边界内自定义；越界自定义尺寸在提交前拒绝且无副作用。"""
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            application = self._application(output)
            reference = self._write_png(root, "reference.png")

            with self.assertRaises(ValueError):
                application.submit_edit(
                    ImageEditDraft(
                        prompt="保留构图",
                        model_id="qwen-image-3.0-pro",
                        size_mode=SizeMode.CUSTOM,
                        size_width=100,
                        size_height=100,
                        reference_paths=(reference,),
                    )
                )

            self._assert_no_side_effects(application, output)

    def test_image_count_six_rejected_before_snapshot_or_task(self) -> None:
        """出图数量开放到 5；第 6 张在提交前拒绝且无副作用。"""
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            application = self._application(output)
            reference = self._write_png(root, "reference.png")

            with self.assertRaises(ValueError) as raised:
                application.submit_edit(
                    ImageEditDraft(
                        prompt="保留构图",
                        model_id="qwen-image-3.0-pro",
                        image_count=6,
                        reference_paths=(reference,),
                    )
                )

            self.assertIn("出图数量", str(raised.exception))
            self._assert_no_side_effects(application, output)

    def test_verified_edit_draft_still_succeeds_end_to_end(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            gateway = EditGateway()
            application = GenerationApplication(
                gateway=gateway,
                results=FileResultRepository(output),
            )
            self.addCleanup(application.close)
            reference = self._write_png(root, "reference.png")

            task_id = application.submit_edit(
                ImageEditDraft(
                    prompt="保留构图",
                    model_id="qwen-image-3.0-pro",
                    size_mode=SizeMode.AUTO,
                    image_count=1,
                    reference_paths=(reference,),
                )
            )
            task = application.wait_for(task_id, timeout=1)

            self.assertEqual(GenerationStatus.SUCCEEDED, task.status)
            self.assertEqual(1, len(gateway.requests))
            request = gateway.requests[0]
            self.assertIsNone(request.negative_prompt)
            self.assertEqual(SizeMode.AUTO, request.size.mode)
            self.assertEqual(1, request.image_count)
            self.assertEqual(1, len(request.references))
            task_directory = output / task.submitted_at.date().isoformat() / task_id
            self.assertTrue((task_directory / "reference-1.png").is_file())


class GenerateSubmissionTests(unittest.TestCase):
    """合并页统一提交入口：参考图数量定任务类型（验收口径 #1 类型判定边界）。"""

    def _dual_gateway(self):
        class DualGateway:
            def __init__(self) -> None:
                self.text_requests: list = []
                self.edit_requests: list = []

            def generate_text(self, request) -> GatewayGenerationResult:
                self.text_requests.append(request)
                return GatewayGenerationResult(images=(GeneratedImage(PNG_1X1, "image/png"),))

            def generate_image_edit(self, request) -> GatewayGenerationResult:
                self.edit_requests.append(request)
                return GatewayGenerationResult(images=(GeneratedImage(PNG_1X1, "image/png"),))

        return DualGateway()

    def test_no_reference_routes_to_text_to_image(self) -> None:
        with TemporaryDirectory() as directory:
            gateway = self._dual_gateway()
            application = GenerationApplication(
                gateway=gateway,
                results=FileResultRepository(Path(directory)),
            )
            try:
                task_id = application.submit_generate(
                    ImageEditDraft(prompt="无参考图", model_id="qwen-image-3.0-pro")
                )
                task = application.wait_for(task_id, timeout=1)
            finally:
                application.close()

        self.assertEqual(GenerationStatus.SUCCEEDED, task.status)
        self.assertEqual(Workflow.TEXT_TO_IMAGE, task.workflow)
        self.assertEqual(1, len(gateway.text_requests))
        self.assertEqual([], gateway.edit_requests)

    def test_reference_routes_to_image_edit(self) -> None:
        with TemporaryDirectory() as directory:
            source = Path(directory) / "reference.png"
            source.write_bytes(PNG_1X1)
            gateway = self._dual_gateway()
            application = GenerationApplication(
                gateway=gateway,
                results=FileResultRepository(Path(directory) / "output"),
            )
            try:
                task_id = application.submit_generate(
                    ImageEditDraft(
                        prompt="有参考图",
                        model_id="qwen-image-3.0-pro",
                        reference_paths=(source,),
                    )
                )
                task = application.wait_for(task_id, timeout=1)
            finally:
                application.close()

        self.assertEqual(GenerationStatus.SUCCEEDED, task.status)
        self.assertEqual(Workflow.IMAGE_EDIT, task.workflow)
        self.assertEqual(1, len(gateway.edit_requests))
        self.assertEqual([], gateway.text_requests)

    def test_reference_rejected_for_model_without_edit_workflow(self) -> None:
        """只支持文生图的模型提交参考图，在服务层被拒（验收口径 #2 兜底）。"""
        with TemporaryDirectory() as directory:
            source = Path(directory) / "reference.png"
            source.write_bytes(PNG_1X1)
            application = GenerationApplication(
                gateway=EditGateway(),
                results=FileResultRepository(Path(directory)),
            )
            self.addCleanup(application.close)
            with self.assertRaises(ValueError) as raised:
                application.submit_generate(
                    ImageEditDraft(
                        prompt="x",
                        model_id="z-image-turbo",
                        reference_paths=(source,),
                    )
                )
        self.assertIn("图片编辑", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
