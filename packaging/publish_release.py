"""把 UGC AI 生图工具发布物上传到 Gitea Release（issue #53，ADR 0007）。

Gitea Release 是唯一分发渠道，只挂三个附件：

    ugc-image-tool-<版本>-win-x64.zip
    ugc-image-tool-<版本>-macos-arm64.zip
    SHA256SUMS

两端各在对应机器构建，构建后各跑一次本脚本：创建或复用 tag `v<版本>`
的 Release，上传/替换本机产物（幂等，附件同名替换而非重复）。本机
SHA256SUMS 与远端已有内容合并（本机条目优先），两端都发布后校验值
文件覆盖全部压缩包。

安全闸门（任一不满足即拒绝，且不做任何上传）：

- token 只从环境变量 GITEA_TOKEN 读取，不接受命令行传参；
- 上传前重核 release/SHA256SUMS：缺失文件、哈希不一致、或本地压缩包
  未被列出都算失败；
- 版本号唯一来源是 pyproject.toml 的 version；release/ 里出现与该版本
  不一致的压缩包（如旧版本残留）即拒绝。

Release 标题为版本号，正文来自 docs/release/release-notes-<版本>.md，
本地存在 build-info.json 时附在正文末尾作为构建信息摘要。

示例：

    export GITEA_TOKEN=***   # Windows PowerShell 用 $env:GITEA_TOKEN
    python packaging/publish_release.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from release_meta import pyproject_version
from security_scan import parse_checksums_text, read_checksums, verify_sha256

REPO_ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_BASE = "ugc-image-tool"
PLATFORMS = ("win-x64", "macos-arm64")
CHECKSUMS_NAME = "SHA256SUMS"
DEFAULT_BASE_URL = "http://lzxsvn:3000"
OWNER_REPO = "qinyuanj/ugc-image-tool"


def zip_name(version: str, platform: str) -> str:
    return f"{ARCHIVE_BASE}-{version}-{platform}.zip"


def collect_local_zips(release_dir: Path, version: str) -> list[Path]:
    """取本机构建好的平台压缩包；出现与版本不一致的 zip 即拒绝。"""
    expected = {zip_name(version, platform) for platform in PLATFORMS}
    zips = sorted(release_dir.glob("*.zip"))
    unexpected = [path.name for path in zips if path.name not in expected]
    if unexpected:
        raise SystemExit(
            f"release/ 存在与版本 {version} 不一致的压缩包：{', '.join(unexpected)}。"
            "版本号唯一来源是 pyproject.toml；请清理旧产物或先 bump 版本。"
        )
    if not zips:
        raise SystemExit(
            f"release/ 没有可发布的压缩包（期望 {', '.join(sorted(expected))} 中至少一个）；"
            "请先在本机运行对应的构建脚本。"
        )
    return zips


def verify_before_upload(release_dir: Path, zips: list[Path]) -> None:
    """上传前重核 SHA256SUMS：缺失、不一致、压缩包未被列出都拒绝发布。"""
    checksums_path = release_dir / CHECKSUMS_NAME
    if not checksums_path.is_file():
        raise SystemExit(f"缺少校验值文件：{checksums_path}")
    verified, missing, mismatch = verify_sha256(release_dir, checksums_path)
    if missing:
        raise SystemExit(f"{CHECKSUMS_NAME} 列出的文件缺失：{', '.join(missing)}")
    if mismatch:
        raise SystemExit(f"{CHECKSUMS_NAME} 与文件哈希不一致：{', '.join(mismatch)}（拒绝上传）")
    if not verified:
        raise SystemExit(f"{CHECKSUMS_NAME} 为空，无可核对条目。")
    listed = read_checksums(checksums_path)
    unlisted = [path.name for path in zips if path.name not in listed]
    if unlisted:
        raise SystemExit(f"本地压缩包未列入 {CHECKSUMS_NAME}：{', '.join(unlisted)}")


def merge_checksums(local_text: str, remote_text: str | None) -> str:
    """合并两端校验值：远端已有条目打底，本机条目按文件名覆盖。"""
    merged = parse_checksums_text(remote_text or "")
    merged.update(parse_checksums_text(local_text))
    return "".join(f"{digest}  {name}\n" for name, digest in sorted(merged.items()))


_BUILD_INFO_HEADER = "## 构建信息"


def _local_build_info_section(release_dir: Path) -> dict[str, str]:
    """本机 build-info.json 转成 '### <压缩包名>' 小节；无文件则无小节。"""
    build_info_path = release_dir / "build-info.json"
    if not build_info_path.is_file():
        return {}
    info_text = build_info_path.read_text(encoding="utf-8").strip()
    try:
        archive = str(json.loads(info_text).get("archive", "unknown"))
    except json.JSONDecodeError:
        archive = "unknown"
    return {archive: f"### {archive}\n\n```json\n{info_text}\n```"}


def _parse_build_info_sections(body: str) -> dict[str, str]:
    """从已有正文的构建信息区解析各 '### <压缩包名>' 小节。"""
    index = body.find(_BUILD_INFO_HEADER)
    if index < 0:
        return {}
    sections: dict[str, str] = {}
    current_name: str | None = None
    current: list[str] = []
    for line in body[index:].splitlines():
        if line.startswith("### "):
            if current_name is not None:
                sections[current_name] = "\n".join(current).rstrip()
            current_name = line[len("### "):].strip()
            current = [line]
        elif current_name is not None:
            current.append(line)
    if current_name is not None:
        sections[current_name] = "\n".join(current).rstrip()
    return sections


def release_body(version: str, release_dir: Path, existing_body: str | None = None) -> str:
    """Release 正文：发布说明全文 + 构建信息小节。

    两端先后发布时，保留已有正文里其他平台（按压缩包名区分）的构建信息
    小节，本机小节按压缩包名覆盖，避免第二端发布丢掉第一端摘要。
    """
    notes_path = REPO_ROOT / "docs" / "release" / f"release-notes-{version}.md"
    if not notes_path.is_file():
        raise SystemExit(
            f"缺少发布说明：{notes_path.relative_to(REPO_ROOT)}；请先撰写再发布。"
        )
    body = notes_path.read_text(encoding="utf-8").rstrip()
    sections = _parse_build_info_sections(existing_body or "")
    sections.update(_local_build_info_section(release_dir))
    if sections:
        rendered = "\n\n".join(sections[name] for name in sorted(sections))
        body += f"\n\n---\n\n{_BUILD_INFO_HEADER}\n\n{rendered}\n"
    return body


class GiteaError(RuntimeError):
    """Gitea API 调用失败（连接、鉴权或非 404 错误）。"""


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

    def release_for_tag(self, tag: str) -> dict[str, object] | None:
        status, body = self._json("GET", f"/releases/tags/{tag}", allow_404=True)
        return body if status == 200 else None  # type: ignore[return-value]

    def create_release(self, tag: str, name: str, body: str) -> dict[str, object]:
        _, release = self._json(
            "POST", "/releases",
            payload={"tag_name": tag, "name": name, "body": body,
                     "draft": False, "prerelease": False},
        )
        return release  # type: ignore[return-value]

    def update_release(self, release_id: int, name: str, body: str) -> None:
        self._json("PATCH", f"/releases/{release_id}", payload={"name": name, "body": body})

    def list_assets(self, release_id: int) -> list[dict[str, object]]:
        _, assets = self._json("GET", f"/releases/{release_id}/assets")
        return assets  # type: ignore[return-value]

    def download_url(self, url: str) -> bytes:
        """按 browser_download_url 取附件内容（附件元数据 GET 端点在旧版
        Gitea 上不存在，一律走列表里给出的下载地址）。"""
        request = urllib.request.Request(
            url, headers={"Authorization": f"token {self._token}"}
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise GiteaError(
                f"Gitea 附件下载失败：{url} → HTTP {error.code}"
            ) from error
        except urllib.error.URLError as error:
            raise GiteaError(f"无法下载 Gitea 附件（{url}）：{error.reason}") from error

    def delete_asset(self, release_id: int, asset_id: int) -> None:
        """删除附件；注意本实例路由是嵌套的 /releases/{release}/assets/{asset}，
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

    def upload_replace(self, release_id: int, filename: str, data: bytes) -> None:
        """幂等上传：同名附件先删后传，保证重复执行只替换不重复。"""
        for asset in self.list_assets(release_id):
            if asset["name"] == filename:
                self.delete_asset(release_id, int(asset["id"]))  # type: ignore[arg-type]
        self.upload_asset(release_id, filename, data)
        print(f"[ok] 附件已上传/替换：{filename}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="把本机发布物上传到 Gitea Release（三附件，幂等）"
    )
    parser.add_argument(
        "--release-dir",
        default=str((REPO_ROOT / "release").resolve()),
        help="发布产物目录（构建脚本的输出目录）",
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Gitea 实例地址")
    parser.add_argument("--repo", default=OWNER_REPO, help="目标仓库 owner/name")
    args = parser.parse_args(argv)

    token = os.environ.get("GITEA_TOKEN", "").strip()
    if not token:
        raise SystemExit("缺少环境变量 GITEA_TOKEN：发布脚本只从环境变量读取 Gitea token。")

    release_dir = Path(args.release_dir)
    version = pyproject_version(REPO_ROOT)
    zips = collect_local_zips(release_dir, version)
    verify_before_upload(release_dir, zips)
    print(f"[ok] 本地核对通过：版本 {version}，{len(zips)} 个压缩包与 {CHECKSUMS_NAME} 一致。")

    client = GiteaClient(args.base_url, token, args.repo)
    tag = f"v{version}"
    release = client.release_for_tag(tag)
    existing_body = str(release.get("body") or "") if release else None
    body = release_body(version, release_dir, existing_body)
    if release is None:
        release = client.create_release(tag, version, body)
        print(f"[ok] 已创建 Release：{tag}")
    else:
        client.update_release(int(release["id"]), version, body)  # type: ignore[arg-type]
        print(f"[ok] 复用已有 Release：{tag}（正文已更新，保留各端构建信息）")
    release_id = int(release["id"])  # type: ignore[arg-type]

    try:
        for zip_path in zips:
            client.upload_replace(release_id, zip_path.name, zip_path.read_bytes())

        checksums_path = release_dir / CHECKSUMS_NAME
        local_text = checksums_path.read_text(encoding="utf-8")
        remote_text: str | None = None
        for asset in client.list_assets(release_id):
            if asset["name"] == CHECKSUMS_NAME:
                url = str(asset.get("browser_download_url") or "")  # type: ignore[arg-type]
                if url:
                    remote_text = client.download_url(url).decode("utf-8", "replace")
        merged = merge_checksums(local_text, remote_text)
        client.upload_replace(release_id, CHECKSUMS_NAME, merged.encode("utf-8"))
    except GiteaError as error:
        raise SystemExit(str(error)) from error

    print()
    print(f"Release：{args.base_url.rstrip('/')}/{args.repo}/releases/tag/{tag}")
    print(f"附件：  {', '.join(path.name for path in zips)}、{CHECKSUMS_NAME}")
    print("另一端构建完成后再跑一次本脚本即可合并进同一 Release。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
