"""发布脚本测试（issue #53：Gitea Release 三附件分发）。

对着内存中的假 Gitea HTTP 服务验证 packaging/publish_release.py CLI：
token 只从环境变量读取、上传前重核 SHA256SUMS、zip 名必须与 pyproject
版本号一致、两端先后发布幂等合并到同一 release（附件替换不重复、
SHA256SUMS 跨平台合并）。
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import tomllib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGING_DIR = REPO_ROOT / "packaging"
API_PREFIX = "/api/v1/repos/qinyuanj/ugc-image-tool"
TOKEN = "***"


def repo_version() -> str:
    """版本号唯一来源：pyproject.toml 的 version。"""
    with (REPO_ROOT / "pyproject.toml").open("rb") as stream:
        return tomllib.load(stream)["project"]["version"]


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: "_FakeGiteaState"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass

    def _reply(self, status: int, payload: object = b"", content_type: str = "application/json") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return self.headers.get("Authorization") == f"token {TOKEN}"

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length)

    def _route(self, method: str) -> None:
        path = self.path.split("?")[0]
        with self.state.lock:
            self.state.requests.append((method, path))
        if path.startswith("/attachments/"):
            if not self._authorized():
                self._reply(401, {"message": "token required"})
                return
            with self.state.lock:
                data = self.state.attachments.get(path.split("/")[-1])
            if data is None:
                self._reply(404, {"message": "attachment not found"})
            else:
                self._reply(200, data, content_type="application/octet-stream")
            return
        if not path.startswith(API_PREFIX):
            self._reply(404, {"message": "not found"})
            return
        if not self._authorized():
            self._reply(401, {"message": "token required"})
            return
        route = path[len(API_PREFIX):]
        parts = [part for part in route.split("/") if part]
        with self.state.lock:
            self._dispatch(method, parts)

    def _dispatch(self, method: str, parts: list[str]) -> None:
        state = self.state
        if method == "GET" and parts[:2] == ["releases", "tags"] and len(parts) == 3:
            release = state.releases.get(parts[2])
            if release is None:
                self._reply(404, {"message": "release not found"})
            else:
                self._reply(200, release)
            return
        if method == "POST" and parts == ["releases"]:
            payload = json.loads(self._read_body())
            release = {
                "id": state.next_release_id,
                "tag_name": payload["tag_name"],
                "name": payload.get("name", ""),
                "body": payload.get("body", ""),
            }
            state.next_release_id += 1
            state.releases[release["tag_name"]] = release
            state.assets[release["id"]] = {}
            self._reply(201, release)
            return
        if method == "PATCH" and parts[:1] == ["releases"] and len(parts) == 2:
            release = next((item for item in state.releases.values() if item["id"] == int(parts[1])), None)
            if release is None:
                self._reply(404, {"message": "release not found"})
                return
            payload = json.loads(self._read_body())
            release.update({key: payload[key] for key in ("name", "body") if key in payload})
            self._reply(200, release)
            return
        if method == "GET" and parts[:1] == ["releases"] and parts[2:3] == ["assets"] and len(parts) == 3:
            assets = state.assets.get(int(parts[1]), {})
            self._reply(200, [self._asset_meta(asset) for asset in assets.values()])
            return
        if method == "POST" and parts[:1] == ["releases"] and parts[2:3] == ["assets"] and len(parts) == 3:
            name, data = self._parse_attachment()
            release_id = int(parts[1])
            uuid = f"att-{state.next_asset_id}"
            asset = {"id": state.next_asset_id, "name": name, "uuid": uuid}
            state.next_asset_id += 1
            state.assets[release_id][asset["id"]] = asset
            state.attachments[uuid] = data
            self._reply(201, self._asset_meta(asset))
            return
        if parts[:1] == ["releases"] and parts[1:2] == ["assets"] and len(parts) == 3:
            asset_id = int(parts[2])
            if method == "GET":
                # 本 Gitea 实例没有附件元数据 GET 端点（实测 404）；内容一律经
                # 列表里的 browser_download_url 下载。
                self._reply(404, b"404 page not found", content_type="text/plain")
                return
            for assets in state.assets.values():
                if asset_id in assets:
                    if method == "DELETE":
                        state.attachments.pop(assets[asset_id]["uuid"], None)
                        del assets[asset_id]
                        self._reply(204)
                    else:
                        self._reply(405, {"message": "method not allowed"})
                    return
            self._reply(404, {"message": "asset not found"})
            return
        self._reply(404, {"message": f"no fake route: {method} {parts}"})

    def _asset_meta(self, asset: dict) -> dict:
        base = f"http://{self.server.server_address[0]}:{self.server.server_address[1]}"
        return {
            "id": asset["id"],
            "name": asset["name"],
            "uuid": asset["uuid"],
            "browser_download_url": f"{base}/attachments/{asset['uuid']}",
        }

    def _parse_attachment(self) -> tuple[str, bytes]:
        boundary = self.headers["Content-Type"].split("boundary=")[1].strip().encode("utf-8")
        for part in self._read_body().split(b"--" + boundary):
            header_blob, separator, content = part.partition(b"\r\n\r\n")
            if separator and b'name="attachment"' in header_blob:
                filename = header_blob.split(b'filename="')[1].split(b'"')[0].decode("utf-8")
                return filename, content.removesuffix(b"\r\n")
        raise ValueError("multipart body has no attachment part")

    def do_GET(self) -> None:  # noqa: N802
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._route("DELETE")

    def do_PATCH(self) -> None:  # noqa: N802
        self._route("PATCH")


class _FakeGiteaState:
    def __init__(self) -> None:
        self.releases: dict[str, dict] = {}
        self.assets: dict[int, dict[int, dict]] = {}
        self.attachments: dict[str, bytes] = {}  # uuid -> 附件内容
        self.next_release_id = 1
        self.next_asset_id = 1
        self.requests: list[tuple[str, str]] = []
        self.lock = threading.Lock()


class FakeGitea:
    """内存假 Gitea：只实现 publish_release.py 需要的 Release/附件端点。"""

    def __init__(self) -> None:
        self.state = _FakeGiteaState()
        handler = type("BoundHandler", (_Handler,), {"state": self.state})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def release_for_tag(self, tag: str) -> dict | None:
        return self.state.releases.get(tag)

    def asset_names(self, release_id: int) -> set[str]:
        return {asset["name"] for asset in self.state.assets.get(release_id, {}).values()}

    def asset_bytes(self, release_id: int, name: str) -> bytes:
        for asset in self.state.assets.get(release_id, {}).values():
            if asset["name"] == name:
                return self.state.attachments[asset["uuid"]]
        raise KeyError(name)


def make_release_dir(root: Path, *platforms: str, version: str | None = None) -> Path:
    """模拟一台构建机的 release/ 目录：平台 zip + 本机 SHA256SUMS。"""
    version = version or repo_version()
    release_dir = root / "release"
    release_dir.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for platform in platforms:
        zip_name = f"ugc-image-tool-{version}-{platform}.zip"
        (release_dir / zip_name).write_bytes(f"fake zip {platform}".encode("utf-8"))
        lines.append(f"{hashlib.sha256((release_dir / zip_name).read_bytes()).hexdigest()}  {zip_name}")
    (release_dir / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return release_dir


def run_publish(
    release_dir: Path,
    base_url: str,
    *,
    token: str | None = TOKEN,
) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env.pop("GITEA_TOKEN", None)
    if token is not None:
        env["GITEA_TOKEN"] = token
    return subprocess.run(
        [
            sys.executable,
            str(PACKAGING_DIR / "publish_release.py"),
            "--release-dir", str(release_dir),
            "--base-url", base_url,
        ],
        capture_output=True, text=True, env=env, cwd=REPO_ROOT,
    )


def test_first_publish_creates_release_with_notes_body() -> None:
    version = repo_version()
    with tempfile.TemporaryDirectory() as temp:
        release_dir = make_release_dir(Path(temp), "win-x64")
        gitea = FakeGitea()
        try:
            result = run_publish(release_dir, gitea.base_url)
            assert result.returncode == 0, result.stdout + result.stderr
            release = gitea.release_for_tag(f"v{version}")
            assert release is not None, "未按版本号创建 tag v<版本> 的 release"
            assert release["name"] == version
            assert gitea.asset_names(release["id"]) == {
                f"ugc-image-tool-{version}-win-x64.zip",
                "SHA256SUMS",
            }
            # 正文来自发布说明，且含首次运行的绕过提示（ADR 0007）。
            assert "安全声明" in release["body"]
            assert "仍要运行" in release["body"]
            assert "右键" in release["body"]
            # 附件字节与本地一致。
            zip_bytes = gitea.asset_bytes(release["id"], f"ugc-image-tool-{version}-win-x64.zip")
            assert zip_bytes == (release_dir / f"ugc-image-tool-{version}-win-x64.zip").read_bytes()
        finally:
            gitea.stop()


def test_both_platforms_merge_into_one_release_idempotently() -> None:
    """Win 机与 Mac 机各发布一次进同一 release；重复跑只替换不重复。"""
    version = repo_version()
    win_zip = f"ugc-image-tool-{version}-win-x64.zip"
    mac_zip = f"ugc-image-tool-{version}-macos-arm64.zip"
    with tempfile.TemporaryDirectory() as temp:
        win_dir = make_release_dir(Path(temp) / "win", "win-x64")
        mac_dir = make_release_dir(Path(temp) / "mac", "macos-arm64")
        for release_dir, platform in ((win_dir, "win-x64"), (mac_dir, "macos-arm64")):
            (release_dir / "build-info.json").write_text(
                json.dumps({"version": version, "archive": f"ugc-image-tool-{version}-{platform}.zip",
                            "platform": platform}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        gitea = FakeGitea()
        try:
            assert run_publish(win_dir, gitea.base_url).returncode == 0
            assert run_publish(mac_dir, gitea.base_url).returncode == 0
            release = gitea.release_for_tag(f"v{version}")
            assert release is not None
            assert len(gitea.state.releases) == 1, "两端发布必须进同一个 release"
            # 恰好三个附件；SHA256SUMS 合并后覆盖两个平台的压缩包。
            assert gitea.asset_names(release["id"]) == {win_zip, mac_zip, "SHA256SUMS"}
            checksums = gitea.asset_bytes(release["id"], "SHA256SUMS").decode("utf-8")
            assert win_zip in checksums and mac_zip in checksums
            for name, data in ((win_zip, win_dir / win_zip), (mac_zip, mac_dir / mac_zip)):
                assert hashlib.sha256(data.read_bytes()).hexdigest() in checksums, name
            # 两端构建信息都在正文里：第二端发布不能丢掉第一端的摘要。
            assert f"### {win_zip}" in release["body"]
            assert f"### {mac_zip}" in release["body"]
            # Mac 端再跑一次：附件仍为三个（替换而非重复），内容不变。
            assert run_publish(mac_dir, gitea.base_url).returncode == 0
            assert gitea.asset_names(release["id"]) == {win_zip, mac_zip, "SHA256SUMS"}
            assert gitea.asset_bytes(release["id"], "SHA256SUMS").decode("utf-8") == checksums
        finally:
            gitea.stop()


def test_publish_requires_gitea_token_env() -> None:
    with tempfile.TemporaryDirectory() as temp:
        release_dir = make_release_dir(Path(temp), "win-x64")
        gitea = FakeGitea()
        try:
            result = run_publish(release_dir, gitea.base_url, token=None)
            assert result.returncode != 0
            assert "GITEA_TOKEN" in result.stdout + result.stderr
            assert gitea.state.requests == [], "缺少 token 时不应发起任何请求"
        finally:
            gitea.stop()


def test_publish_refuses_checksum_mismatch_before_any_upload() -> None:
    with tempfile.TemporaryDirectory() as temp:
        release_dir = make_release_dir(Path(temp), "win-x64")
        zip_path = next(release_dir.glob("*.zip"))
        zip_path.write_bytes(b"tampered content")  # SHA256SUMS 未随之更新
        gitea = FakeGitea()
        try:
            result = run_publish(release_dir, gitea.base_url)
            assert result.returncode != 0
            assert "SHA256SUMS" in result.stdout + result.stderr
            assert gitea.state.releases == {}, "校验失败时不应创建 release 或上传附件"
            assert not any(method == "POST" for method, _ in gitea.state.requests)
        finally:
            gitea.stop()


def test_publish_refuses_zip_from_another_version() -> None:
    version = repo_version()
    with tempfile.TemporaryDirectory() as temp:
        release_dir = make_release_dir(Path(temp), "win-x64")
        stale = release_dir / "ugc-image-tool-0.0.1-win-x64.zip"
        stale.write_bytes(b"stale artifact")
        checksums = release_dir / "SHA256SUMS"
        checksums.write_text(
            checksums.read_text(encoding="utf-8")
            + f"{hashlib.sha256(b'stale artifact').hexdigest()}  {stale.name}\n",
            encoding="utf-8",
        )
        gitea = FakeGitea()
        try:
            result = run_publish(release_dir, gitea.base_url)
            assert result.returncode != 0
            output = result.stdout + result.stderr
            assert "0.0.1" in output and version in output
            assert gitea.state.releases == {}
        finally:
            gitea.stop()
