from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import cast


class ContractCliTests(unittest.TestCase):
    def test_missing_fixture_set_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "ugc_image_tool.contracts.cli",
                    "validate",
                    directory,
                ],
                check=False,
                capture_output=True,
                text=True,
                env={"PYTHONPATH": "src"},
            )

        self.assertEqual(1, result.returncode)
        self.assertIn("manifest.json", result.stderr)

    def test_complete_fixture_manifest_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture_directory = Path(directory)
            manifest = {
                "schema_version": 1,
                "verified_at": "2026-08-17T12:00:00Z",
                "interfaces": {
                    name: {
                        "path": path,
                        "method": method,
                        "exchanges": [
                            {
                                "request": {
                                    "method": method,
                                    "path": path,
                                    "headers": {"Authorization": "[REDACTED]"},
                                    "body": None,
                                },
                                "response": {"status": 200, "body": {}},
                            }
                        ],
                    }
                    for name, path, method in (
                        ("models", "/v1/models", "GET"),
                        ("text_to_image", "/v1/images/generations", "POST"),
                        ("image_edit", "/v1/images/edits", "POST"),
                    )
                },
                "behaviors": {
                    name: {"status": "unsupported", "evidence": "实测未提供该能力"}
                    for name in (
                        "partial_failure",
                        "idempotency_key",
                        "running_cancellation",
                        "task_query",
                        "retry_after",
                    )
                },
                "error_mappings": {
                    name: {"status": status, "evidence": "脱敏实测样例"}
                    for name, status in (
                        ("authentication", 401),
                        ("invalid_request", 400),
                        ("rate_limit", 429),
                        ("server_error", 500),
                    )
                },
                "verified_models": ["verified-model"],
                "unsafe_to_enable": ["未实测模型"],
            }
            interfaces = cast(dict[str, object], manifest["interfaces"])
            image_edit = cast(dict[str, object], interfaces["image_edit"])
            image_edit["request_shape"] = {
                "encoding": "multipart/form-data",
                "fields": [{"name": "image", "kind": "file"}],
            }
            (fixture_directory / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
            )

            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "ugc_image_tool.contracts.cli",
                    "validate",
                    directory,
                ],
                check=False,
                capture_output=True,
                text=True,
                env={"PYTHONPATH": "src"},
            )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("契约夹具有效", result.stdout)

    def test_edit_json_partial_fixture_manifest_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture_directory = Path(directory)
            exchange = {
                "request": {
                    "method": "POST",
                    "path": "/v1/images/edits",
                    "headers": {
                        "Authorization": "[REDACTED]",
                        "Content-Type": "application/json",
                    },
                    "body": {
                        "model": "verified-model",
                        "prompt": "[REDACTED_PROMPT]",
                        "input": {
                            "messages": [
                                {
                                    "role": "user",
                                    "content": [
                                        {"image": "data:image/png;base64,[REDACTED_IMAGE]"},
                                        {"text": "[REDACTED_PROMPT]"},
                                    ],
                                }
                            ]
                        },
                    },
                },
                "response": {
                    "status": 200,
                    "body": {
                        "data": [{"url": "https://example.invalid/redacted", "b64_json": ""}],
                        "metadata": {
                            "output": {
                                "choices": [
                                    {"message": {"content": [{"image": "https://example.invalid/redacted"}]}}
                                ]
                            }
                        },
                    },
                },
            }
            (fixture_directory / "edit-json-single.json").write_text(
                json.dumps(exchange, ensure_ascii=False), encoding="utf-8"
            )
            manifest = {
                "schema_version": 1,
                "verified_at": "2026-08-29T12:00:00Z",
                "interfaces": {
                    "image_edit": {
                        "path": "/v1/images/edits",
                        "method": "POST",
                        "exchanges": [
                            {"evidence": "edit-json-single.json", "summary": "单参考图 JSON 编辑"}
                        ],
                        "request_shape": {
                            "encoding": "application/json",
                            "input": {
                                "messages": "content 按顺序放多个 image 项（data-URL）+ 末尾 text 项"
                            },
                        },
                    }
                },
                "behaviors": {
                    "partial_failure": {"status": "confirmed", "evidence": "edit-json-single.json"}
                },
                "verified_models": ["verified-model"],
                "untested": ["其余模型的图片编辑"],
            }
            (fixture_directory / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
            )

            result = subprocess.run(
                [sys.executable, "-m", "ugc_image_tool.contracts.cli", "validate", directory],
                check=False, capture_output=True, text=True, env={"PYTHONPATH": "src"},
            )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("契约夹具有效", result.stdout)

    def test_recorded_edit_json_fixture_is_valid(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "ugc_image_tool.contracts.cli",
                "validate",
                "contracts/fixtures/2026-08-29-team-gateway-edit-json",
            ],
            check=False,
            capture_output=True,
            text=True,
            env={"PYTHONPATH": "src"},
        )

        self.assertEqual(0, result.returncode, result.stderr)

    def test_partially_redacted_values_are_rejected(self) -> None:
        cases = (
            ("sk-live[REDACTED]", "脱敏标记必须结构完整，不能仅作子串出现"),
            ("https://real-cdn.example.com/x?u=example.invalid", "example.invalid 必须是 URL 的 host"),
        )
        for value, summary in cases:
            with self.subTest(value=value):
                with tempfile.TemporaryDirectory() as directory:
                    fixture_directory = Path(directory)
                    exchange = {
                        "request": {
                            "method": "POST",
                            "path": "/v1/images/edits",
                            "headers": {"Authorization": "[REDACTED]"},
                            "body": {"prompt": value},
                        },
                        "response": {"status": 200, "body": {}},
                    }
                    (fixture_directory / "edit.json").write_text(
                        json.dumps(exchange, ensure_ascii=False), encoding="utf-8"
                    )
                    manifest = {
                        "schema_version": 1,
                        "verified_at": "2026-08-29T12:00:00Z",
                        "interfaces": {
                            "image_edit": {
                                "path": "/v1/images/edits",
                                "method": "POST",
                                "exchanges": [{"evidence": "edit.json", "summary": summary}],
                                "request_shape": {
                                    "encoding": "application/json",
                                    "input": {"messages": "image 项（data-URL）"},
                                },
                            }
                        },
                        "behaviors": {},
                        "verified_models": ["verified-model"],
                    }
                    (fixture_directory / "manifest.json").write_text(
                        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
                    )

                    result = subprocess.run(
                        [sys.executable, "-m", "ugc_image_tool.contracts.cli", "validate", directory],
                        check=False, capture_output=True, text=True, env={"PYTHONPATH": "src"},
                    )

                self.assertEqual(1, result.returncode, summary)
                self.assertIn("脱敏", result.stderr)

    def test_exchange_evidence_outside_fixture_directory_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture_directory = Path(directory)
            manifest = {
                "schema_version": 1,
                "verified_at": "2026-08-29T12:00:00Z",
                "interfaces": {
                    "image_edit": {
                        "path": "/v1/images/edits",
                        "method": "POST",
                        "exchanges": [{"evidence": "../outside.json"}],
                        "request_shape": {
                            "encoding": "application/json",
                            "input": {"messages": "image 项（data-URL）"},
                        },
                    }
                },
                "behaviors": {},
                "verified_models": ["verified-model"],
            }
            (fixture_directory / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
            )

            result = subprocess.run(
                [sys.executable, "-m", "ugc_image_tool.contracts.cli", "validate", directory],
                check=False, capture_output=True, text=True, env={"PYTHONPATH": "src"},
            )

        self.assertEqual(1, result.returncode)
        self.assertIn("越界", result.stderr)

    def test_sensitive_evidence_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture_directory = Path(directory)
            exchange = {
                "request": {
                    "method": "POST",
                    "path": "/v1/images/edits",
                    "headers": {"Authorization": "[REDACTED]"},
                    "body": {"prompt": "一只真实的猫"},
                },
                "response": {"status": 200, "body": {}},
            }
            (fixture_directory / "edit.json").write_text(
                json.dumps(exchange, ensure_ascii=False), encoding="utf-8"
            )
            manifest = {
                "schema_version": 1,
                "verified_at": "2026-08-29T12:00:00Z",
                "interfaces": {
                    "image_edit": {
                        "path": "/v1/images/edits",
                        "method": "POST",
                        "exchanges": [{"evidence": "edit.json"}],
                        "request_shape": {
                            "encoding": "application/json",
                            "input": {"messages": "image 项（data-URL）"},
                        },
                    }
                },
                "behaviors": {},
                "verified_models": ["verified-model"],
            }
            (fixture_directory / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
            )

            result = subprocess.run(
                [sys.executable, "-m", "ugc_image_tool.contracts.cli", "validate", directory],
                check=False, capture_output=True, text=True, env={"PYTHONPATH": "src"},
            )

        self.assertEqual(1, result.returncode)
        self.assertIn("脱敏", result.stderr)

    def test_record_requires_a_gateway_key(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "ugc_image_tool.contracts.cli",
                "record",
                "--base-url",
                "http://127.0.0.1:9",
                "--interface",
                "models",
                "--path",
                "/v1/models",
                "--output",
                "unused.json",
            ],
            check=False,
            capture_output=True,
            text=True,
            env={"PYTHONPATH": "src"},
        )

        self.assertEqual(2, result.returncode)
        self.assertIn("UGC_IMAGE_TOOL_GATEWAY_API_KEY", result.stderr)

    def test_record_reports_network_failure_without_creating_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            key_file = Path(directory) / "key"
            key_file.write_text("temporary-secret", encoding="utf-8")
            key_file.chmod(0o600)
            output = Path(directory) / "exchange.json"
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "ugc_image_tool.contracts.cli",
                    "record",
                    "--base-url",
                    "http://127.0.0.1:9",
                    "--interface",
                    "models",
                    "--path",
                    "/v1/models",
                    "--key-file",
                    str(key_file),
                    "--timeout",
                    "0.1",
                    "--output",
                    str(output),
                ],
                check=False,
                capture_output=True,
                text=True,
                env={"PYTHONPATH": "src"},
            )

            self.assertFalse(output.exists())
        self.assertEqual(3, result.returncode)
        self.assertIn("网络", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    @unittest.skipUnless(os.name != "nt", "POSIX 文件权限位在 Windows 上不可验证")
    def test_insecure_key_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            key_file = Path(directory) / "key"
            key_file.write_text("temporary-secret", encoding="utf-8")
            key_file.chmod(0o644)
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "ugc_image_tool.contracts.cli",
                    "record",
                    "--base-url",
                    "http://127.0.0.1:9",
                    "--interface",
                    "models",
                    "--path",
                    "/v1/models",
                    "--key-file",
                    str(key_file),
                    "--output",
                    str(Path(directory) / "exchange.json"),
                ],
                check=False,
                capture_output=True,
                text=True,
                env={"PYTHONPATH": "src"},
            )

        self.assertEqual(2, result.returncode)
        self.assertIn("权限", result.stderr)

    def test_sensitive_exchange_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture_directory = Path(directory)
            interface_data = {
                "path": "/v1/models",
                "method": "GET",
                "exchanges": [
                    {
                        "request": {"headers": {"Authorization": "Bearer live-secret"}},
                        "response": {"status": 200, "body": {"url": "https://cdn.example.com/live.png", "b64_json": "raw-image"}},
                    }
                ],
            }
            manifest = {
                "schema_version": 1,
                "interfaces": {
                    "models": interface_data,
                    "text_to_image": {**interface_data, "path": "/v1/images/generations", "method": "POST"},
                    "image_edit": {**interface_data, "path": "/v1/images/edits", "method": "POST"},
                },
                "behaviors": {
                    name: {"status": "unknown", "evidence": "未完成探测"} for name in (
                        "partial_failure", "idempotency_key", "running_cancellation", "task_query", "retry_after"
                    )
                },
                "error_mappings": {name: {} for name in ("authentication", "invalid_request", "rate_limit", "server_error")},
                "verified_models": ["model"],
                "unsafe_to_enable": ["unknown"],
            }
            (fixture_directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-m", "ugc_image_tool.contracts.cli", "validate", directory],
                check=False, capture_output=True, text=True, env={"PYTHONPATH": "src"},
            )

        self.assertEqual(1, result.returncode)
        self.assertIn("脱敏", result.stderr)
        self.assertIn("URL", result.stderr)


if __name__ == "__main__":
    unittest.main()
