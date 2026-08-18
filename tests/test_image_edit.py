from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from ugc_image_tool.application import GenerationApplication
from ugc_image_tool.capabilities import Workflow
from ugc_image_tool.generation import GeneratedImage, GenerationStatus, ImageEditDraft
from ugc_image_tool.references import inspect_reference_image
from ugc_image_tool.results import FileResultRepository


PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
)


class EditGateway:
    def __init__(self) -> None:
        self.requests = []

    def generate_text(self, request):
        raise AssertionError("图片编辑不应调用文生图入口")

    def generate_image_edit(self, request):
        self.requests.append(request)
        return GeneratedImage(PNG_1X1, "image/png")


class ImageEditTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
