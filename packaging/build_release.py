"""构建并打包 UGC AI 生图工具 Windows x64 便携发布物（issue #53 布局）。

流程：
1. 以目录模式（onedir）运行 PyInstaller，产出无控制台的 GUI 便携目录。
2. 把便携目录按版本号重命名并压缩为 <名称>-<版本>-win-x64.zip。
3. 计算并写出 SHA256SUMS 校验值（仅压缩包；供发布时随 Gitea Release 分发）。
4. 写出 build-info.json（版本、提交、Python/PyInstaller 版本、签名状态与时间）。
5. 运行 packaging/verify_release.py 做无密钥发布检查；发现泄漏即失败。

产物布局（ADR 0007）：release/ 顶层只留 zip、SHA256SUMS、build-info.json；
便携目录与 PyInstaller 中间产物统一在 release/work/。

示例：
    python packaging/build_release.py
    python packaging/build_release.py --cert team-cert.pfx   # 可选：购证后签名

默认不签名发布（决策见 docs/adr/0007-gitea-release-as-sole-distribution-channel.md）：
Windows SmartScreen 首次会提示
“未知发布者”，发布说明已含“仍要运行”绕过步骤；仅当提供 --cert 时才走签名
路径（保留 sign.ps1），签名后状态必须为 Valid 否则构建失败。版本号唯一来源
是 pyproject.toml 的 version。发布物内容不含 API 密钥，密钥只存在于当前
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

from release_meta import pyproject_version
from security_scan import checksum_line

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


def _finalize_portable_dir(work_root: Path, version: str) -> Path:
    """把 PyInstaller 输出目录重命名为带版本号的便携目录（留在 work_root 内）。"""
    built = work_root / "ugc-image-tool"
    portable = work_root / _portable_name(version)
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


def _deploy_dev_copy(portable_dir: Path) -> Path:
    """把最新便携目录整体覆盖到桌面 dev/ 下的固定目录，供开发直接双击运行。

    固定名称不带版本号，每次构建后 dev/ 下永远是最新一份。目标里的 exe
    正在运行时整目录无法删除，必须先关闭应用再重新构建。
    """
    target = Path.home() / "Desktop" / "dev" / ARCHIVE_BASE
    if target.exists():
        try:
            shutil.rmtree(target)
        except OSError as error:
            raise SystemExit(
                f"无法覆盖开发副本 {target}：{error}。请先关闭正在运行的 ugc-image-tool。"
            ) from error
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(portable_dir, target)
    print(f"[ok] 开发副本已覆盖：{target}")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="构建 UGC AI 生图工具 Windows x64 便携发布物"
    )
    parser.add_argument(
        "--release-dir",
        default=str((REPO_ROOT / "release").resolve()),
        help="发布产物目录（会被 .gitignore 忽略）",
    )
    parser.add_argument("--skip-build", action="store_true", help="跳过 PyInstaller 构建")
    parser.add_argument("--skip-zip", action="store_true", help="跳过压缩")
    parser.add_argument("--skip-verify", action="store_true", help="跳过发布检查")
    parser.add_argument(
        "--cert",
        default=os.environ.get("UGC_IMAGE_TOOL_CERT"),
        help="可选签名路径：签名证书 .pfx 路径；不提供则默认不签名发布（ADR 0007）",
    )
    parser.add_argument(
        "--cert-password",
        default=os.environ.get("UGC_IMAGE_TOOL_CERT_PASSWORD", ""),
        help="证书口令；也可用环境变量 UGC_IMAGE_TOOL_CERT_PASSWORD",
    )
    parser.add_argument("--timestamp", default=DEFAULT_TIMESTAMP_URL, help="RFC3161 时间戳服务器")
    parser.add_argument("--signtool", default=None, help="signtool 路径；留空自动查找")
    parser.add_argument(
        "--skip-dev-deploy",
        action="store_true",
        help="跳过把最新便携目录覆盖同步到 Windows 桌面 dev/ 下",
    )
    args = parser.parse_args(argv)

    version = pyproject_version(REPO_ROOT)
    release_dir = Path(args.release_dir)
    work_root = release_dir / "work"
    pyinstaller_workpath = work_root / "pyinstaller"

    if not args.skip_build:
        work_root.mkdir(parents=True, exist_ok=True)
        _run_pyinstaller(version, pyinstaller_workpath, work_root)

    portable_dir = _finalize_portable_dir(work_root, version)
    exe_path = portable_dir / "ugc-image-tool.exe"
    signature_status = _signature_status(exe_path) if exe_path.is_file() else "Unknown"

    signed = False
    if args.cert:
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
        # 只记录压缩包的校验值：SHA256SUMS 随 Gitea Release 发布，接收方核对
        # zip 即覆盖包内全部内容；exe 位于 work/ 内，不随附件分发。
        (release_dir / "SHA256SUMS").write_text(
            checksum_line(zip_path) + "\n", encoding="utf-8"
        )
        print("[ok] 已写出 SHA256SUMS。")

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

    dev_copy: Path | None = None
    if not args.skip_dev_deploy:
        dev_copy = _deploy_dev_copy(portable_dir)

    print()
    print(f"发布目录：  {release_dir}（顶层只留 zip、SHA256SUMS、build-info.json）")
    print(f"便携目录：  {portable_dir.relative_to(release_dir).as_posix()}")
    print(f"压缩包：    {zip_path.name}")
    print(f"校验值：    SHA256SUMS（SHA-256）")
    if dev_copy is not None:
        print(f"开发副本：  {dev_copy}")
    print(f"Exe 签名：  {signature_status}（signed={signed}）")
    if not signed:
        print(
            "注意：本构建未签名（signed=False），按 ADR 0007 属默认发布路径；"
            "SmartScreen 首次会提示“未知发布者”，发布说明须包含"
            "“更多信息 → 仍要运行”绕过步骤。购证后可用 --cert 启用签名。"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
