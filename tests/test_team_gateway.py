from __future__ import annotations

import base64
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import urlparse

import httpx

from ugc_image_tool.capabilities import CAPABILITY_TABLE_VERSION, CapabilityRegistry
from ugc_image_tool.discovery import GatewayError, GatewayErrorCategory
from ugc_image_tool.generation import (
    ImageEditRequest,
    SizeMode,
    SizeSpec,
    TextToImageRequest,
)
from ugc_image_tool.references import ReferenceImage
from ugc_image_tool.team_gateway import TeamGateway

FIXTURES = (
    Path(__file__).resolve().parents[1]
    / "contracts"
    / "fixtures"
    / "2026-08-17-team-gateway"
)

EDIT_JSON_FIXTURES = FIXTURES.parent / "2026-08-29-team-gateway-edit-json"

PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
)


def load_fixture(name: str, fixtures: Path = FIXTURES) -> dict:
    return json.loads((fixtures / name).read_text(encoding="utf-8"))


BASE64_PNG_1X1 = base64.b64encode(PNG_1X1).decode()


def _substitute_redacted(value: Any) -> Any:
    """把夹具中的脱敏图片占位替换为真实 PNG 内容，便于解析断言。"""
    if isinstance(value, dict):
        return {key: _substitute_redacted(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_substitute_redacted(child) for child in value]
    if value == "[REDACTED_IMAGE]":
        return BASE64_PNG_1X1
    return value


def replay(fixture_name: str, fixtures: Path = FIXTURES):
    """Build a client that replays one recorded exchange and captures the request."""
    fixture = _substitute_redacted(load_fixture(fixture_name, fixtures))
    captured: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        response = fixture["response"]
        return httpx.Response(
            status_code=response["status"],
            headers={
                name: str(value)
                for name, value in response.get("headers", {}).items()
                if name.lower() not in {"content-length"}
            },
            json=response["body"],
            request=request,
        )

    return httpx.Client(transport=httpx.MockTransport(handler)), captured


def text_request(**overrides) -> TextToImageRequest:
    fields: dict = {
        "prompt": "一只在草地上的蓝色小鸟",
        "model_id": "qwen-image-3.0-pro",
        "capability_version": CAPABILITY_TABLE_VERSION,
    }
    fields.update(overrides)
    return TextToImageRequest(**fields)


def make_gateway(client: httpx.Client, base_url: str = "http://gateway.test") -> TeamGateway:
    return TeamGateway(base_url, "test-key", client=client)


class TeamGatewayModelListTests(unittest.TestCase):
    def test_model_list_uses_verified_path_and_auth(self) -> None:
        client, captured = replay("models-success.json")
        with client:
            gateway = make_gateway(client)

            model_ids = gateway.list_models()

        request = captured["request"]
        self.assertEqual("GET", request.method)
        self.assertEqual("/v1/models", request.url.path)
        self.assertEqual("Bearer test-key", request.headers["Authorization"])
        self.assertEqual("application/json", request.headers["Accept"])
        self.assertIn("qwen-image-3.0-pro", model_ids)
        self.assertIn("wan2.7-image", model_ids)
        self.assertNotIn("", model_ids)

    def test_model_list_auth_error_maps_to_auth_category(self) -> None:
        client, _ = replay("models-auth-error.json")
        with client:
            gateway = make_gateway(client)
            with self.assertRaises(GatewayError) as raised:
                gateway.list_models()

        self.assertEqual(GatewayErrorCategory.AUTH, raised.exception.category)
        self.assertEqual(401, raised.exception.status_code)
        self.assertIn("Invalid token", str(raised.exception))

    def test_https_base_url_builds_https_requests(self) -> None:
        fixture = load_fixture("models-success.json")
        captured: dict[str, httpx.Request] = {}

        def https_handler(request: httpx.Request) -> httpx.Response:
            captured["request"] = request
            return httpx.Response(
                status_code=200,
                json=fixture["response"]["body"],
                request=request,
            )

        with httpx.Client(transport=httpx.MockTransport(https_handler)) as client:
            gateway = TeamGateway("https://gateway.example", "test-key", client=client)
            model_ids = gateway.list_models()

        base = urlparse(gateway.base_url)
        self.assertEqual("https", base.scheme)
        self.assertEqual("/v1/models", captured["request"].url.path)
        self.assertEqual("https", captured["request"].url.scheme)
        self.assertIn("qwen-image-3.0-pro", model_ids)


class TeamGatewayTextGenerationTests(unittest.TestCase):
    def test_text_generation_payload_matches_recorded_exchange(self) -> None:
        client, captured = replay("text-parameters-result.json")
        request = text_request(
            negative_prompt="模糊，低清晰度",
            size=SizeSpec(SizeMode.PRESET, 1024, 1024),
            image_count=2,
            params=(("watermark", False),),
        )
        with client:
            gateway = make_gateway(client)

            result = gateway.generate_text(request)

        sent = json.loads(captured["request"].content)
        self.assertEqual("POST", captured["request"].method)
        self.assertEqual("/v1/images/generations", captured["request"].url.path)
        self.assertEqual("Bearer test-key", captured["request"].headers["Authorization"])
        self.assertEqual("qwen-image-3.0-pro", sent["model"])
        self.assertEqual(request.prompt, sent["prompt"])
        self.assertEqual("模糊，低清晰度", sent["negative_prompt"])
        self.assertEqual(2, sent["n"])
        self.assertEqual("1024x1024", sent["size"])
        self.assertFalse(sent["watermark"])

        self.assertEqual(2, len(result.images))
        self.assertIsNotNone(result.images[0].url)
        self.assertEqual(PNG_1X1, result.images[0].content)
        self.assertIsNone(result.images[1].url)
        self.assertEqual(PNG_1X1, result.images[1].content)
        self.assertEqual(
            "202608171402373097571008268d9d6Lzi57b4w", result.request_id
        )

    def test_text_generation_minimal_body_has_only_model_and_prompt(self) -> None:
        client, captured = replay("text-success.json")
        with client:
            gateway = make_gateway(client)
            result = gateway.generate_text(text_request())

        sent = json.loads(captured["request"].content)
        self.assertEqual({"model": "qwen-image-3.0-pro", "prompt": "一只在草地上的蓝色小鸟"}, sent)
        self.assertEqual(1, len(result.images))
        self.assertIsNotNone(result.images[0].url)
        self.assertEqual(PNG_1X1, result.images[0].content)
        self.assertEqual(
            "202608171356597727104008268d9d6LqjrqK4O", result.request_id
        )

    def test_text_generation_server_error_maps_to_server_category(self) -> None:
        client, _ = replay("text-empty.json")
        with client:
            gateway = make_gateway(client)
            with self.assertRaises(GatewayError) as raised:
                gateway.generate_text(text_request())

        self.assertEqual(GatewayErrorCategory.SERVER, raised.exception.category)
        self.assertEqual(503, raised.exception.status_code)
        self.assertIn("无可用渠道", str(raised.exception))

    def test_text_generation_is_not_retried_on_failure(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.method)
            return httpx.Response(
                status_code=503,
                json={"error": {"message": "busy", "type": "new_api_error"}},
                request=request,
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            gateway = make_gateway(client)
            with self.assertRaises(GatewayError):
                gateway.generate_text(text_request())

        self.assertEqual(1, len(calls), "生成请求不得自动重发")

    def test_network_failure_maps_to_network_category(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("连接失败")

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            gateway = make_gateway(client)
            with self.assertRaises(GatewayError) as raised:
                gateway.generate_text(text_request())

        self.assertEqual(GatewayErrorCategory.NETWORK, raised.exception.category)

    def test_rate_limit_maps_to_rate_limit_category(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status_code=429,
                json={"error": {"message": "rate limited", "type": "new_api_error"}},
                request=request,
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            gateway = make_gateway(client)
            with self.assertRaises(GatewayError) as raised:
                gateway.generate_text(text_request())

        self.assertEqual(GatewayErrorCategory.RATE_LIMIT, raised.exception.category)
        self.assertEqual(429, raised.exception.status_code)

    def test_missing_api_key_is_an_actionable_config_error(self) -> None:
        client, _ = replay("text-success.json")
        with client:
            gateway = TeamGateway("http://gateway.test", "", client=client)
            with self.assertRaises(GatewayError) as raised:
                gateway.generate_text(text_request())

        self.assertEqual(GatewayErrorCategory.CONFIG, raised.exception.category)
        self.assertIn("API 密钥", str(raised.exception))

    def test_data_view_mismatch_still_saves_actual_metadata_images(self) -> None:
        """data 1 条但 metadata 输出 2 张：按实际输出保存，并保留 data 的下载地址。"""
        fixture = _substitute_redacted(load_fixture("text-parameters-result.json"))

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status_code=200,
                json=fixture["response"]["body"],
                request=request,
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            gateway = make_gateway(client)
            result = gateway.generate_text(
                text_request(size=SizeSpec(SizeMode.PRESET, 1024, 1024), image_count=2)
            )

        self.assertEqual(2, len(result.images))
        self.assertIsNotNone(result.images[0].url, "第一张应保留 data 的临时下载地址")
        self.assertIsNone(result.images[1].url, "第二张只有 metadata 图片内容")
        self.assertEqual(PNG_1X1, result.images[0].content)
        self.assertEqual(PNG_1X1, result.images[1].content)


class TeamGatewayImageEditTests(unittest.TestCase):
    def reference(self, name: str = "reference-1.png") -> ReferenceImage:
        return ReferenceImage(
            path=Path(name),
            media_type="image/png",
            width=1,
            height=1,
            size_bytes=len(PNG_1X1),
            content=PNG_1X1,
        )

    def second_reference(self) -> ReferenceImage:
        return ReferenceImage(
            path=Path("reference-2.jpg"),
            media_type="image/jpeg",
            width=1,
            height=1,
            size_bytes=3,
            content=b"\xff\xd8\xff",
        )

    def edit_request(self, **overrides) -> ImageEditRequest:
        fields: dict = {
            "prompt": "保留构图，把背景换成黄昏",
            "model_id": "qwen-image-3.0-pro",
            "capability_version": CAPABILITY_TABLE_VERSION,
            "references": (self.reference(),),
        }
        fields.update(overrides)
        return ImageEditRequest(**fields)

    def test_image_edit_encodes_reference_as_data_url_in_json(self) -> None:
        client, captured = replay("edit-json-single.json", EDIT_JSON_FIXTURES)
        with client:
            gateway = make_gateway(client)
            result = gateway.generate_image_edit(self.edit_request())

        request = captured["request"]
        self.assertEqual("POST", request.method)
        self.assertEqual("/v1/images/edits", request.url.path)
        self.assertEqual("application/json", request.headers["Content-Type"])
        sent = json.loads(request.content)
        self.assertEqual(
            {
                "model": "qwen-image-3.0-pro",
                "prompt": "保留构图，把背景换成黄昏",
                "input": {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "image": "data:image/png;base64," + BASE64_PNG_1X1
                                },
                                {"text": "保留构图，把背景换成黄昏"},
                            ],
                        }
                    ]
                },
            },
            sent,
        )

        self.assertEqual(1, len(result.images))
        self.assertEqual("https://example.invalid/redacted", result.images[0].url)
        self.assertEqual(
            "202608291322151070832008268d9d6NBC7O2lo", result.request_id
        )

    def test_image_edit_sends_star_size_count_and_multiple_references(self) -> None:
        """多参考图按顺序进 input.messages；尺寸用星号格式，n 走 parameters。"""
        client, captured = replay("edit-json-multi.json", EDIT_JSON_FIXTURES)
        request_model = self.edit_request(
            references=(self.reference(), self.second_reference()),
            size=SizeSpec(SizeMode.PRESET, 1024, 1024),
            image_count=2,
        )
        with client:
            gateway = make_gateway(client)
            result = gateway.generate_image_edit(request_model)

        sent = json.loads(captured["request"].content)
        self.assertEqual({"size": "1024*1024", "n": 2}, sent["parameters"])
        content = sent["input"]["messages"][0]["content"]
        self.assertEqual(
            [
                {"image": "data:image/png;base64," + BASE64_PNG_1X1},
                {"image": "data:image/jpeg;base64,/9j/"},
                {"text": request_model.prompt},
            ],
            content,
        )
        self.assertEqual(request_model.prompt, sent["prompt"])

        # n=2 时顶层 data 仅 1 条（上游已知行为）；出图真源是 metadata.output.choices。
        self.assertEqual(2, len(result.images))
        self.assertEqual("https://example.invalid/redacted", result.images[0].url)
        self.assertEqual(
            "https://example.invalid/redacted-output-2", result.images[1].url
        )
        self.assertEqual(
            "202608291323321438918008268d9d6RJdYHZ4p", result.request_id
        )

    def test_image_edit_minimal_body_omits_parameters(self) -> None:
        """自动尺寸、单张出图时不发送 parameters（与文生图的最小载荷习惯一致）。"""
        client, captured = replay("edit-json-single.json", EDIT_JSON_FIXTURES)
        with client:
            gateway = make_gateway(client)
            gateway.generate_image_edit(self.edit_request())

        sent = json.loads(captured["request"].content)
        self.assertNotIn("parameters", sent)
        self.assertNotIn("size", sent)
        self.assertNotIn("n", sent)

    def test_image_edit_merges_negative_prompt_into_prompt_text(self) -> None:
        """input.negative_prompt 未实测；负向提示词并入主提示词文本发送。"""
        client, captured = replay("edit-json-single.json", EDIT_JSON_FIXTURES)
        with client:
            gateway = make_gateway(client)
            gateway.generate_image_edit(
                self.edit_request(negative_prompt="模糊，低清晰度")
            )

        sent = json.loads(captured["request"].content)
        merged = "保留构图，把背景换成黄昏\n避免出现：模糊，低清晰度"
        self.assertEqual(merged, sent["prompt"])
        self.assertEqual(merged, sent["input"]["messages"][0]["content"][-1]["text"])
        self.assertNotIn("negative_prompt", sent)
        self.assertNotIn("negative_prompt", sent["input"])

    def test_image_edit_rejects_more_than_three_references(self) -> None:
        client, captured = replay("edit-json-single.json", EDIT_JSON_FIXTURES)
        references = (
            self.reference(),
            self.second_reference(),
            self.reference("reference-3.png"),
            self.reference("reference-4.png"),
        )
        with client:
            gateway = make_gateway(client)
            with self.assertRaises(GatewayError) as raised:
                gateway.generate_image_edit(self.edit_request(references=references))

        self.assertEqual(GatewayErrorCategory.REJECTED, raised.exception.category)
        self.assertIn("参考图", str(raised.exception))
        self.assertNotIn("request", captured, "不应发出超出能力表的请求")

    def test_image_edit_rejects_unverified_image_count(self) -> None:
        client, captured = replay("edit-json-single.json", EDIT_JSON_FIXTURES)
        with client:
            gateway = make_gateway(client)
            with self.assertRaises(GatewayError) as raised:
                gateway.generate_image_edit(self.edit_request(image_count=6))

        self.assertEqual(GatewayErrorCategory.REJECTED, raised.exception.category)
        self.assertIn("出图数量", str(raised.exception))
        self.assertNotIn("request", captured)

    def test_image_edit_rejects_model_without_edit_capability(self) -> None:
        client, captured = replay("edit-json-single.json", EDIT_JSON_FIXTURES)
        with client:
            gateway = make_gateway(client)
            with self.assertRaises(GatewayError) as raised:
                gateway.generate_image_edit(self.edit_request(model_id="unknown-model"))

        self.assertEqual(GatewayErrorCategory.REJECTED, raised.exception.category)
        self.assertIn("图片编辑", str(raised.exception))
        self.assertNotIn("request", captured)

    def test_image_edit_invalid_request_maps_to_rejected_category(self) -> None:
        client, _ = replay("edit-empty.json")
        with client:
            gateway = make_gateway(client)
            with self.assertRaises(GatewayError) as raised:
                gateway.generate_image_edit(self.edit_request())

        self.assertEqual(GatewayErrorCategory.REJECTED, raised.exception.category)
        self.assertEqual(400, raised.exception.status_code)
        self.assertIn("未指定模型名称", str(raised.exception))

    def test_image_edit_validation_follows_capability_table(self) -> None:
        """能力表 override 收紧参考图上限后，适配器在边界拒绝多参考图。"""
        override = {
            "schema_version": 2,
            "models": [
                {
                    "model_id": "qwen-image-3.0-pro",
                    "display_name": "Qwen Image 3.0",
                    "workflows": [
                        {
                            "workflow": "image_edit",
                            "supports_negative_prompt": False,
                            "min_images": 1,
                            "max_images": 1,
                            "size": {
                                "auto_allowed": True,
                                "presets": [],
                                "custom_size_allowed": False,
                            },
                            "reference_limits": {"min_references": 1, "max_references": 1},
                        }
                    ],
                }
            ],
        }
        client, captured = replay("edit-json-single.json", EDIT_JSON_FIXTURES)
        with TemporaryDirectory() as directory:
            path = Path(directory) / "override.json"
            path.write_text(json.dumps(override, ensure_ascii=False), encoding="utf-8")
            registry = CapabilityRegistry(path)
            with client:
                gateway = TeamGateway(
                    "http://gateway.test", "test-key", client=client, capabilities=registry
                )
                with self.assertRaises(GatewayError) as raised:
                    gateway.generate_image_edit(
                        self.edit_request(
                            references=(self.reference(), self.second_reference())
                        )
                    )

        self.assertEqual(GatewayErrorCategory.REJECTED, raised.exception.category)
        self.assertIn("参考图", str(raised.exception))
        self.assertNotIn("request", captured, "override 收紧后不应发出多参考图请求")


if __name__ == "__main__":
    unittest.main()