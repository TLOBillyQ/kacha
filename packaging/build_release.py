"""构建并打包 UGC AI 生图工具 Windows x64 便携发布物（issue #13 交付）。

流程：
1. 以目录模式（onedir）运行 PyInstaller，产出无控制台的 GUI 便携目录。
2. 可选：用团队代码签名证书对主程序签名（signtool 或 PowerShell Authenticode）。
3. 把便携目录按版本号重命名并压缩为 <名称>-<版本>-win-x64.zip。
4. 计算并写出 SHA256SUMS 校验值（zip 与主程序）。
5. 写出 build-info.json（版本、提交、Python/PyInstaller 版本、签名状态与时间）。
6. 运行 packaging/verify_release.py 做无密钥发布检查；发现泄漏即失败。

示例：
    python packaging/build_release.py --skip-sign
    python packaging/build_release.py --cert team-cert.pfx

正式对外发布必须提供团队代码签名证书；未签名构建仅用于开发验证，Windows
SmartScreen 会提示“未知发布者”。发布物内容不含 API 密钥，密钥只存在于当前
Windows 用户凭据库。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from security_scan import sha256_of

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGING_DIR = Path(__file__).resolve().parent
ARCHIVE_BASE = "ugc-image-tool"
WIN_X64 = "win-x64"
DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com"


def _run(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    redact: set[str] | None = None,
) -> None:
    """执行子进程；打印命令时把 redact 中的值替换为 <REDACTED>，避免证书口令回显。"""
    secrets = redact or set()
    shown = [part if part not in secrets else "<REDACTED>" for part in command]
    print("+", " ".join(str(part) for part in shown))
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


def _portable_name(version: str) -> str:
    return f"{ARCHIVE_BASE}-{version}-{WIN_X64}"


def _run_pyinstaller(version: str, work_path: Path, dist_path: Path) -> None:
    env = dict(os.environ)
    env["UGC_IMAGE_TOOL_VERSION"] = version
    _run(
        [
            sys.executable,
            "-m", "PyInstaller",
            "--noconfirm", "--clean",
            "--distpath", str(dist_path),
            "--workpath", str(work_path),
            str(PACKAGING_DIR / "ugc-image-tool.spec"),
        ],
        env=env,
    )


def _finalize_portable_dir(release_dir: Path, version: str) -> Path:
    built = release_dir / "ugc-image-tool"
    portable = release_dir / _portable_name(version)
    if not built.is_dir():
        if portable.is_dir():
            return portable
        raise SystemExit(f"构建输出目录缺失：{built}")
    if portable.exists():
        shutil.rmtree(portable)
    built.replace(portable)
    return portable


def _find_signtool(override: str | None) -> str | None:
    if override:
        return override
    found = shutil.which("signtool")
    if found:
        return found
    kit = Path(r"C:\Program Files (x86)\Windows Kits\10\bin")
    if kit.is_dir():
        candidates = sorted(kit.glob("*/x64/signtool.exe"), reverse=True)
        if candidates:
            return str(candidates[0])
    return None


def _sign_exe(
    exe_path: Path,
    cert: str,
    password: str,
    timestamp: str,
    signtool: str | None,
) -> None:
    """对主程序签名并确认签名状态为 Valid。

    signtool 必须用 /p 传口令（无法避免出现在命令行，仅不回显到构建日志）；
    PowerShell 回退路径通过环境变量传口令，避免口令出现在进程参数里。
    """
    if signtool:
        command = [
            signtool, "sign",
            "/fd", "SHA256",
            "/tr", timestamp, "/td", "SHA256",
            "/f", cert,
        ]
        if password:
            command += ["/p", password]
        command.append(str(exe_path))
        _run(command, redact={password} if password else None)
        print(f"[ok] 已用 signtool 签名：{exe_path.name}")
        return
    ps = shutil.which("pwsh") or shutil.which("powershell")
    if not ps:
        raise SystemExit("未找到签名工具：请安装 signtool 或用 --signtool 指定其路径")
    sign_env = dict(os.environ)
    sign_env["UGC_IMAGE_TOOL_CERT_PASSWORD"] = password
    _run(
        [
            ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            str(PACKAGING_DIR / "sign.ps1"),
            "-ExePath", str(exe_path),
            "-CertificatePath", cert,
            "-Password", "",
            "-TimestampServer", timestamp,
        ],
        env=sign_env,
    )
    print(f"[ok] 已用 PowerShell Authenticode 签名：{exe_path.name}")


def _signature_status(exe_path: Path) -> str:
    ps = shutil.which("pwsh") or shutil.which("powershell")
    if not ps:
        return "Unknown"
    try:
        result = subprocess.run(
            [ps, "-NoProfile", "-Command", f"(Get-AuthenticodeSignature -FilePath '{exe_path}').Status"],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "Unknown"
    return result.stdout.strip() or "Unknown"


def _make_zip(portable: Path, out_zip: Path) -> None:
    base = portable.parent
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in sorted(item for item in portable.rglob("*") if item.is_file()):
            archive.write(file, file.relative_to(base))
    print(f"[ok] 压缩包：{out_zip.name}")


def _write_sha256(release_dir: Path, zip_path: Path, portable: Path) -> None:
    lines = [f"{sha256_of(zip_path)}  {zip_path.name}"]
    exe = portable / "ugc-image-tool.exe"
    if exe.is_file():
        lines.append(f"{sha256_of(exe)}  {exe.relative_to(portable.parent).as_posix()}")
    (release_dir / "SHA256SUMS").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )
    print("[ok] 已写出 SHA256SUMS。")


def _build_info(
    version: str,
    signed: bool,
    signature_status: str,
    zip_path: Path,
) -> dict[str, object]:
    pyinstaller_version = "unknown"
    try:
        import PyInstaller  # type: ignore[import-not-found, import-untyped]

        pyinstaller_version = PyInstaller.__version__
    except Exception:
        pass
    return {
        "name": ARCHIVE_BASE,
        "version": version,
        "commit": _git_head(),
        "built_at_utc": datetime.now(timezone.utc).isoformat(),
        "python": sys.version.split()[0],
        "pyinstaller": pyinstaller_version,
        "archive": zip_path.name,
        "signed": signed,
        "signature_status": signature_status,
        "http_warning": "默认网关地址为明文 HTTP，仅限隔离内网或可信 VPN；非可信网络必须先启用 HTTPS。",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="构建 UGC AI 生图工具 Windows x64 便携发布物"
    )
    parser.add_argument("--version", default=None, help="发布版本号；默认读取包内版本")
    parser.add_argument(
        "--release-dir",
        default=str((REPO_ROOT / "release").resolve()),
        help="发布产物目录（会被 .gitignore 忽略）",
    )
    parser.add_argument("--skip-build", action="store_true", help="跳过 PyInstaller 构建")
    parser.add_argument("--skip-sign", action="store_true", help="跳过签名")
    parser.add_argument("--skip-zip", action="store_true", help="跳过压缩")
    parser.add_argument("--skip-verify", action="store_true", help="跳过发布检查")
    parser.add_argument("--cert", default=os.environ.get("UGC_IMAGE_TOOL_CERT"), help="签名证书 .pfx 路径")
    parser.add_argument(
        "--cert-password",
        default=os.environ.get("UGC_IMAGE_TOOL_CERT_PASSWORD", ""),
        help="证书口令；也可用环境变量 UGC_IMAGE_TOOL_CERT_PASSWORD",
    )
    parser.add_argument("--timestamp", default=DEFAULT_TIMESTAMP_URL, help="RFC3161 时间戳服务器")
    parser.add_argument("--signtool", default=None, help="signtool 路径；留空自动查找")
    args = parser.parse_args(argv)

    version = _package_version(args.version)
    release_dir = Path(args.release_dir)
    work_path = release_dir / "work"

    if not args.skip_build:
        release_dir.mkdir(parents=True, exist_ok=True)
        _run_pyinstaller(version, work_path, release_dir)

    portable_dir = _finalize_portable_dir(release_dir, version)
    exe_path = portable_dir / "ugc-image-tool.exe"
    signature_status = _signature_status(exe_path) if exe_path.is_file() else "Unknown"

    signed = False
    if args.cert and not args.skip_sign:
        _sign_exe(exe_path, args.cert, args.cert_password, args.timestamp, args.signtool)
        signature_status = _signature_status(exe_path)
        if signature_status != "Valid":
            raise SystemExit(
                f"签名后验证失败：signature_status={signature_status}，期望 Valid。"
                "请检查证书是否会话或重试签名。"
            )
        signed = True

    zip_path = release_dir / f"{_portable_name(version)}.zip"
    if not args.skip_zip:
        _make_zip(portable_dir, zip_path)

    if not args.skip_zip:
        _write_sha256(release_dir, zip_path, portable_dir)

    info = _build_info(version, signed, signature_status, zip_path)
    build_info_path = release_dir / "build-info.json"
    build_info_path.write_text(
        json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"[ok] 已写出 {build_info_path.name}。")

    if not args.skip_verify:
        _run(
            [
                sys.executable,
                str(PACKAGING_DIR / "verify_release.py"),
                str(portable_dir),
                str(zip_path),
                "--checksums", str(release_dir / "SHA256SUMS"),
            ]
        )

    print()
    print(f"发布目录：  {release_dir}")
    print(f"便携目录：  {portable_dir.name}")
    print(f"压缩包：    {zip_path.name}")
    print(f"校验值：    SHA256SUMS（SHA-256）")
    print(f"Exe 签名：  {signature_status}（signed={signed}）")
    if not signed:
        print(
            "注意：本构建未签名（signed=False），仅供开发验证，SmartScreen"
            "会提示“未知发布者”。正式发布必须用团队证书构建（--cert），"
            "并确认 build-info.json 的 signature_status=Valid。"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
