"""构建 UGC AI 生图工具 macOS 版 .app（ADR 0007：ad-hoc 签名、不做公证）。

流程：
1. 以目录模式（onedir）运行 PyInstaller，规格中的 BUNDLE 段产出
   ugc-image-tool.app。
2. ad-hoc 签名（codesign -s -）：仅为让 Gatekeeper 与钥匙串访问行为稳定，
   不代表开发者身份（ADR 0007：不做公证，发布说明含右键打开绕过步骤）。
3. 用 ditto 压缩为 ugc-image-tool-<版本>-macos-<架构>.zip（保留签名与权限）。
4. 写出 SHA256SUMS（仅压缩包）与 build-info.json。
5. 运行 packaging/verify_release.py 做无密钥发布检查；发现泄漏即失败。

产物布局：.app 与 PyInstaller 中间产物在 release/work/，release/ 顶层
只留 zip、SHA256SUMS、build-info.json。

示例：
    python packaging/build_macos.py
    python packaging/build_macos.py --skip-sign --skip-zip

版本号唯一来源是 pyproject.toml 的 version。发布物不含 API 密钥；macOS 上
密钥存于当前用户钥匙串（KeychainCredentialService）。
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

from release_meta import pyproject_version
from security_scan import checksum_line

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
        "distribution": "ad-hoc 签名、未公证、仅 Apple Silicon；经 Gitea Release 分发（ADR 0007）",
        "http_warning": "默认网关地址为明文 HTTP，仅限隔离内网或可信 VPN；非可信网络必须先启用 HTTPS。",
    }


def _initial_build_info(version: str) -> dict[str, object]:
    """PyInstaller 构建前写出，供打包进应用的数据文件使用。"""
    info = _build_info(version, signed=False, zip_path=Path(""))
    info["signed"] = False
    info["signature_status"] = "Unknown"
    return info


def _finalize_build_info(info: dict[str, object], signed: bool, zip_path: Path) -> dict[str, object]:
    """构建、签名、压缩完成后更新发布物元数据。"""
    info["archive"] = zip_path.name
    info["signed"] = signed
    info["signature_status"] = "ad-hoc" if signed else "unsigned"
    return info


def _write_build_info(path: Path, info: dict[str, object]) -> None:
    path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    if sys.platform != "darwin":
        raise SystemExit("build_macos.py 只能在 macOS 上运行；Windows 请用 build_release.py")
    parser = argparse.ArgumentParser(
        description="构建 UGC AI 生图工具 macOS 版 .app（ad-hoc 签名、未公证）"
    )
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

    version = pyproject_version(REPO_ROOT)
    release_dir = Path(args.release_dir)
    work_root = release_dir / "work"
    pyinstaller_workpath = work_root / "pyinstaller"
    info_path = release_dir / "build-info.json"

    if not args.skip_build:
        work_root.mkdir(parents=True, exist_ok=True)
        _write_build_info(info_path, _initial_build_info(version))
        env = dict(os.environ)
        env["UGC_IMAGE_TOOL_VERSION"] = version
        _run(
            [
                sys.executable,
                "-m", "PyInstaller",
                "--noconfirm", "--clean",
                "--distpath", str(work_root),
                "--workpath", str(pyinstaller_workpath),
                str(PACKAGING_DIR / "ugc-image-tool.spec"),
            ],
            env=env,
        )

    app_path = work_root / APP_NAME
    if not app_path.is_dir():
        raise SystemExit(f"构建输出缺失：{app_path}")

    signed = False
    if not args.skip_sign:
        _adhoc_sign(app_path)
        signed = True

    zip_path = release_dir / f"{_archive_base_name(version)}.zip"
    if not args.skip_zip:
        _make_zip(app_path, zip_path)
        # 只记录压缩包的校验值：.app 位于 work/ 内，不随附件分发。
        (release_dir / "SHA256SUMS").write_text(
            checksum_line(zip_path) + "\n", encoding="utf-8"
        )
        print("[ok] 已写出 SHA256SUMS。")

    info = _initial_build_info(version) if not info_path.is_file() else json.loads(info_path.read_text(encoding="utf-8"))
    _write_build_info(info_path, _finalize_build_info(info, signed, zip_path))
    print(f"[ok] 已写出 {info_path.name}。")

    if not args.skip_verify:
        verify_command = [sys.executable, str(PACKAGING_DIR / "verify_release.py"), str(app_path)]
        if zip_path.is_file():
            verify_command += [str(zip_path), "--checksums", str(release_dir / "SHA256SUMS")]
        _run(verify_command)

    print()
    print(f"发布目录：  {release_dir}（顶层只留 zip、SHA256SUMS、build-info.json）")
    print(f"App：       {app_path.relative_to(release_dir).as_posix()}")
    if zip_path.is_file():
        print(f"压缩包：    {zip_path.name}")
    print(f"签名：      {'ad-hoc（未公证）' if signed else '未签名'}")
    print(
        "注意：本包 ad-hoc 签名、未经 Apple 公证、仅 Apple Silicon（ADR 0007）；"
        "首次启动被 Gatekeeper 拦截时右键图标 → 打开。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
