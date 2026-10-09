"""发布元数据与校验值工具（ADR 0007）。

构建与发布脚本共用，纯标准库：

- 版本号唯一来源是 client/src-tauri/Cargo.toml 的 [package] version；
  tauri.conf.json 若也写了 version，必须与之相同，否则直接报错。
- 发布产物命名：kacha-<版本>-win-x64.zip、
  kacha-<版本>-macos-arm64.zip、SHA256SUMS。
- SHA256SUMS 解析、写出、合并与核对。
"""

from __future__ import annotations

import hashlib
import base64
import binascii
import json
import re
import tomllib
from pathlib import Path

ARCHIVE_BASE = "kacha"
WIN_X64 = "win-x64"
MACOS_ARM64 = "macos-arm64"
PLATFORMS = (WIN_X64, MACOS_ARM64)
CHECKSUMS_NAME = "SHA256SUMS"

TAURI_DIR = Path("client") / "src-tauri"
DEFAULT_BASE_URL = "http://lzxsvn:3000"
OWNER_REPO = "qinyuanj/kacha"


class ReleaseMetaError(RuntimeError):
    """发布元数据不一致或缺失。"""


def cargo_version(repo_root: Path) -> str:
    """读取 client/src-tauri/Cargo.toml 的 [package] version。"""
    cargo_path = repo_root / TAURI_DIR / "Cargo.toml"
    try:
        with cargo_path.open("rb") as stream:
            data = tomllib.load(stream)
    except FileNotFoundError as error:
        raise ReleaseMetaError(f"找不到 {cargo_path}") from error
    version = data.get("package", {}).get("version")
    if not isinstance(version, str) or not version.strip():
        raise ReleaseMetaError(f"{cargo_path} 缺少 [package] version")
    return version.strip()


def tauri_version(repo_root: Path) -> str:
    """发布版本号：以 Cargo.toml 为准，tauri.conf.json 的 version（若有）必须一致。"""
    version = cargo_version(repo_root)
    conf_path = repo_root / TAURI_DIR / "tauri.conf.json"
    if conf_path.is_file():
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
        conf_version = conf.get("version")
        if conf_version is not None and conf_version != version:
            raise ReleaseMetaError(
                f"版本号不一致：Cargo.toml 为 {version}，tauri.conf.json 为 {conf_version}。"
                "版本号唯一来源是 Cargo.toml，请删除 tauri.conf.json 的 version 或改为一致。"
            )
    return version


def zip_name(version: str, platform: str) -> str:
    """平台压缩包文件名。"""
    if platform not in PLATFORMS:
        raise ValueError(f"未知平台：{platform}")
    return f"{ARCHIVE_BASE}-{version}-{platform}.zip"


def updater_name(version: str, platform: str) -> str:
    if platform == WIN_X64:
        return f"kacha-{version}-win-x64-setup.exe"
    if platform == MACOS_ARM64:
        return f"kacha-{version}-macos-arm64.app.tar.gz"
    raise ValueError(f"未知平台：{platform}")


def descriptor_name(platform: str) -> str:
    platform_key(platform)
    return f"updater-{platform}.json"


def platform_key(platform: str) -> str:
    return {WIN_X64: "windows-x86_64", MACOS_ARM64: "darwin-aarch64"}[platform]


def platform_artifacts(version: str, platform: str) -> list[str]:
    package = updater_name(version, platform)
    names = [package, package + ".sig", descriptor_name(platform)]
    if platform == MACOS_ARM64:
        names.insert(0, zip_name(version, platform))
    return names


def expected_artifact_names(version: str) -> set[str]:
    return {name for platform in PLATFORMS for name in platform_artifacts(version, platform)}


def foreign_artifacts(release_dir: Path, version: str) -> list[str]:
    expected = expected_artifact_names(version)
    if not release_dir.is_dir():
        return []
    return sorted(
        path.name for path in release_dir.iterdir()
        if path.is_file() and path.name != CHECKSUMS_NAME
        and path.name not in expected
        and (path.name.startswith(("kacha-", "updater-"))
             or path.name.endswith((".zip", ".exe", ".tar.gz", ".sig")))
    )


def read_signature(path: Path) -> str:
    """Tauri .sig files contain base64-encoded minisign text, not raw signature bytes."""
    try:
        text = path.read_text(encoding="utf-8").strip()
        lines = base64.b64decode(text, validate=True).decode("utf-8").splitlines()
        if len(lines) != 4 or not lines[0].startswith("untrusted comment:"):
            raise ValueError("minisign format")
        if len(base64.b64decode(lines[1], validate=True)) != 74:
            raise ValueError("minisign signature")
        if not lines[2].startswith("trusted comment:"):
            raise ValueError("trusted comment")
        if len(base64.b64decode(lines[3], validate=True)) != 64:
            raise ValueError("global signature")
        return text
    except (OSError, UnicodeError, ValueError, binascii.Error) as error:
        raise ReleaseMetaError(f"签名缺失或格式无效：{path.name}") from error


def updater_descriptor(version: str, platform: str, notes: str, pub_date: str,
                       url: str, signature: str) -> dict:
    return {"version": version, "notes": notes, "pub_date": pub_date,
            "platforms": {platform_key(platform): {"url": url, "signature": signature}}}


def expected_zip_names(version: str) -> set[str]:
    return {zip_name(version, platform) for platform in PLATFORMS}


def foreign_zips(release_dir: Path, version: str) -> list[str]:
    """release/ 里不属于当前版本（或命名不合规）的压缩包文件名。"""
    if not release_dir.is_dir():
        return []
    expected = expected_zip_names(version)
    return sorted(path.name for path in release_dir.glob("*.zip") if path.name not in expected)


def sha256_of(path: Path) -> str:
    """计算单个文件的 SHA-256。"""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_checksums_text(text: str) -> dict[str, str]:
    """解析 SHA256SUMS 文本为 {文件名: 哈希}；忽略空行、注释与格式不合法的行。"""
    checksums: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            continue
        digest, name = parts
        if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            continue
        # 兼容 `sha256sum -b` 的 `*文件名` 写法。
        name = name.removeprefix("*")
        checksums[Path(name).as_posix()] = digest.lower()
    return checksums


def read_checksums(checksums_path: Path) -> dict[str, str]:
    """解析 SHA256SUMS 文件；文件不存在时返回空映射。"""
    if not checksums_path.is_file():
        return {}
    return parse_checksums_text(checksums_path.read_text(encoding="utf-8"))


def format_checksums(checksums: dict[str, str]) -> str:
    """按文件名排序输出，格式与 `shasum -a 256 -c` 兼容（哈希 + 两个空格 + 文件名）。"""
    return "".join(f"{digest}  {name}\n" for name, digest in sorted(checksums.items()))


def write_checksums(checksums_path: Path, checksums: dict[str, str]) -> None:
    # newline="\n"：Windows 上也写 LF，保证 macOS `shasum -c` 可直接使用。
    with checksums_path.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(format_checksums(checksums))


def merge_checksums_text(local_text: str, remote_text: str | None) -> str:
    """合并两端校验值：远端已有条目打底，本机条目按文件名覆盖。"""
    merged = parse_checksums_text(remote_text or "")
    merged.update(parse_checksums_text(local_text))
    return format_checksums(merged)


def verify_checksums(root: Path, checksums_path: Path) -> tuple[bool, list[str], list[str]]:
    """核对 root 下各文件的 SHA-256；返回 (是否全部一致, 缺失列表, 不一致列表)。"""
    expected = read_checksums(checksums_path)
    missing: list[str] = []
    mismatch: list[str] = []
    for name, expected_digest in expected.items():
        target = root / name
        if not target.is_file():
            missing.append(name)
            continue
        if sha256_of(target) != expected_digest:
            mismatch.append(name)
    verified = bool(expected) and not missing and not mismatch
    return verified, missing, mismatch
