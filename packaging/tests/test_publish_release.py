"""publish_release：用内存假 Gitea 验证安全闸门与两端幂等合并（无网络）。"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from _support import make_release_dir, make_repo

import publish_release

VERSION = "1.2.3"
TOKEN = "test-token"
WIN_ZIP = f"kacha-{VERSION}-win-x64-setup.exe"
MAC_ZIP = f"kacha-{VERSION}-macos-arm64.zip"
WIN_ASSETS = [WIN_ZIP, WIN_ZIP + ".sig", "updater-win-x64.json"]
MAC_ASSETS = [MAC_ZIP, f"kacha-{VERSION}-macos-arm64.app.tar.gz",
              f"kacha-{VERSION}-macos-arm64.app.tar.gz.sig", "updater-macos-arm64.json"]


class FakeGitea:
    """内存假 Gitea：实现 publish 流程用到的 Release/附件操作并记录调用。"""

    def __init__(self) -> None:
        self.releases: dict[str, dict] = {}
        self.assets: dict[int, dict[int, dict]] = {}
        self.blobs: dict[str, bytes] = {}
        self.calls: list[tuple] = []
        self.created_with: list[tuple[str, str, str]] = []
        self._next_release = 1
        self._next_asset = 1

    def factory(self, base_url: str, token: str, owner_repo: str) -> "FakeGitea":
        self.created_with.append((base_url, token, owner_repo))
        return self

    def release_for_tag(self, tag: str) -> dict | None:
        self.calls.append(("release_for_tag", tag))
        return self.releases.get(tag)

    def create_release(self, tag: str, name: str, body: str) -> dict:
        self.calls.append(("create_release", tag))
        release = {"id": self._next_release, "tag_name": tag, "name": name, "body": body}
        self._next_release += 1
        self.releases[tag] = release
        self.assets[release["id"]] = {}
        return release

    def update_release(self, release_id: int, name: str, body: str) -> None:
        self.calls.append(("update_release", release_id))
        for release in self.releases.values():
            if release["id"] == release_id:
                release.update(name=name, body=body)

    def list_assets(self, release_id: int) -> list[dict]:
        return [dict(asset) for asset in self.assets[release_id].values()]

    def download_url(self, url: str) -> bytes:
        return self.blobs[url]

    def delete_asset(self, release_id: int, asset_id: int) -> None:
        self.calls.append(("delete_asset", release_id, asset_id))
        asset = self.assets[release_id].pop(asset_id)
        self.blobs.pop(asset["browser_download_url"], None)

    def upload_asset(self, release_id: int, filename: str, data: bytes) -> None:
        self.calls.append(("upload_asset", release_id, filename))
        if filename == "fail.me":
            raise publish_release.GiteaError("fake upload failure")
        url = f"http://gitea.test/attachments/{self._next_asset}"
        self.assets[release_id][self._next_asset] = {
            "id": self._next_asset, "name": filename, "browser_download_url": url,
        }
        self.blobs[url] = data
        self._next_asset += 1

    # 断言辅助
    def names(self, release_id: int) -> list[str]:
        return sorted(asset["name"] for asset in self.assets[release_id].values())

    def data(self, release_id: int, name: str) -> bytes:
        for asset in self.assets[release_id].values():
            if asset["name"] == name:
                return self.blobs[asset["browser_download_url"]]
        raise KeyError(name)


def run_publish(repo: Path, release_dir: Path, gitea: FakeGitea, *, token: str | None = TOKEN) -> tuple[int | str | None, str]:
    """运行 main；返回 (退出码或 SystemExit 消息, 标准输出)。"""
    env = {key: value for key, value in os.environ.items() if key != "GITEA_TOKEN"}
    if token is not None:
        env["GITEA_TOKEN"] = token
    out = io.StringIO()
    with mock.patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(out):
        try:
            code: int | str | None = publish_release.main(
                ["--release-dir", str(release_dir)], repo_root=repo, client_factory=gitea.factory
            )
        except SystemExit as exit_:
            code = exit_.code
    return code, out.getvalue()


class PublishTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.root = Path(self._temp.name)
        self.repo = make_repo(self.root / "repo", version=VERSION)
        self.gitea = FakeGitea()

    def tearDown(self) -> None:
        self._temp.cleanup()

    def test_first_publish_creates_release_with_notes_body(self) -> None:
        release_dir = make_release_dir(self.root / "win", VERSION, "win-x64")
        code, _ = run_publish(self.repo, release_dir, self.gitea)
        self.assertEqual(code, 0)
        self.assertEqual(
            self.gitea.created_with, [("http://lzxsvn:3000", TOKEN, "qinyuanj/kacha")]
        )
        release = self.gitea.releases[f"v{VERSION}"]
        self.assertEqual(release["name"], VERSION)
        self.assertIn("仍要运行", release["body"])
        self.assertEqual(self.gitea.names(release["id"]), sorted([*WIN_ASSETS, "SHA256SUMS"]))
        self.assertEqual(self.gitea.data(release["id"], WIN_ZIP), (release_dir / WIN_ZIP).read_bytes())
        descriptor = json.loads(self.gitea.data(release["id"], "updater-win-x64.json"))
        self.assertEqual(descriptor["version"], VERSION)
        payload = descriptor["platforms"]["windows-x86_64"]
        installer_asset = next(a for a in self.gitea.list_assets(release["id"]) if a["name"] == WIN_ZIP)
        self.assertEqual(payload["url"], installer_asset["browser_download_url"])
        self.assertEqual(payload["signature"], (release_dir / (WIN_ZIP + ".sig")).read_text())

    def test_both_platforms_merge_into_one_release_idempotently(self) -> None:
        win_dir = make_release_dir(self.root / "win", VERSION, "win-x64")
        mac_dir = make_release_dir(self.root / "mac", VERSION, "macos-arm64")
        self.assertEqual(run_publish(self.repo, win_dir, self.gitea)[0], 0)
        self.assertEqual(run_publish(self.repo, mac_dir, self.gitea)[0], 0)
        self.assertEqual(len(self.gitea.releases), 1)
        release_id = self.gitea.releases[f"v{VERSION}"]["id"]
        self.assertEqual(self.gitea.names(release_id), sorted([*WIN_ASSETS, *MAC_ASSETS, "SHA256SUMS"]))
        checksums = self.gitea.data(release_id, "SHA256SUMS").decode("utf-8")
        for name, path in ((WIN_ZIP, win_dir / WIN_ZIP), (MAC_ZIP, mac_dir / MAC_ZIP)):
            self.assertIn(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {name}", checksums)

        # 再跑一次：附件替换而非重复，内容不变；删除走嵌套路由参数（release_id, asset_id）。
        self.assertEqual(run_publish(self.repo, mac_dir, self.gitea)[0], 0)
        self.assertEqual(self.gitea.names(release_id), sorted([*WIN_ASSETS, *MAC_ASSETS, "SHA256SUMS"]))
        # Gitea gives replacements new URLs; payload bytes stay identical but descriptor hash changes.
        after = self.gitea.data(release_id, "SHA256SUMS").decode("utf-8")
        for name in [*WIN_ASSETS, *MAC_ASSETS]:
            self.assertIn(f"{hashlib.sha256(self.gitea.data(release_id, name)).hexdigest()}  {name}", after)
        self.assertTrue(any(call[0] == "delete_asset" and call[1] == release_id for call in self.gitea.calls))
        self.assertIn(("update_release", release_id), self.gitea.calls)

    def test_requires_gitea_token_env(self) -> None:
        release_dir = make_release_dir(self.root / "win", VERSION, "win-x64")
        code, _ = run_publish(self.repo, release_dir, self.gitea, token=None)
        self.assertIn("GITEA_TOKEN", str(code))
        self.assertEqual(self.gitea.created_with, [])

    def test_interrupted_upload_leaves_no_ready_descriptor(self) -> None:
        release_dir = make_release_dir(self.root / "win", VERSION, "win-x64")
        (release_dir / WIN_ZIP).rename(release_dir / "fail.me")
        with (release_dir / "SHA256SUMS").open("a", encoding="utf-8") as stream:
            stream.write(f"{hashlib.sha256(b'fake updater win-x64').hexdigest()}  fail.me\n")
        release = self.gitea.create_release(f"v{VERSION}", VERSION, "notes")
        body = publish_release.release_body(self.repo, VERSION)
        with self.assertRaises(publish_release.GiteaError) as ctx, mock.patch.object(
            publish_release, "local_platform", return_value="win-x64"
        ):
            publish_release.publish(self.gitea, release_dir, VERSION, body,
                                    [release_dir / "fail.me", release_dir / f"{WIN_ZIP}.sig"])
        code = ctx.exception
        self.assertIn("fail", str(code).lower())
        self.assertEqual(self.gitea.names(1), [])

    def test_refuses_checksum_mismatch_before_any_upload(self) -> None:
        release_dir = make_release_dir(self.root / "win", VERSION, "win-x64")
        (release_dir / WIN_ZIP).write_bytes(b"tampered")
        code, _ = run_publish(self.repo, release_dir, self.gitea)
        self.assertIn("SHA256SUMS", str(code))
        self.assertEqual(self.gitea.calls, [])

    def test_refuses_unlisted_foreign_artifact_before_upload(self) -> None:
        release_dir = make_release_dir(self.root / "win", VERSION, "win-x64")
        (release_dir / "kacha-9.9.9-macos-arm64.zip").write_bytes(b"unlisted")
        code, _ = run_publish(self.repo, release_dir, self.gitea)
        self.assertIn("9.9.9", str(code))
        self.assertEqual(self.gitea.calls, [])

    def test_refuses_zip_from_another_version(self) -> None:
        release_dir = make_release_dir(self.root / "win", VERSION, "win-x64")
        (release_dir / "kacha-0.0.1-win-x64.zip").write_bytes(b"stale")
        code, _ = run_publish(self.repo, release_dir, self.gitea)
        self.assertIn("0.0.1", str(code))
        self.assertIn(VERSION, str(code))
        self.assertEqual(self.gitea.calls, [])

    def test_refuses_without_release_notes(self) -> None:
        repo = make_repo(self.root / "bare", version=VERSION, notes=False)
        release_dir = make_release_dir(self.root / "win", VERSION, "win-x64")
        code, _ = run_publish(repo, release_dir, self.gitea)
        self.assertIn(f"release-notes-{VERSION}.md", str(code))
        self.assertEqual(self.gitea.calls, [])

    def test_refuses_version_mismatch_between_cargo_and_conf(self) -> None:
        repo = make_repo(self.root / "mismatch", version=VERSION, conf_version="9.9.9")
        release_dir = make_release_dir(self.root / "win", VERSION, "win-x64")
        code, _ = run_publish(repo, release_dir, self.gitea)
        self.assertIn("9.9.9", str(code))
        self.assertEqual(self.gitea.calls, [])


class GiteaClientRouteTest(unittest.TestCase):
    """真实客户端的路由拼装（打桩 _request，不发请求）。"""

    def test_delete_uses_nested_asset_route(self) -> None:
        client = publish_release.GiteaClient("http://example:3000/", TOKEN, "o/r")
        with mock.patch.object(client, "_request", return_value=(204, b"")) as request:
            client.delete_asset(7, 42)
        request.assert_called_once_with("DELETE", "/releases/7/assets/42")

    def test_missing_release_returns_none(self) -> None:
        client = publish_release.GiteaClient("http://example:3000", TOKEN, "o/r")
        with mock.patch.object(client, "_request", return_value=(404, b'{"message": "x"}')) as request:
            self.assertIsNone(client.release_for_tag("v1.2.3"))
        request.assert_called_once_with("GET", "/releases/tags/v1.2.3", allow_404=True)

    def test_upload_sends_multipart_attachment(self) -> None:
        client = publish_release.GiteaClient("http://example:3000", TOKEN, "o/r")
        with mock.patch.object(client, "_request", return_value=(201, b"{}")) as request:
            client.upload_asset(3, "SHA256SUMS", b"payload")
        method, path = request.call_args.args
        self.assertEqual((method, path), ("POST", "/releases/3/assets"))
        body = request.call_args.kwargs["raw"]
        self.assertIn(b'name="attachment"; filename="SHA256SUMS"', body)
        self.assertIn(b"payload", body)
        self.assertIn("multipart/form-data; boundary=", request.call_args.kwargs["headers"]["Content-Type"])


if __name__ == "__main__":
    unittest.main()
