"""The updater configuration consumed by the official Tauri plugins."""

import base64
import json
import unittest

from _support import REPO_ROOT


class UpdaterConfigTest(unittest.TestCase):
    def test_signed_updates_preserve_identity_and_use_current_user_install(self):
        config = json.loads((REPO_ROOT / "client/src-tauri/tauri.conf.json").read_text())
        self.assertEqual(config["identifier"], "local.ugc.image-tool.v2")
        self.assertTrue(config["bundle"]["createUpdaterArtifacts"])
        self.assertEqual(config["bundle"]["windows"]["nsis"]["installMode"], "currentUser")
        self.assertEqual(config["bundle"]["macOS"]["signingIdentity"], "-")
        updater = config["plugins"]["updater"]
        self.assertTrue(updater["dangerousInsecureTransportProtocol"])
        self.assertEqual(updater["windows"]["installMode"], "passive")
        self.assertIn(b"untrusted comment:", base64.b64decode(updater["pubkey"]))
        self.assertEqual(updater.get("endpoints", []), [])
        capability = json.loads((REPO_ROOT / "client/src-tauri/capabilities/default.json").read_text())
        self.assertIn("updater:default", capability["permissions"])
        self.assertIn("process:allow-restart", capability["permissions"])
