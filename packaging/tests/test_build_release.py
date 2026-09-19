"""build_release：平台识别、命令参数、产物路径与 release/ 目录逻辑（不跑真实构建）。"""

from __future__ import annotations

import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path

from _support import make_release_dir

import build_release
from release_meta import read_checksums


class DetectPlatformTest(unittest.TestCase):
    def test_supported_hosts(self) -> None:
        self.assertEqual(build_release.detect_platform("Windows", "AMD64"), "win-x64")
        self.assertEqual(build_release.detect_platform("Darwin", "arm64"), "macos-arm64")

    def test_refuses_other_hosts(self) -> None:
        for system, machine in (("Linux", "x86_64"), ("Darwin", "x86_64"), ("Windows", "ARM64")):
            with self.subTest(system=system, machine=machine):
                with self.assertRaises(SystemExit):
                    build_release.detect_platform(system, machine)


class CommandAndPathTest(unittest.TestCase):
    def test_windows_builds_without_bundle(self) -> None:
        self.assertEqual(build_release.tauri_build_args("win-x64"), ["tauri", "build", "--no-bundle", "--target", "x86_64-pc-windows-msvc"])
        self.assertEqual(
            build_release.product_path(Path("/repo"), "win-x64"),
            Path("/repo/client/src-tauri/target/x86_64-pc-windows-msvc/release/kacha.exe"),
        )

    def test_macos_builds_app_bundle_for_apple_silicon(self) -> None:
        args = build_release.tauri_build_args("macos-arm64")
        self.assertEqual(args, ["tauri", "build", "--bundles", "app", "--target", "aarch64-apple-darwin"])
        self.assertEqual(
            build_release.product_path(Path("/repo"), "macos-arm64"),
            Path(
                "/repo/client/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Kacha.app"
            ),
        )


class ReleaseDirTest(unittest.TestCase):
    def test_refuses_zip_of_another_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            release_dir = make_release_dir(Path(temp), "0.1.0", "win-x64")
            with self.assertRaises(SystemExit) as ctx:
                build_release.ensure_no_foreign_zips(release_dir, "0.2.0")
            self.assertIn("0.1.0", str(ctx.exception))
            build_release.ensure_no_foreign_zips(release_dir, "0.1.0")

    def test_windows_zip_contains_single_exe(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            exe = Path(temp) / "built.exe"
            exe.write_bytes(b"MZ fake exe")
            out_zip = Path(temp) / "out.zip"
            out_zip.write_bytes(b"old")
            build_release.make_windows_zip(exe, out_zip)
            with zipfile.ZipFile(out_zip) as archive:
                self.assertEqual(archive.namelist(), ["kacha.exe"])
                self.assertEqual(archive.read("kacha.exe"), b"MZ fake exe")

    def test_windows_zip_requires_product(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(SystemExit):
                build_release.make_windows_zip(Path(temp) / "missing.exe", Path(temp) / "out.zip")

    def test_checksums_keep_other_platform_zip_and_drop_stale_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            release_dir = make_release_dir(Path(temp), "0.2.0", "macos-arm64")
            mac = "kacha-0.2.0-macos-arm64.zip"
            win = "kacha-0.2.0-win-x64.zip"
            # 旧 SHA256SUMS 里还有一个已不存在的条目，应被丢弃。
            with (release_dir / "SHA256SUMS").open("a", encoding="utf-8") as stream:
                stream.write(f"{'c' * 64}  kacha-0.1.0-win-x64.zip\n")
            (release_dir / win).write_bytes(b"new win build")
            checksums = build_release.update_checksums(release_dir, "0.2.0")
            expected = {
                mac: hashlib.sha256(b"fake zip macos-arm64").hexdigest(),
                win: hashlib.sha256(b"new win build").hexdigest(),
            }
            self.assertEqual(checksums, expected)
            self.assertEqual(read_checksums(release_dir / "SHA256SUMS"), expected)

    def test_checksums_rewritten_after_rebuild(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            release_dir = make_release_dir(Path(temp), "0.2.0", "win-x64")
            win = release_dir / "kacha-0.2.0-win-x64.zip"
            win.write_bytes(b"rebuilt")
            build_release.update_checksums(release_dir, "0.2.0")
            self.assertEqual(
                read_checksums(release_dir / "SHA256SUMS"),
                {win.name: hashlib.sha256(b"rebuilt").hexdigest()},
            )


if __name__ == "__main__":
    unittest.main()
