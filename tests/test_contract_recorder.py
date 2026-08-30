from __future__ import annotations

import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ugc_image_tool.contracts.recorder import record_exchange


class _GatewayHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(content_length)
        body = b'{"data":[{"url":"https://cdn.example.com/live.png"}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Dashscope-Apikeyid", "internal-account-id")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


class ContractRecorderTests(unittest.TestCase):
    def test_json_text_and_image_fields_are_redacted(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _GatewayHandler)
        server_thread = threading.Thread(target=server.serve_forever)
        server_thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                body_file = Path(directory) / "request.json"
                body_file.write_text(
                    '{"model":"verified","text":"private prompt","image":"private image"}',
                    encoding="utf-8",
                )
                exchange = record_exchange(
                    base_url=f"http://127.0.0.1:{server.server_port}",
                    interface="image_edit",
                    path="/v1/images/edits",
                    method="POST",
                    key="live-secret",
                    body_file=body_file,
                    content_type="application/json",
                    timeout=1,
                )
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join()

        serialized = repr(exchange)
        self.assertNotIn("private prompt", serialized)
        self.assertNotIn("private image", serialized)
        self.assertEqual("[REDACTED_PROMPT]", exchange["request"]["body"]["text"])
        self.assertEqual("[REDACTED_IMAGE]", exchange["request"]["body"]["image"])

    def test_multipart_request_and_download_url_are_redacted(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _GatewayHandler)
        server_thread = threading.Thread(target=server.serve_forever)
        server_thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                body_file = Path(directory) / "edit.multipart"
                body_file.write_bytes(b"private prompt and private image bytes")
                exchange = record_exchange(
                    base_url=f"http://127.0.0.1:{server.server_port}",
                    interface="image_edit",
                    path="/v1/images/edits",
                    method="POST",
                    key="live-secret",
                    body_file=body_file,
                    content_type="multipart/form-data; boundary=test",
                    timeout=1,
                )
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join()

        serialized = repr(exchange)
        self.assertNotIn("live-secret", serialized)
        self.assertNotIn("private prompt", serialized)
        self.assertNotIn("private image bytes", serialized)
        self.assertNotIn("cdn.example.com", serialized)
        self.assertNotIn("internal-account-id", serialized)
        self.assertEqual("[REDACTED_MULTIPART_BODY]", exchange["request"]["body"])


if __name__ == "__main__":
    unittest.main()
