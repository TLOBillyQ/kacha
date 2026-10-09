"""在目标机器上构建官方 updater 可使用的双端发布物（ADR 0007、0017）。

Tauri 不能交叉编译到另一平台，Windows 与 macOS 包必须各在对应机器上构建：

- Windows x64：`npx tauri build --bundles nsis --target x86_64-pc-windows-msvc`，产物为
  按当前用户安装的 NSIS 安装器及 `.sig`，复制并统一命名。
- macOS Apple Silicon：`npx tauri build --bundles app --target aarch64-apple-darwin`，
  产物为 `Kacha.app`；ad-hoc 签名（codesign --sign -）并严格校验后，
  用 ditto 压缩（保留签名与扩展属性，zipfile 会破坏 .app）。

输出到仓库根目录 release/：

    kacha-<版本>-win-x64-setup.exe(.sig)
    kacha-<版本>-macos-arm64.zip / kacha-<版本>-macos-arm64.app.tar.gz(.sig)
    SHA256SUMS

版本号唯一来源是 client/src-tauri/Cargo.toml（见 release_meta.py）。
release/ 中存在其他版本的压缩包时拒绝构建，避免旧产物混进发布。
SHA256SUMS 与已有内容合并：另一平台的压缩包若也在本目录，则保留其条目。

示例：

    python3 packaging/build_release.py
    python3 packaging/build_release.py --skip-npm-ci
"""

from __future__ import annotations

import argparse
import platform as platform_module
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from release_meta import (  # noqa: E402
    CHECKSUMS_NAME,
    MACOS_ARM64,
    PLATFORMS,
    WIN_X64,
    ReleaseMetaError,
    foreign_zips,
    foreign_artifacts,
    read_checksums,
    sha256_of,
    tauri_version,
    updater_name,
    write_checksums,
    zip_name,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CLIENT_DIR = REPO_ROOT / "client"
PRODUCT_NAME = "Kacha"
MAIN_BINARY = "kacha"
# 显式指定 MSVC 目标：Windows 用 MSVC 工具链正式构建，避免误用 GNU 工具链。
WINDOWS_TARGET = "x86_64-pc-windows-msvc"
MACOS_TARGET = "aarch64-apple-darwin"


# ---------------------------------------------------------------------------
# 纯逻辑（可测试）
# ---------------------------------------------------------------------------


def detect_platform(system: str, machine: str) -> str:
    """根据 platform.system()/platform.machine() 判断发布平台；不支持的机器直接拒绝。"""
    system_lower = system.lower()
    machine_lower = machine.lower()
    if system_lower == "windows" and machine_lower in {"amd64", "x86_64"}:
        return WIN_X64
    if system_lower == "darwin" and machine_lower in {"arm64", "aarch64"}:
        return MACOS_ARM64
    raise SystemExit(
        f"不支持在 {system}/{machine} 上构建发布包：只支持 Windows x64（win-x64）"
        "与 Apple Silicon macOS（macos-arm64），且必须在目标机器上构建。"
    )


def tauri_build_args(platform: str) -> list[str]:
    """`npx` 之后的参数列表。"""
    if platform == WIN_X64:
        return ["tauri", "build", "--bundles", "nsis", "--target", WINDOWS_TARGET]
    if platform == MACOS_ARM64:
        return ["tauri", "build", "--bundles", "app", "--target", MACOS_TARGET]
    raise ValueError(f"未知平台：{platform}")


def product_path(repo_root: Path, platform: str, version: str | None = None) -> Path:
    """tauri build 的产物路径。"""
    target_dir = repo_root / "client" / "src-tauri" / "target"
    if platform == WIN_X64:
        version = version or tauri_version(repo_root)
        return target_dir / WINDOWS_TARGET / "release" / "bundle" / "nsis" / f"{PRODUCT_NAME}_{version}_x64-setup.exe"
    if platform == MACOS_ARM64:
        return target_dir / MACOS_TARGET / "release" / "bundle" / "macos" / f"{PRODUCT_NAME}.app"
    raise ValueError(f"未知平台：{platform}")


def ensure_no_foreign_zips(release_dir: Path, version: str) -> None:
    """release/ 里有其他版本（或命名不合规）的压缩包即拒绝。"""
    stale = foreign_artifacts(release_dir, version)
    if stale:
        raise SystemExit(
            f"release/ 存在与版本 {version} 不一致的压缩包：{', '.join(stale)}。"
            "版本号唯一来源是 client/src-tauri/Cargo.toml；请清理旧产物或先 bump 版本。"
        )


def make_windows_zip(exe_path: Path, out_zip: Path) -> None:
    """把单个 exe 压成 zip，包内文件名固定为 kacha.exe（无顶层目录）。"""
    if not exe_path.is_file():
        raise SystemExit(f"构建产物缺失：{exe_path}")
    if out_zip.exists():
        out_zip.unlink()
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.write(exe_path, f"{MAIN_BINARY}.exe")


def update_checksums(release_dir: Path, version: str) -> dict[str, str]:
    """重写 SHA256SUMS：只含当前版本且确实存在于 release/ 的压缩包。

    本机刚构建的包自然被重新计算；另一平台的包（例如从另一台机器拷来）
    若在目录里也一并计算，从而保留其条目；已不存在的文件条目被丢弃，
    避免发布前核对时报缺失。
    """
    checksums_path = release_dir / CHECKSUMS_NAME
    previous = read_checksums(checksums_path)
    checksums: dict[str, str] = {}
    for platform in PLATFORMS:
        names = [updater_name(version, platform), updater_name(version, platform) + ".sig"]
        if platform == MACOS_ARM64:
            names.insert(0, zip_name(version, platform))
        for name in names:
            path = release_dir / name
            if not path.is_file():
                continue
            digest = sha256_of(path)
            if name in previous and previous[name] != digest:
                print(f"[info] {name} 哈希已变化，{CHECKSUMS_NAME} 条目已更新。")
            checksums[name] = digest
    write_checksums(checksums_path, checksums)
    return checksums


# ---------------------------------------------------------------------------
# 子进程薄封装
# ---------------------------------------------------------------------------


def _run(command: list[str], *, cwd: Path) -> None:
    print("+", " ".join(command))
    subprocess.run(command, check=True, cwd=cwd)


def _which(tool: str) -> str:
    """Windows 上 npm/npx 是 .cmd，需要解析成完整路径才能不经 shell 调用。"""
    found = shutil.which(tool)
    if not found:
        raise SystemExit(f"找不到命令：{tool}，请先安装并加入 PATH。")
    return found


def _adhoc_sign(app_path: Path) -> None:
    """ad-hoc 签名：无开发者身份，仅固定代码哈希；不做公证（ADR 0007）。"""
    _run(["codesign", "--force", "--deep", "--sign", "-", str(app_path)], cwd=REPO_ROOT)
    _run(["codesign", "--verify", "--deep", "--strict", str(app_path)], cwd=REPO_ROOT)
    print(f"[ok] ad-hoc 签名完成：{app_path.name}")


def _make_macos_zip(app_path: Path, out_zip: Path) -> None:
    if not app_path.is_dir():
        raise SystemExit(f"构建产物缺失：{app_path}")
    if out_zip.exists():
        out_zip.unlink()
    _run(["ditto", "-c", "-k", "--keepParent", str(app_path), str(out_zip)], cwd=REPO_ROOT)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="在目标机器上构建 v2 客户端发布压缩包")
    parser.add_argument(
        "--platform",
        choices=PLATFORMS,
        default=None,
        help="发布平台；默认按本机自动识别，且必须与本机一致",
    )
    parser.add_argument("--skip-npm-ci", action="store_true", help="跳过 client/ 下的 npm ci")
    parser.add_argument(
        "--release-dir",
        default=str(REPO_ROOT / "release"),
        help="输出目录（默认仓库根目录 release/）",
    )
    args = parser.parse_args(argv)

    host_platform = detect_platform(platform_module.system(), platform_module.machine())
    target = args.platform or host_platform
    if target != host_platform:
        raise SystemExit(f"不能在 {host_platform} 机器上构建 {target} 包：Tauri 不支持交叉构建发布包。")

    try:
        version = tauri_version(REPO_ROOT)
    except ReleaseMetaError as error:
        raise SystemExit(str(error)) from error

    release_dir = Path(args.release_dir)
    release_dir.mkdir(parents=True, exist_ok=True)
    ensure_no_foreign_zips(release_dir, version)
    print(f"[info] 版本 {version}，平台 {target}")

    if not args.skip_npm_ci:
        _run([_which("npm"), "ci"], cwd=CLIENT_DIR)
    _run([_which("npx"), *tauri_build_args(target)], cwd=CLIENT_DIR)

    product = product_path(REPO_ROOT, target, version)
    if target == WIN_X64:
        out_package = release_dir / updater_name(version, target)
        if not product.is_file():
            raise SystemExit(f"构建产物缺失：{product}")
        shutil.copy2(product, out_package)
        product_sig = Path(str(product) + ".sig")
        if not product_sig.is_file():
            raise SystemExit(f"缺少 updater 签名：{product_sig}")
        shutil.copy2(product_sig, Path(str(out_package) + ".sig"))
    else:
        _adhoc_sign(product)
        out_zip = release_dir / zip_name(version, target)
        _make_macos_zip(product, out_zip)
        out_package = release_dir / updater_name(version, target)
        source_package = product.parent.parent.parent / "updater" / out_package.name
        if not source_package.is_file():
            raise SystemExit(f"构建产物缺失：{source_package}")
        shutil.copy2(source_package, out_package)
        source_sig = Path(str(source_package) + ".sig")
        if not source_sig.is_file():
            raise SystemExit(f"缺少 updater 签名：{source_sig}")
        shutil.copy2(source_sig, Path(str(out_package) + ".sig"))
    print(f"[ok] 更新包：{out_package}")

    checksums = update_checksums(release_dir, version)
    print(f"[ok] {CHECKSUMS_NAME}：{', '.join(sorted(checksums))}")
    print("下一步：撰写 docs/release/release-notes-<版本>.md 后运行 packaging/publish_release.py。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
