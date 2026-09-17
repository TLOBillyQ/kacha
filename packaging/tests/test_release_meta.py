"""release_meta：版本号唯一来源与 SHA256SUMS 工具。"""

from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from _support import REPO_ROOT, make_repo

import release_meta
from release_meta import (
    ReleaseMetaError,
    foreign_zips,
    format_checksums,
    merge_checksums_text,
    parse_checksums_text,
    read_checksums,
    tauri_version,
    verify_checksums,
    write_checksums,
    zip_name,
)

HASH_A = "a" * 64
HASH_B = "b" * 64


class TauriVersionTest(unittest.TestCase):
    def test_reads_cargo_version_when_conf_has_no_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = make_repo(Path(temp), version="2.0.1")
            self.assertEqual(tauri_version(root), "2.0.1")

    def test_accepts_matching_conf_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = make_repo(Path(temp), version="2.0.1", conf_version="2.0.1")
            self.assertEqual(tauri_version(root), "2.0.1")

    def test_rejects_mismatched_conf_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = make_repo(Path(temp), version="2.0.1", conf_version="2.0.0")
            with self.assertRaises(ReleaseMetaError) as ctx:
                tauri_version(root)
            self.assertIn("2.0.0", str(ctx.exception))
            self.assertIn("2.0.1", str(ctx.exception))

    def test_missing_cargo_is_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ReleaseMetaError):
                tauri_version(Path(temp))

    def test_real_repo_version_is_consistent(self) -> None:
        version = tauri_version(REPO_ROOT)
        self.assertRegex(version, r"^\d+\.\d+\.\d+")


class NamingTest(unittest.TestCase):
    def test_zip_names(self) -> None:
        self.assertEqual(zip_name("0.2.0", "win-x64"), "ugc-image-tool-0.2.0-win-x64.zip")
        self.assertEqual(zip_name("0.2.0", "macos-arm64"), "ugc-image-tool-0.2.0-macos-arm64.zip")
        self.assertEqual(release_meta.CHECKSUMS_NAME, "SHA256SUMS")
        with self.assertRaises(ValueError):
            zip_name("0.2.0", "linux-x64")

    def test_foreign_zips_lists_other_versions_and_bad_names(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            release_dir = Path(temp)
            for name in (
                "ugc-image-tool-0.2.0-win-x64.zip",
                "ugc-image-tool-0.1.0-win-x64.zip",
                "random.zip",
            ):
                (release_dir / name).write_bytes(b"x")
            self.assertEqual(
                foreign_zips(release_dir, "0.2.0"),
                ["random.zip", "ugc-image-tool-0.1.0-win-x64.zip"],
            )
            self.assertEqual(foreign_zips(release_dir / "missing", "0.2.0"), [])


class ChecksumsTest(unittest.TestCase):
    def test_parse_ignores_noise_and_normalizes(self) -> None:
        text = f"# 注释\n\n{HASH_A.upper()}  a.zip\nnot-a-hash  b.zip\n{HASH_B} *c.zip\nbroken\n"
        self.assertEqual(parse_checksums_text(text), {"a.zip": HASH_A, "c.zip": HASH_B})

    def test_format_is_sorted_and_shasum_compatible(self) -> None:
        self.assertEqual(
            format_checksums({"b.zip": HASH_B, "a.zip": HASH_A}),
            f"{HASH_A}  a.zip\n{HASH_B}  b.zip\n",
        )

    def test_write_uses_lf_and_roundtrips(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "SHA256SUMS"
            write_checksums(path, {"a.zip": HASH_A})
            self.assertNotIn(b"\r\n", path.read_bytes())
            self.assertEqual(read_checksums(path), {"a.zip": HASH_A})
            self.assertEqual(read_checksums(Path(temp) / "none"), {})

    def test_merge_prefers_local_entries(self) -> None:
        remote = f"{HASH_A}  win.zip\n{HASH_A}  mac.zip\n"
        local = f"{HASH_B}  mac.zip\n"
        self.assertEqual(
            parse_checksums_text(merge_checksums_text(local, remote)),
            {"win.zip": HASH_A, "mac.zip": HASH_B},
        )
        self.assertEqual(merge_checksums_text(local, None), f"{HASH_B}  mac.zip\n")

    def test_verify_reports_missing_and_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "ok.zip").write_bytes(b"ok")
            (root / "bad.zip").write_bytes(b"bad")
            write_checksums(
                root / "SHA256SUMS",
                {
                    "ok.zip": hashlib.sha256(b"ok").hexdigest(),
                    "bad.zip": hashlib.sha256(b"other").hexdigest(),
                    "gone.zip": HASH_A,
                },
            )
            verified, missing, mismatch = verify_checksums(root, root / "SHA256SUMS")
            self.assertFalse(verified)
            self.assertEqual(missing, ["gone.zip"])
            self.assertEqual(mismatch, ["bad.zip"])

    def test_verify_empty_is_not_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "SHA256SUMS").write_text("", encoding="utf-8")
            self.assertEqual(verify_checksums(root, root / "SHA256SUMS"), (False, [], []))


if __name__ == "__main__":
    unittest.main()
