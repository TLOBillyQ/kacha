"""build_release：完整 main 的假 subprocess 构建收集及 release/ 目录逻辑（不跑真实构建）。"""

from __future__ import annotations

import hashlib
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from _support import make_release_dir, make_repo

import build_release
from release_meta import read_checksums


class BuildMainTest(unittest.TestCase):
    def test_windows_collects_official_nsis_installer_and_signature(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = make_repo(Path(temp))
            client = repo / "client"
            bundle = client / "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"
            installer = bundle / "Kacha_1.2.3_x64-setup.exe"
            release = repo / "release"
            expected_files = {
                "kacha-1.2.3-win-x64-setup.exe": b"fake NSIS installer",
                "kacha-1.2.3-win-x64-setup.exe.sig": b"fake minisign signature for NSIS\n",
            }

            def fake_run(command, *, check, cwd):
                self.assertTrue(check)
                self.assertEqual(cwd, client)
                if command == ["npm.cmd", "ci"]:
                    pass
                elif command == ["npx.cmd", "tauri", "build", "--bundles", "nsis",
                                 "--target", "x86_64-pc-windows-msvc"]:
                    bundle.mkdir(parents=True)
                    installer.write_bytes(expected_files["kacha-1.2.3-win-x64-setup.exe"])
                    Path(str(installer) + ".sig").write_bytes(
                        expected_files["kacha-1.2.3-win-x64-setup.exe.sig"])
                else:
                    self.fail(f"Unexpected subprocess: {command}")
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.multiple(build_release, REPO_ROOT=repo, CLIENT_DIR=client), \
                    mock.patch.object(build_release.platform_module, "system", return_value="Windows"), \
                    mock.patch.object(build_release.platform_module, "machine", return_value="AMD64"), \
                    mock.patch.object(build_release.shutil, "which", side_effect=lambda tool: tool + ".cmd"), \
                    mock.patch.object(build_release.subprocess, "run", side_effect=fake_run):
                self.assertEqual(build_release.main([]), 0)

            self.assertEqual({path.name for path in release.iterdir()},
                             {*expected_files, "SHA256SUMS"})
            checksums = read_checksums(release / "SHA256SUMS")
            self.assertEqual(set(checksums), set(expected_files))
            for name, data in expected_files.items():
                self.assertEqual((release / name).read_bytes(), data)
                self.assertEqual(checksums[name], hashlib.sha256(data).hexdigest())

    def test_macos_collects_official_updater_and_zips_the_same_signed_app(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = make_repo(Path(temp))
            client = repo / "client"
            bundle = client / "src-tauri/target/aarch64-apple-darwin/release/bundle/macos"
            app = bundle / "Kacha.app"
            archive = bundle / "Kacha.app.tar.gz"
            release = repo / "release"
            expected_app = {
                "Kacha.app/Contents/MacOS/kacha": b"fake arm64 executable",
                "Kacha.app/Contents/_CodeSignature/CodeResources": b"tauri ad-hoc signature",
            }
            signature = b"fake minisign signature for official archive\n"

            def fake_run(command, *, check, cwd):
                self.assertTrue(check)
                if command == ["npm", "ci"]:
                    self.assertEqual(cwd, client)
                elif command == ["npx", "tauri", "build", "--bundles", "app",
                                 "--target", "aarch64-apple-darwin"]:
                    self.assertEqual(cwd, client)
                    for name, data in expected_app.items():
                        path = bundle / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(data)
                    with tarfile.open(archive, "w:gz") as stream:
                        stream.add(app, arcname="Kacha.app")
                    Path(str(archive) + ".sig").write_bytes(signature)
                elif command[0] == "codesign":
                    self.assertEqual(cwd, repo)
                    if "--sign" in command:
                        # Re-signing after archiving must be visible in the first-install ZIP.
                        (app / "Contents/_CodeSignature/CodeResources").write_bytes(b"resigned app")
                    else:
                        self.assertEqual(command, ["codesign", "--verify", "--deep",
                                                   "--strict", str(app)])
                elif command == ["ditto", "-c", "-k", "--keepParent", str(app),
                                 str(release / "kacha-1.2.3-macos-arm64.zip")]:
                    self.assertEqual(cwd, repo)
                    with zipfile.ZipFile(command[-1], "w") as stream:
                        for path in app.rglob("*"):
                            if path.is_file():
                                stream.write(path, path.relative_to(bundle).as_posix())
                else:
                    self.fail(f"Unexpected subprocess: {command}")
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.multiple(build_release, REPO_ROOT=repo, CLIENT_DIR=client), \
                    mock.patch.object(build_release.platform_module, "system", return_value="Darwin"), \
                    mock.patch.object(build_release.platform_module, "machine", return_value="arm64"), \
                    mock.patch.object(build_release.shutil, "which", side_effect=lambda tool: tool), \
                    mock.patch.object(build_release.subprocess, "run", side_effect=fake_run):
                self.assertEqual(build_release.main([]), 0)

            updater = release / "kacha-1.2.3-macos-arm64.app.tar.gz"
            self.assertEqual(updater.read_bytes(), archive.read_bytes())
            self.assertEqual(Path(str(updater) + ".sig").read_bytes(), signature)
            with tarfile.open(updater, "r:gz") as stream:
                archived_app = {member.name: stream.extractfile(member).read()
                                for member in stream.getmembers() if member.isfile()}
            with zipfile.ZipFile(release / "kacha-1.2.3-macos-arm64.zip") as stream:
                zipped_app = {name: stream.read(name) for name in stream.namelist()}
            self.assertEqual(archived_app, expected_app)
            self.assertEqual(zipped_app, archived_app)
            checksums = read_checksums(release / "SHA256SUMS")
            self.assertEqual(set(checksums), {
                "kacha-1.2.3-macos-arm64.zip",
                "kacha-1.2.3-macos-arm64.app.tar.gz",
                "kacha-1.2.3-macos-arm64.app.tar.gz.sig",
            })
            for name, digest in checksums.items():
                self.assertEqual(digest, hashlib.sha256((release / name).read_bytes()).hexdigest())


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
    def test_windows_builds_signed_nsis_bundle(self) -> None:
        self.assertEqual(build_release.tauri_build_args("win-x64"), ["tauri", "build", "--bundles", "nsis", "--target", "x86_64-pc-windows-msvc"])
        self.assertEqual(
            build_release.product_path(Path("/repo"), "win-x64", "1.2.3"),
            Path("/repo/client/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Kacha_1.2.3_x64-setup.exe"),
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
            (release_dir / "kacha-0.1.0-win-x64.zip").write_bytes(b"stale")
            with self.assertRaises(SystemExit) as ctx:
                build_release.ensure_no_foreign_zips(release_dir, "0.1.0")
            self.assertIn("kacha-0.1.0-win-x64.zip", str(ctx.exception))

    def test_checksums_keep_other_platform_zip_and_drop_stale_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            release_dir = make_release_dir(Path(temp), "0.2.0", "macos-arm64")
            mac = "kacha-0.2.0-macos-arm64.zip"
            updater = "kacha-0.2.0-macos-arm64.app.tar.gz"
            win = "kacha-0.2.0-win-x64.zip"
            # 旧 SHA256SUMS 里还有一个已不存在的条目，应被丢弃。
            with (release_dir / "SHA256SUMS").open("a", encoding="utf-8") as stream:
                stream.write(f"{'c' * 64}  kacha-0.1.0-win-x64.zip\n")
            (release_dir / win).write_bytes(b"new win build")
            checksums = build_release.update_checksums(release_dir, "0.2.0")
            expected = read_checksums(release_dir / "SHA256SUMS")
            self.assertIn(mac, expected)
            self.assertIn(updater, expected)
            self.assertIn(updater + ".sig", expected)
            self.assertNotIn(win, expected)
            self.assertNotIn("kacha-0.1.0-win-x64.zip", expected)
            self.assertEqual(checksums, expected)
            self.assertEqual(read_checksums(release_dir / "SHA256SUMS"), expected)

    def test_checksums_rewritten_after_rebuild(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            release_dir = make_release_dir(Path(temp), "0.2.0", "win-x64")
            win = release_dir / "kacha-0.2.0-win-x64-setup.exe"
            win.write_bytes(b"rebuilt")
            build_release.update_checksums(release_dir, "0.2.0")
            checksums = read_checksums(release_dir / "SHA256SUMS")
            self.assertEqual(checksums[win.name], hashlib.sha256(b"rebuilt").hexdigest())
            self.assertIn(win.name + ".sig", checksums)


if __name__ == "__main__":
    unittest.main()
