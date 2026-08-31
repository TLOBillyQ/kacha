"""构建 UGC AI 生图工具 macOS 开发版 .app（当前仅供开发/测试，不做公证）。

流程：
1. 以目录模式（onedir）运行 PyInstaller，规格中的 BUNDLE 段产出
   ugc-image-tool.app。
2. ad-hoc 签名（codesign -s -）：仅为让 Gatekeeper 与钥匙串访问行为稳定，
   不代表开发者身份；分发构建才需要 Developer ID + 公证。
3. 用 ditto 压缩为 ugc-image-tool-<版本>-macos-<架构>.zip（保留签名与权限）。
4. 写出 SHA256SUMS 与 build-info.json。
5. 运行 packaging/verify_release.py 做无密钥发布检查；发现泄漏即失败。

示例：
    python packaging/build_macos.py
    python packaging/build_macos.py --skip-sign --skip-zip

发布物不含 API 密钥；macOS 上密钥存于当前用户钥匙串（KeychainCredentialService）。
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from security_scan import sha256_of

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGING_DIR = Path(__file__).resolve().parent
ARCHIVE_BASE = "ugc-image-tool"
APP_NAME = "ugc-image-tool.app"


def _run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    print("+", " ".join(str(part) for part in command))
    subprocess.run(command, check=True, env=env)


def _git_head() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, cwd=REPO_ROOT, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return result.stdout.strip()


def _package_version(override: str | None) -> str:
    if override:
        return override.strip()
    sys.path.insert(0, str(REPO_ROOT / "src"))
    from ugc_image_tool import __version__  # type: ignore[import-not-found, import-untyped]

    return __version__


def _archive_base_name(version: str) -> str:
    arch = platform.machine() or "unknown"
    return f"{ARCHIVE_BASE}-{version}-macos-{arch}"


def _adhoc_sign(app_path: Path) -> None:
    """ad-hoc 签名（-s -）：无开发者身份，仅固定代码目录哈希。"""
    _run(["codesign", "--force", "--deep", "--sign", "-", str(app_path)])
    _run(["codesign", "--verify", "--deep", "--strict", str(app_path)])
    print(f"[ok] ad-hoc 签名完成：{app_path.name}")


def _make_zip(app_path: Path, out_zip: Path) -> None:
    """ditto 保留签名与扩展属性；zipfile 会丢，导致 .app 无法直接运行。"""
    if out_zip.exists():
        out_zip.unlink()
    _run(["ditto", "-c", "-k", "--keepParent", str(app_path), str(out_zip)])
    print(f"[ok] 压缩包：{out_zip.name}")


def _write_sha256(release_dir: Path, zip_path: Path, app_path: Path) -> None:
    lines = [f"{sha256_of(zip_path)}  {zip_path.name}"]
    binary = app_path / "Contents" / "MacOS" / ARCHIVE_BASE
    if binary.is_file():
        lines.append(
            f"{sha256_of(binary)}  {binary.relative_to(app_path.parent).as_posix()}"
        )
    (release_dir / "SHA256SUMS").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )
    print("[ok] 已写出 SHA256SUMS。")


def _build_info(version: str, signed: bool, zip_path: Path) -> dict[str, object]:
    pyinstaller_version = "unknown"
    try:
        import PyInstaller  # type: ignore[import-not-found, import-untyped]

        pyinstaller_version = PyInstaller.__version__
    except Exception:
        pass
    return {
        "name": ARCHIVE_BASE,
        "platform": f"macos-{platform.machine() or 'unknown'}",
        "version": version,
        "commit": _git_head(),
        "built_at_utc": datetime.now(timezone.utc).isoformat(),
        "python": sys.version.split()[0],
        "pyinstaller": pyinstaller_version,
        "archive": zip_path.name,
        "signed": signed,
        "signature_status": "ad-hoc" if signed else "unsigned",
        "distribution": "开发版：ad-hoc 签名、未公证，仅供开发/测试，不对团队分发",
        "http_warning": "默认网关地址为明文 HTTP，仅限隔离内网或可信 VPN；非可信网络必须先启用 HTTPS。",
    }


def main(argv: list[str] | None = None) -> int:
    if sys.platform != "darwin":
        raise SystemExit("build_macos.py 只能在 macOS 上运行；Windows 请用 build_release.py")
    parser = argparse.ArgumentParser(
        description="构建 UGC AI 生图工具 macOS 开发版 .app"
    )
    parser.add_argument("--version", default=None, help="发布版本号；默认读取包内版本")
    parser.add_argument(
        "--release-dir",
        default=str((REPO_ROOT / "release").resolve()),
        help="发布产物目录（会被 .gitignore 忽略）",
    )
    parser.add_argument("--skip-build", action="store_true", help="跳过 PyInstaller 构建")
    parser.add_argument("--skip-sign", action="store_true", help="跳过 ad-hoc 签名")
    parser.add_argument("--skip-zip", action="store_true", help="跳过压缩")
    parser.add_argument("--skip-verify", action="store_true", help="跳过发布检查")
    args = parser.parse_args(argv)

    version = _package_version(args.version)
    release_dir = Path(args.release_dir)
    work_path = release_dir / "work-macos"

    if not args.skip_build:
        release_dir.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["UGC_IMAGE_TOOL_VERSION"] = version
        _run(
            [
                sys.executable,
                "-m", "PyInstaller",
                "--noconfirm", "--clean",
                "--distpath", str(release_dir),
                "--workpath", str(work_path),
                str(PACKAGING_DIR / "ugc-image-tool.spec"),
            ],
            env=env,
        )

    app_path = release_dir / APP_NAME
    if not app_path.is_dir():
        raise SystemExit(f"构建输出缺失：{app_path}")

    signed = False
    if not args.skip_sign:
        _adhoc_sign(app_path)
        signed = True

    zip_path = release_dir / f"{_archive_base_name(version)}.zip"
    if not args.skip_zip:
        _make_zip(app_path, zip_path)
        _write_sha256(release_dir, zip_path, app_path)

    info_path = release_dir / "build-info.json"
    info_path.write_text(
        json.dumps(_build_info(version, signed, zip_path), ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"[ok] 已写出 {info_path.name}。")

    if not args.skip_verify:
        verify_command = [sys.executable, str(PACKAGING_DIR / "verify_release.py"), str(app_path)]
        if zip_path.is_file():
            verify_command += [str(zip_path), "--checksums", str(release_dir / "SHA256SUMS")]
        _run(verify_command)

    print()
    print(f"发布目录：  {release_dir}")
    print(f"App：       {app_path}")
    if zip_path.is_file():
        print(f"压缩包：    {zip_path.name}")
    print(f"签名：      {'ad-hoc（开发版，未公证）' if signed else '未签名'}")
    print("注意：开发版未经 Apple 公证，仅供本机/开发使用；分发需 Developer ID + 公证。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
