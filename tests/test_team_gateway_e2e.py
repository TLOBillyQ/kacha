"""真实适配器端到端验收：本地网关按脱敏契约回放，验证完整任务闭环。

覆盖提交、执行、结果下载、保存、预览；网关拒绝、限流、连接中断、
等待超时、部分结果和下载失败等用户状态映射。
"""

from __future__ import annotations

import base64
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast

from ugc_image_tool.application import GenerationApplication
from ugc_image_tool.capabilities import CapabilityRegistry
from ugc_image_tool.generation import (
    GenerationStatus,
    ImageEditDraft,
    TextToImageDraft,
)
from ugc_image_tool.results import FileResultRepository, UrlImageFetcher
from ugc_image_tool.team_gateway import TeamGateway

PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
)
BASE64_PNG_1X1 = base64.b64encode(PNG_1X1).decode()

FIXTURES = (
    Path(__file__).resolve().parents[1]
    / "contracts"
    / "fixtures"
    / "2026-08-17-team-gateway"
)


class GatewayBehavior:
    """本地网关的可编程行为：状态码、sleep、是否返回部分结果等。"""

    def __init__(self) -> None:
        self.models_status = 200
        self.generation_status = 200
        self.generation_sleep = 0.0
        self.return_partial = False
        self.download_status = 200
        self.generation_calls = 0
        self.generation_request_ids: list[str] = []

    def reset(self) -> None:
        self.models_status = 200
        self.generation_status = 200
        self.generation_sleep = 0.0
        self.return_partial = False
        self.download_status = 200
        self.generation_calls = 0
        self.generation_request_ids = []


class RecordingGatewayHandler(BaseHTTPRequestHandler):
    behavior = GatewayBehavior()
    server_version = "RecordingGateway/1.0"

    def log_message(self, format: str, *args: object) -> None:
        return

    def _scheme(self) -> str:
        import ssl

        if isinstance(self.connection, ssl.SSLSocket):
            return "https"
        return "http"

    def _base(self) -> str:
        server = cast(ThreadingHTTPServer, self.server)
        return f"{self._scheme()}://127.0.0.1:{server.server_port}"

    def do_GET(self) -> None:
        if self.path == "/v1/models":
            fixture = json.loads(
                (FIXTURES / "models-success.json").read_text(encoding="utf-8")
            )
            self._json(self.behavior.models_status, fixture["response"]["body"])
        elif self.path.startswith("/download/"):
            if self.behavior.download_status >= 400:
                self._json(self.behavior.download_status, {"error": {"message": "图片不存在"}})
            elif self.path == "/download/1.png":
                self._raw(200, PNG_1X1, "image/png")
            elif self.path == "/download/2.png":
                self._raw(200, PNG_1X1, "image/png")
            else:
                self._json(404, {"error": {"message": "图片不存在"}})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)
        try:
            request_body = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            request_body = {}
        if self.path == "/v1/images/generations":
            behavior = self.behavior
            behavior.generation_calls += 1
            request_id = self.headers.get("X-Oneapi-Request-Id")
            if request_id is not None:
                behavior.generation_request_ids.append(request_id)
            if behavior.generation_status >= 400:
                self._json(behavior.generation_status, {"error": {"message": "网关繁忙，请稍后重试"}})
                return
            import time

            time.sleep(behavior.generation_sleep)
            body = self._generation_body(behavior, request_body)
            self._json(200, body)
        elif self.path == "/v1/images/edits":
            if self.behavior.generation_status >= 400:
                self._json(self.behavior.generation_status, {"error": {"message": "网关繁忙，请稍后重试"}})
                return
            fixture = json.loads((FIXTURES / "edit-success.json").read_text(encoding="utf-8"))
            response_body = fixture["response"]["body"]
            response_body["data"][0]["url"] = f"{self._base()}/download/1.png"
            response_body["data"][0]["b64_json"] = BASE64_PNG_1X1
            self._json(200, response_body)
        elif self.path == "/v1/models":
            self._json(200, {"data": [], "success": True})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def _generation_body(self, behavior: GatewayBehavior, request_body: dict) -> dict:
        fixture = json.loads(
            (FIXTURES / "text-parameters-result.json").read_text(encoding="utf-8")
        )
        body = fixture["response"]["body"]
        requested = request_body.get("n", 1)
        output_count = 1 if (behavior.return_partial or requested <= 1) else 2
        body["data"] = [
            {
                "url": f"{self._base()}/download/1.png",
                "b64_json": BASE64_PNG_1X1,
                "revised_prompt": "",
            }
        ]
        body["metadata"]["output"]["choices"][0]["message"]["content"] = [
            {"image": BASE64_PNG_1X1} for _ in range(output_count)
        ]
        body["metadata"]["usage"]["output_image_count"] = output_count
        return body

    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Oneapi-Request-Id", f"e2e-{status}")
        self.end_headers()
        self.wfile.write(payload)

    def _raw(self, status: int, payload: bytes, media_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class TeamGatewayEndToEndTests(unittest.TestCase):
    def setUp(self) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingGatewayHandler)
        self._gateway_thread = threading.Thread(target=self._server.serve_forever)
        self._gateway_thread.daemon = True
        self._gateway_thread.start()
        self._behavior = RecordingGatewayHandler.behavior
        self._behavior.reset()
        self._base_url = f"http://127.0.0.1:{self._server.server_port}"

    def tearDown(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._gateway_thread.join(timeout=2)

    def _application(self, directory: str) -> GenerationApplication:
        application = GenerationApplication(
            gateway=TeamGateway(self._base_url, "e2e-key"),
            results=FileResultRepository(Path(directory)),
            capabilities=CapabilityRegistry(),
        )
        self.addCleanup(application.close)
        return application

    def test_text_to_image_full_loop_saves_two_results(self) -> None:
        with TemporaryDirectory() as directory:
            application = self._application(directory)

            task_id = application.submit_text(
                TextToImageDraft(
                    prompt="黄昏下的城堡",
                    model_id="qwen-image-3.0-pro",
                    image_count=2,
                )
            )
            task = application.wait_for(task_id, timeout=5)

            self.assertEqual(GenerationStatus.SUCCEEDED, task.status, task.error)
            self.assertEqual(2, len(task.result_paths))
            for path in task.result_paths:
                self.assertTrue(path.is_file())
                self.assertEqual(PNG_1X1, path.read_bytes())
            record = json.loads(
                (
                    Path(directory)
                    / task.submitted_at.date().isoformat()
                    / task_id
                    / "task.json"
                ).read_text()
            )
            self.assertEqual("qwen-image-3.0-pro", record["model"])
            self.assertEqual(2, len(record["result_files"]))

    def test_image_edit_full_loop_saves_snapshot_and_result(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "reference.png"
            reference.write_bytes(PNG_1X1)
            application = self._application(directory)

            task_id = application.submit_edit(
                ImageEditDraft(
                    prompt="把天空换成星空",
                    model_id="qwen-image-3.0-pro",
                    reference_paths=(reference,),
                )
            )
            task = application.wait_for(task_id, timeout=5)

            self.assertEqual(GenerationStatus.SUCCEEDED, task.status, task.error)
            task_directory = root / task.submitted_at.date().isoformat() / task_id
            snapshot = task_directory / "reference-1.png"
            self.assertTrue(snapshot.is_file())
            self.assertEqual(PNG_1X1, snapshot.read_bytes())
            self.assertEqual(1, len(task.result_paths))
            record = json.loads((task_directory / "task.json").read_text())
            self.assertEqual("image_edit", record["workflow"])
            self.assertEqual(["reference-1.png"], record["reference_files"])

    def test_gateway_rejection_maps_to_failed_with_actionable_message(self) -> None:
        self._behavior.generation_status = 503
        with TemporaryDirectory() as directory:
            application = self._application(directory)
            task_id = application.submit_text(
                TextToImageDraft(prompt="x", model_id="qwen-image-3.0-pro")
            )
            task = application.wait_for(task_id, timeout=5)

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertIn("网关繁忙，请稍后重试", task.error or "")
        self.assertEqual("e2e-503", task.gateway_request_id)

    def test_ambiguous_server_error_maps_to_unknown_without_retry(self) -> None:
        for status in (502, 504):
            with self.subTest(status=status):
                self._behavior.reset()
                self._behavior.generation_status = status
                with TemporaryDirectory() as directory:
                    application = self._application(directory)
                    task_id = application.submit_text(
                        TextToImageDraft(prompt="x", model_id="qwen-image-3.0-pro")
                    )
                    task = application.wait_for(task_id, timeout=5)

                self.assertEqual(GenerationStatus.UNKNOWN, task.status)
                self.assertIn("结果未知", task.error or "")
                self.assertEqual(f"e2e-{status}", task.gateway_request_id)
                self.assertEqual(1, self._behavior.generation_calls)

    def test_rate_limit_maps_to_failed_with_retry_guidance(self) -> None:
        self._behavior.generation_status = 429
        with TemporaryDirectory() as directory:
            application = self._application(directory)
            task_id = application.submit_text(
                TextToImageDraft(prompt="x", model_id="qwen-image-3.0-pro")
            )
            task = application.wait_for(task_id, timeout=5)

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertIn("限流", task.error or "")

    def test_generation_is_not_retried_on_server_error(self) -> None:
        self._behavior.generation_status = 503
        with TemporaryDirectory() as directory:
            application = self._application(directory)
            task_id = application.submit_text(
                TextToImageDraft(prompt="x", model_id="qwen-image-3.0-pro")
            )
            application.wait_for(task_id, timeout=5)

        self.assertEqual(1, self._behavior.generation_calls)

    def test_partial_result_maps_to_partially_succeeded(self) -> None:
        self._behavior.return_partial = True
        with TemporaryDirectory() as directory:
            application = self._application(directory)
            task_id = application.submit_text(
                TextToImageDraft(prompt="x", model_id="qwen-image-3.0-pro", image_count=2)
            )
            task = application.wait_for(task_id, timeout=5)

        self.assertEqual(GenerationStatus.PARTIALLY_SUCCEEDED, task.status)
        self.assertEqual(1, len(task.result_paths))
        self.assertIn("网关返回 1 张", task.error or "")

    def test_download_failure_maps_to_failed_without_losing_result_state(self) -> None:
        self._behavior.download_status = 404
        with TemporaryDirectory() as directory:
            application = self._application(directory)
            task_id = application.submit_text(
                TextToImageDraft(prompt="x", model_id="qwen-image-3.0-pro")
            )
            task = application.wait_for(task_id, timeout=5)

        self.assertEqual(GenerationStatus.FAILED, task.status)
        self.assertIn("结果下载或保存失败", task.error or "")
        self.assertEqual(0, len(task.result_paths))

    def test_connection_interruption_maps_to_unknown(self) -> None:
        # 指向一个没有监听的端口，模拟连接中断。
        import socket

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            dead_port = probe.getsockname()[1]
        gateway = TeamGateway(f"http://127.0.0.1:{dead_port}", "e2e-key")
        with TemporaryDirectory() as directory:
            application = GenerationApplication(
                gateway=gateway,
                results=FileResultRepository(Path(directory)),
            )
            self.addCleanup(application.close)
            task_id = application.submit_text(
                TextToImageDraft(prompt="x", model_id="qwen-image-3.0-pro")
            )
            task = application.wait_for(task_id, timeout=5)

        self.assertEqual(GenerationStatus.UNKNOWN, task.status)
        self.assertIn("连接中断", task.error or "")

    def test_wait_timeout_maps_to_unknown_without_retry(self) -> None:
        self._behavior.generation_sleep = 2.0
        with TemporaryDirectory() as directory:
            application = GenerationApplication(
                gateway=TeamGateway(self._base_url, "e2e-key"),
                results=FileResultRepository(Path(directory)),
                timeout_seconds=0.2,
            )
            self.addCleanup(application.close)
            task_id = application.submit_text(
                TextToImageDraft(prompt="x", model_id="qwen-image-3.0-pro")
            )
            task = application.wait_for(task_id, timeout=5)

        self.assertEqual(GenerationStatus.UNKNOWN, task.status)
        self.assertIn("15 分钟", task.error or "")
        self.assertEqual(1, self._behavior.generation_calls)

    def test_connection_check_maps_all_stages_with_real_gateway(self) -> None:
        from ugc_image_tool.discovery import ConnectionStage, run_connection_check

        checks = run_connection_check(
            TeamGateway(self._base_url, "e2e-key"),
            CapabilityRegistry(),
        )
        by_stage = {check.stage: check for check in checks}
        self.assertTrue(by_stage[ConnectionStage.DNS_OR_CONNECT].ok)
        self.assertTrue(by_stage[ConnectionStage.AUTH].ok)
        self.assertTrue(by_stage[ConnectionStage.MODEL_LIST].ok)
        self.assertTrue(by_stage[ConnectionStage.CAPABILITY].ok)

    def test_https_override_address_passes_connection_and_generation(self) -> None:
        """HTTPS 覆盖地址通过连接与生成验收（自签证书，仅用于测试）。"""
        import os
        import ssl
        import subprocess
        import sys

        with TemporaryDirectory() as directory:
            cert_dir = Path(directory)
            cert = cert_dir / "cert.pem"
            key = cert_dir / "key.pem"
            subprocess.run(
                [
                    "openssl", "req", "-x509", "-newkey", "rsa:2048",
                    "-keyout", str(key), "-out", str(cert),
                    "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1",
                    "-addext", "subjectAltName=IP:127.0.0.1",
                ],
                check=True,
                capture_output=True,
            )
            server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingGatewayHandler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever)
            thread.daemon = True
            thread.start()
            try:
                base_url = f"https://127.0.0.1:{server.server_port}"
                import httpx as httpx_module

                client = httpx_module.Client(verify=False)
                try:
                    gateway = TeamGateway(base_url, "e2e-key", client=client)
                    from ugc_image_tool.discovery import (
                        ConnectionStage,
                        run_connection_check,
                    )

                    checks = run_connection_check(gateway, CapabilityRegistry())
                    by_stage = {check.stage: check for check in checks}
                    self.assertTrue(by_stage[ConnectionStage.DNS_OR_CONNECT].ok)
                    self.assertTrue(by_stage[ConnectionStage.AUTH].ok)
                    self.assertTrue(by_stage[ConnectionStage.MODEL_LIST].ok)
                    self.assertTrue(by_stage[ConnectionStage.CAPABILITY].ok)

                    application = GenerationApplication(
                        gateway=gateway,
                        results=FileResultRepository(
                            Path(directory) / "output",
                            image_fetcher=UrlImageFetcher(verify=False),
                        ),
                    )
                    self.addCleanup(application.close)
                    task_id = application.submit_text(
                        TextToImageDraft(
                            prompt="HTTPS 验收",
                            model_id="qwen-image-3.0-pro",
                        )
                    )
                    task = application.wait_for(task_id, timeout=5)
                    self.assertEqual(GenerationStatus.SUCCEEDED, task.status, task.error)
                    self.assertEqual(1, len(task.result_paths))
                finally:
                    client.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()