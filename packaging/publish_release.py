"""把 v2 客户端发布物上传到 Gitea Release（ADR 0007、0017）。

Gitea Release 是唯一分发渠道；每端发布完整 updater 集合：

    kacha-<版本>-win-x64-setup.exe(.sig) + updater-win-x64.json
    macOS 首次安装 zip + kacha-<版本>-macos-arm64.app.tar.gz(.sig) + updater-macos-arm64.json
    SHA256SUMS

两端各在对应机器用 build_release.py 构建，构建后各跑一次本脚本：创建或复用
tag `v<版本>` 的 Release，上传/替换本机产物（幂等，同名附件先删后传）。本机
SHA256SUMS 与远端已有内容合并（本机条目优先），两端都发布后校验值文件覆盖
全部发布产物。

安全闸门（任一不满足即拒绝，且不发起任何写操作）：

- token 只从环境变量 GITEA_TOKEN 读取，不接受命令行传参；
- 版本号唯一来源是 client/src-tauri/Cargo.toml；release/ 里出现与该版本
  不一致的发布产物（如旧版本残留）即拒绝；
- 上传前重核 release/SHA256SUMS：缺失文件、哈希不一致、或本地发布产物未被
  列出都算失败；
- 必须已有 docs/release/release-notes-<版本>.md（Release 正文与更新说明）。

示例：

    export GITEA_TOKEN=***   # Windows PowerShell 用 $env:GITEA_TOKEN = "***"
    python3 packaging/publish_release.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Protocol

sys.path.insert(0, str(Path(__file__).resolve().parent))

from release_meta import (  # noqa: E402
    CHECKSUMS_NAME,
    ReleaseMetaError,
    descriptor_name,
    foreign_artifacts,
    read_checksums,
    read_signature,
    tauri_version,
    updater_descriptor,
    updater_name,
    WIN_X64,
    MACOS_ARM64,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE_URL = "http://lzxsvn:3000"
OWNER_REPO = "qinyuanj/kacha"
PLATFORMS = (WIN_X64, MACOS_ARM64)


def local_platform(release_dir: Path, version: str) -> str:
    candidates = [platform for platform in PLATFORMS
                  if (release_dir / updater_name(version, platform)).is_file()]
    if len(candidates) != 1:
        raise SystemExit(f"release/ 必须恰含本机一个 updater 更新包；当前识别为 {candidates}")
    return candidates[0]


def collect_local_artifacts(release_dir: Path, version: str) -> tuple[str, list[Path]]:
    """取本机完整发布集合；与版本不一致的发布产物即拒绝。"""
    stale = foreign_artifacts(release_dir, version)
    if stale:
        raise SystemExit(
            f"release/ 存在与版本 {version} 不一致的发布产物：{', '.join(stale)}。"
            "版本号唯一来源是 client/src-tauri/Cargo.toml；请清理旧产物或先 bump 版本。"
        )
    platform = local_platform(release_dir, version)
    updater = release_dir / updater_name(version, platform)
    signature = release_dir / (updater.name + ".sig")
    paths = [updater, signature]
    if platform == MACOS_ARM64:
        paths.insert(0, release_dir / f"kacha-{version}-macos-arm64.zip")
    missing = [path.name for path in paths if not path.is_file()]
    if missing:
        raise SystemExit(f"缺少必要发布材料：{', '.join(missing)}；请在本机运行 packaging/build_release.py。")
    read_signature(signature)
    return platform, paths


def verify_before_upload(release_dir: Path, artifacts: list[Path], body: str = "") -> None:
    """上传前重核本地发布集合；描述由脚本重建，逐平台远端 URL 决定其哈希。"""
    checksums_path = release_dir / CHECKSUMS_NAME
    if not checksums_path.is_file():
        raise SystemExit(f"缺少校验值文件：{checksums_path}")
    listed = read_checksums(checksums_path)
    descriptor_names = {descriptor_name(platform) for platform in PLATFORMS}
    verified_names = {name for name in listed if name not in descriptor_names}
    missing: list[str] = []
    mismatch: list[str] = []
    for name in verified_names:
        target = release_dir / name
        if not target.is_file():
            missing.append(name)
        elif hashlib.sha256(target.read_bytes()).hexdigest() != listed[name]:
            mismatch.append(name)
    if missing:
        raise SystemExit(f"{CHECKSUMS_NAME} 列出的文件缺失：{', '.join(missing)}")
    if mismatch:
        raise SystemExit(f"{CHECKSUMS_NAME} 与文件哈希不一致：{', '.join(mismatch)}（拒绝上传）")
    if not verified_names:
        raise SystemExit(f"{CHECKSUMS_NAME} 为空，无可核对条目。")
    unlisted = [path.name for path in artifacts if path.name not in listed]
    if unlisted:
        raise SystemExit(f"本地发布产物未列入 {CHECKSUMS_NAME}：{', '.join(unlisted)}")


def release_body(repo_root: Path, version: str) -> str:
    """Release 正文只使用发布说明文件。"""
    notes_path = repo_root / "docs" / "release" / f"release-notes-{version}.md"
    if not notes_path.is_file():
        raise SystemExit(
            f"缺少发布说明：docs/release/release-notes-{version}.md；"
            "请按 docs/release/release-notes-template.md 撰写后再发布。"
        )
    return notes_path.read_text(encoding="utf-8").rstrip()


class GiteaError(RuntimeError):
    """Gitea API 调用失败（连接、鉴权或非 404 错误）。"""


class ReleaseApi(Protocol):
    """publish 流程依赖的 Gitea 操作；测试用内存实现替换。"""

    def release_for_tag(self, tag: str) -> dict | None: ...
    def create_release(self, tag: str, name: str, body: str) -> dict: ...
    def update_release(self, release_id: int, name: str, body: str) -> None: ...
    def list_assets(self, release_id: int) -> list[dict]: ...
    def download_url(self, url: str) -> bytes: ...
    def delete_asset(self, release_id: int, asset_id: int) -> None: ...
    def upload_asset(self, release_id: int, filename: str, data: bytes) -> None: ...


class GiteaClient:
    """Gitea Release API 的薄封装；404 作为“不存在”返回而非异常。"""

    def __init__(self, base_url: str, token: str, owner_repo: str) -> None:
        self._api = f"{base_url.rstrip('/')}/api/v1/repos/{owner_repo}"
        self._token = token

    def _request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, object] | None = None,
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
        allow_404: bool = False,
    ) -> tuple[int, bytes]:
        request_headers = {
            "Authorization": f"token {self._token}",
            "Accept": "application/json",
        }
        data: bytes | None = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        elif raw is not None:
            data = raw
        request_headers.update(headers or {})
        request = urllib.request.Request(
            f"{self._api}{path}", data=data, method=method, headers=request_headers
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code == 404 and allow_404:
                return 404, detail.encode("utf-8")
            raise GiteaError(
                f"Gitea 请求失败：{method} {path} → HTTP {error.code}：{detail}"
            ) from error
        except urllib.error.URLError as error:
            raise GiteaError(f"无法连接 Gitea（{self._api}{path}）：{error.reason}") from error

    def _json(self, method: str, path: str, **kwargs: object) -> tuple[int, object]:
        status, body = self._request(method, path, **kwargs)  # type: ignore[arg-type]
        return status, json.loads(body) if body else {}

    def release_for_tag(self, tag: str) -> dict | None:
        status, body = self._json("GET", f"/releases/tags/{tag}", allow_404=True)
        return body if status == 200 else None  # type: ignore[return-value]

    def create_release(self, tag: str, name: str, body: str) -> dict:
        _, release = self._json(
            "POST", "/releases",
            payload={"tag_name": tag, "name": name, "body": body,
                     "draft": False, "prerelease": False},
        )
        return release  # type: ignore[return-value]

    def update_release(self, release_id: int, name: str, body: str) -> None:
        self._json("PATCH", f"/releases/{release_id}", payload={"name": name, "body": body})

    def list_assets(self, release_id: int) -> list[dict]:
        _, assets = self._json("GET", f"/releases/{release_id}/assets")
        return assets  # type: ignore[return-value]

    def download_url(self, url: str) -> bytes:
        """按 browser_download_url 取附件内容（旧版 Gitea 没有附件元数据 GET 端点）。"""
        request = urllib.request.Request(url, headers={"Authorization": f"token {self._token}"})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise GiteaError(f"Gitea 附件下载失败：{url} → HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise GiteaError(f"无法下载 Gitea 附件（{url}）：{error.reason}") from error

    def delete_asset(self, release_id: int, asset_id: int) -> None:
        """删除附件；本实例路由是嵌套的 /releases/{release}/assets/{asset}，
        扁平的 /releases/assets/{asset} 会 404。"""
        self._request("DELETE", f"/releases/{release_id}/assets/{asset_id}")

    def upload_asset(self, release_id: int, filename: str, data: bytes) -> None:
        boundary = uuid.uuid4().hex
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="attachment"; filename="{filename}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8") + data + f"\r\n--{boundary}--\r\n".encode("utf-8")
        self._request(
            "POST", f"/releases/{release_id}/assets", raw=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )


def upload_replace(api: ReleaseApi, release_id: int, filename: str, data: bytes) -> None:
    """幂等上传：同名附件先删后传，保证重复执行只替换不重复。"""
    for asset in api.list_assets(release_id):
        if asset["name"] == filename:
            api.delete_asset(release_id, int(asset["id"]))
    api.upload_asset(release_id, filename, data)
    print(f"[ok] 附件已上传/替换：{filename}")


def remote_checksums_text(api: ReleaseApi, release_id: int) -> str | None:
    for asset in api.list_assets(release_id):
        if asset["name"] == CHECKSUMS_NAME:
            url = str(asset.get("browser_download_url") or "")
            if url:
                return api.download_url(url).decode("utf-8", "replace")
    return None


def replace_checksums_with_remote(api: ReleaseApi, release_id: int,
                                  release_dir: Path, descriptor: Path) -> bytes:
    """Remote SHA256SUMS wins for entries whose attached bytes were unchanged."""
    entries: dict[str, str] = {}
    for name, digest in read_checksums(release_dir / CHECKSUMS_NAME).items():
        local = release_dir / name
        if local.is_file():
            entries[name] = hashlib.sha256(local.read_bytes()).hexdigest()
    for asset in api.list_assets(release_id):
        name = asset["name"]
        if name == CHECKSUMS_NAME:
            continue
        url = str(asset.get("browser_download_url") or "")
        if url:
            entries[name] = hashlib.sha256(api.download_url(url)).hexdigest()
    # The ready descriptor is generated after building and has not been uploaded yet.
    entries[descriptor.name] = hashlib.sha256(descriptor.read_bytes()).hexdigest()
    from release_meta import format_checksums
    return format_checksums(entries).encode("utf-8")


def publish(api: ReleaseApi, release_dir: Path, version: str, body: str,
            artifacts: list[Path]) -> None:
    """上传/替换本机发布材料，描述文件在完整集合就绪后最后发布。"""
    platform = local_platform(release_dir, version)
    tag = f"v{version}"
    release = api.release_for_tag(tag)
    if release is None:
        release = api.create_release(tag, version, body)
        print(f"[ok] 已创建 Release：{tag}")
    else:
        api.update_release(int(release["id"]), version, body)
        print(f"[ok] 复用已有 Release：{tag}（正文已更新）")
    release_id = int(release["id"])

    # Republish withdraws the ready marker before any artifacts are replaced.
    descriptor = descriptor_name(platform)
    for asset in api.list_assets(release_id):
        if asset["name"] == descriptor:
            api.delete_asset(release_id, int(asset["id"]))
            print(f"[ok] 已撤下旧更新描述：{descriptor}")

    for artifact_path in artifacts:
        upload_replace(api, release_id, artifact_path.name, artifact_path.read_bytes())

    updater = updater_name(version, platform)
    url = None
    for asset in api.list_assets(release_id):
        if asset["name"] == updater:
            url = asset.get("browser_download_url")
            break
    if not url:
        raise GiteaError(f"更新包上传后仍找不到附件 URL：{updater}")
    pub_date = release.get("created_at") or release.get("published_at") or "1970-01-01T00:00:00Z"
    descriptor_json = updater_descriptor(
        version, platform, body, str(pub_date), str(url),
        read_signature(release_dir / f"{updater}.sig"),
    )
    descriptor_bytes = json.dumps(descriptor_json, ensure_ascii=False,
                                  separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"
    (release_dir / descriptor).write_bytes(descriptor_bytes)

    merged = replace_checksums_with_remote(api, release_id, release_dir, release_dir / descriptor)
    upload_replace(api, release_id, CHECKSUMS_NAME, merged)
    upload_replace(api, release_id, descriptor, descriptor_bytes)


def main(
    argv: list[str] | None = None,
    *,
    repo_root: Path = REPO_ROOT,
    client_factory: Callable[[str, str, str], ReleaseApi] = GiteaClient,
) -> int:
    parser = argparse.ArgumentParser(description="把本机完整 updater 发布集合上传到 Gitea Release（幂等）")
    parser.add_argument(
        "--release-dir",
        default=str(repo_root / "release"),
        help="发布产物目录（build_release.py 的输出目录）",
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Gitea 实例地址")
    parser.add_argument("--repo", default=OWNER_REPO, help="目标仓库 owner/name")
    args = parser.parse_args(argv)

    token = os.environ.get("GITEA_TOKEN", "").strip()
    if not token:
        raise SystemExit("缺少环境变量 GITEA_TOKEN：发布脚本只从环境变量读取 Gitea token。")

    try:
        version = tauri_version(repo_root)
    except ReleaseMetaError as error:
        raise SystemExit(str(error)) from error

    release_dir = Path(args.release_dir)
    platform, artifacts = collect_local_artifacts(release_dir, version)
    verify_before_upload(release_dir, artifacts)
    body = release_body(repo_root, version)
    print(f"[ok] 本地核对通过：版本 {version}，{len(artifacts)} 个平台发布物与 {CHECKSUMS_NAME} 一致。")

    api = client_factory(args.base_url, token, args.repo)
    try:
        publish(api, release_dir, version, body, artifacts)
    except GiteaError as error:
        raise SystemExit(str(error)) from error

    tag = f"v{version}"
    print()
    print(f"Release：{args.base_url.rstrip('/')}/{args.repo}/releases/tag/{tag}")
    print(f"附件：  {', '.join(path.name for path in artifacts)}、{descriptor_name(platform)}、{CHECKSUMS_NAME}")
    print("另一端构建完成后再跑一次本脚本即可合并进同一 Release。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
