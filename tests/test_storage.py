from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from ugc_image_tool.storage import atomic_write_bytes, atomic_write_text


class AtomicWriteTextTests(unittest.TestCase):
    def test_writes_content_and_replaces_target_atomically(self) -> None:
        with TemporaryDirectory() as directory:
            target = Path(directory) / "settings.json"
            target.write_text("旧内容", encoding="utf-8", newline="")

            atomic_write_text(target, "新内容\n", newline="")

            self.assertEqual("新内容\n", target.read_text(encoding="utf-8"))
            # 成功后不留下临时文件。
            self.assertFalse(list(Path(directory).glob("*.tmp")))

    def test_creates_missing_parent_directories(self) -> None:
        with TemporaryDirectory() as directory:
            target = Path(directory) / "nested" / "deeper" / "file.txt"

            atomic_write_text(target, "内容")

            self.assertEqual("内容", target.read_text(encoding="utf-8"))

    def test_fsync_failure_leaves_existing_target_untouched_and_removes_temp(self) -> None:
        with TemporaryDirectory() as directory:
            target = Path(directory) / "out.txt"
            target.write_text("既有内容", encoding="utf-8", newline="")

            with mock.patch("ugc_image_tool.storage.os.fsync", side_effect=OSError("fsync 失败")):
                with self.assertRaises(OSError):
                    atomic_write_text(target, "新内容\n")

            self.assertEqual("既有内容", target.read_text(encoding="utf-8"))
            self.assertFalse(list(Path(directory).glob("*.tmp")))

    def test_replace_failure_propagates_and_removes_temp(self) -> None:
        with TemporaryDirectory() as directory:
            target = Path(directory) / "out.txt"
            target.write_text("既有内容", encoding="utf-8", newline="")

            with mock.patch("ugc_image_tool.storage.os.replace", side_effect=OSError("rename 失败")):
                with self.assertRaises(OSError):
                    atomic_write_text(target, "新内容\n")

            self.assertEqual("既有内容", target.read_text(encoding="utf-8"))
            self.assertFalse(list(Path(directory).glob("*.tmp")))


class AtomicWriteBytesTests(unittest.TestCase):
    def test_writes_bytes_exactly_and_replaces_target(self) -> None:
        with TemporaryDirectory() as directory:
            target = Path(directory) / "image.png"
            target.write_bytes(b"stale")
            payload = bytes(range(256))

            atomic_write_bytes(target, payload)

            self.assertEqual(payload, target.read_bytes())
            self.assertFalse(list(Path(directory).glob("*.tmp")))

    def test_write_failure_removes_temp_and_keeps_previous_target(self) -> None:
        with TemporaryDirectory() as directory:
            target = Path(directory) / "image.png"
            target.write_bytes(b"old-bytes")

            with mock.patch("ugc_image_tool.storage.os.fsync", side_effect=OSError("磁盘已满")):
                with self.assertRaises(OSError):
                    atomic_write_bytes(target, b"new-bytes")

            self.assertEqual(b"old-bytes", target.read_bytes())
            self.assertFalse(list(Path(directory).glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
