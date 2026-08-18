from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import httpx

from ugc_image_tool.capabilities import CapabilityRegistry
from ugc_image_tool.discovery import (
    ConnectionStage,
    GatewayError,
    GatewayErrorCategory,
    ModelCache,
    ModelDiscovery,
    category_for_status,
    classify_exception,
    run_connection_check,
)

KNOWN_MODELS = ("qwen-image-3.0-pro", "wan2.7-image", "z-image-turbo")


class ScriptedProvider:
    """每次调用按脚本依次出牌：抛异常或返回模型列表；异常耗尽后持续抛出该异常。"""

    def __init__(self, *outcomes) -> None:
        self.outcomes: list[object] = list(outcomes)
        self.attempts = 0
        self._last_outcome: object | None = None

    def list_models(self):
        self.attempts += 1
        if self.outcomes:
            outcome = self.outcomes.pop(0)
        elif isinstance(self._last_outcome, Exception):
            outcome = self._last_outcome
        else:
            return ()
        self._last_outcome = outcome
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def refresh_state(provider, user_data_dir: Path, **kwargs) -> ModelDiscovery:
    return ModelDiscovery(
        provider,
        cache=ModelCache(user_data_dir),
        retry_delay=0.0,
        **kwargs,
    )


class ModelDiscoveryRefreshTests(unittest.TestCase):
    def test_success_updates_cache_and_returns_online_state(self) -> None:
        with TemporaryDirectory() as directory:
            provider = ScriptedProvider(KNOWN_MODELS)
            discovery = refresh_state(provider, Path(directory))

            state = discovery.refresh()

            self.assertTrue(state.online)
            self.assertFalse(state.stale)
            self.assertFalse(state.from_cache)
            self.assertEqual(KNOWN_MODELS, state.model_ids)
            self.assertIsNotNone(state.fetched_at)
            self.assertIsNone(state.error)
            self.assertIsNone(discovery.submission_block_reason())
            self.assertEqual(1, provider.attempts)
            cached = ModelCache(Path(directory)).load()
            assert cached is not None
            self.assertEqual(KNOWN_MODELS, cached.model_ids)

    def test_failure_with_cache_marks_models_stale_and_offline(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = refresh_state(ScriptedProvider(KNOWN_MODELS), root)
            first.refresh()

            failing = ScriptedProvider(GatewayError(GatewayErrorCategory.NETWORK, "网络中断"))
            discovery = refresh_state(failing, root, max_retries=1)
            state = discovery.refresh()

            self.assertFalse(state.online)
            self.assertTrue(state.stale)
            self.assertTrue(state.from_cache)
            self.assertEqual(KNOWN_MODELS, state.model_ids)
            self.assertIsNotNone(state.fetched_at)
            self.assertIn("网络中断", state.error or "")
            self.assertEqual(1, failing.attempts)
            reason = discovery.submission_block_reason()
            self.assertIsNotNone(reason)
            self.assertIn("离线", reason or "")

    def test_failure_without_cache_is_offline_without_models(self) -> None:
        with TemporaryDirectory() as directory:
            provider = ScriptedProvider(GatewayError(GatewayErrorCategory.AUTH, "密钥无效"))
            discovery = refresh_state(provider, Path(directory))

            state = discovery.refresh()

            self.assertFalse(state.online)
            self.assertFalse(state.stale)
            self.assertFalse(state.from_cache)
            self.assertEqual((), state.model_ids)
            self.assertIsNone(state.fetched_at)
            self.assertIn("密钥无效", state.error or "")
            self.assertIsNotNone(discovery.submission_block_reason())

    def test_transient_errors_are_retried_before_success(self) -> None:
        with TemporaryDirectory() as directory:
            transient = GatewayError(GatewayErrorCategory.NETWORK, "暂时不可达")
            provider = ScriptedProvider(transient, transient, KNOWN_MODELS)
            discovery = refresh_state(provider, Path(directory), max_retries=3)

            state = discovery.refresh()

            self.assertTrue(state.online)
            self.assertEqual(3, provider.attempts)

    def test_auth_errors_are_not_retried(self) -> None:
        with TemporaryDirectory() as directory:
            provider = ScriptedProvider(GatewayError(GatewayErrorCategory.AUTH, "无效令牌"))
            discovery = refresh_state(provider, Path(directory), max_retries=5)

            state = discovery.refresh()

            self.assertFalse(state.online)
            self.assertEqual(1, provider.attempts)
            self.assertIn("无效令牌", state.error or "")

    def test_server_errors_are_retried_then_stop_after_max_retries(self) -> None:
        with TemporaryDirectory() as directory:
            server_error = GatewayError(GatewayErrorCategory.SERVER, "网关繁忙")
            provider = ScriptedProvider(server_error, server_error, server_error)
            discovery = refresh_state(provider, Path(directory), max_retries=2)

            state = discovery.refresh()

            self.assertFalse(state.online)
            self.assertEqual(2, provider.attempts)
            self.assertIn("网关繁忙", state.error or "")

    def test_plain_httpx_transport_error_is_classified_as_network(self) -> None:
        with TemporaryDirectory() as directory:
            provider = ScriptedProvider(httpx.ConnectError("连不上"))
            discovery = refresh_state(provider, Path(directory), max_retries=3)

            state = discovery.refresh()

            self.assertFalse(state.online)
            self.assertEqual(3, provider.attempts)
            self.assertIsNotNone(state.error)

    def test_pending_state_blocks_submission_until_first_refresh(self) -> None:
        with TemporaryDirectory() as directory:
            discovery = refresh_state(ScriptedProvider(KNOWN_MODELS), Path(directory))

            self.assertFalse(discovery.state.online)
            self.assertIsNotNone(discovery.submission_block_reason())
            self.assertTrue(discovery.state.pending)


class ModelCacheTests(unittest.TestCase):
    def test_load_round_trips_saved_models(self) -> None:
        with TemporaryDirectory() as directory:
            cache = ModelCache(Path(directory))
            fetched_at = datetime(2026, 8, 18, 12, 0, tzinfo=UTC)
            cache.save(KNOWN_MODELS, fetched_at)

            loaded = ModelCache(Path(directory)).load()

            assert loaded is not None
            self.assertEqual(KNOWN_MODELS, loaded.model_ids)
            self.assertEqual(fetched_at, loaded.fetched_at)

    def test_load_missing_file_returns_none(self) -> None:
        with TemporaryDirectory() as directory:
            self.assertIsNone(ModelCache(Path(directory)).load())

    def test_load_corrupt_or_unknown_schema_returns_none(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / ModelCache.FILENAME
            path.write_text("{not json", encoding="utf-8")
            self.assertIsNone(ModelCache(Path(directory)).load())

            path.write_text(json.dumps({"schema_version": 99, "model_ids": []}), encoding="utf-8")
            self.assertIsNone(ModelCache(Path(directory)).load())


class ClassifyExceptionTests(unittest.TestCase):
    def test_http_status_errors_map_to_categories(self) -> None:
        def status_error(status: int) -> httpx.HTTPStatusError:
            request = httpx.Request("GET", "http://example.test/models")
            response = httpx.Response(status, request=request)
            return httpx.HTTPStatusError("boom", request=request, response=response)

        self.assertIs(GatewayErrorCategory.AUTH, classify_exception(status_error(401)))
        self.assertIs(GatewayErrorCategory.RATE_LIMIT, classify_exception(status_error(429)))
        self.assertIs(GatewayErrorCategory.REJECTED, classify_exception(status_error(400)))
        self.assertIs(GatewayErrorCategory.SERVER, classify_exception(status_error(503)))

    def test_ambiguous_server_statuses_map_to_server_unknown(self) -> None:
        self.assertIs(
            GatewayErrorCategory.SERVER_UNKNOWN, category_for_status(500)
        )
        self.assertIs(
            GatewayErrorCategory.SERVER_UNKNOWN, category_for_status(502)
        )
        self.assertIs(
            GatewayErrorCategory.SERVER_UNKNOWN, category_for_status(504)
        )

    def test_deterministic_server_status_503_keeps_server_category(self) -> None:
        # 503（无可用渠道）可以确定生成未开始，保持失败的“服务错误”类别。
        self.assertIs(GatewayErrorCategory.SERVER, category_for_status(503))

    def test_transport_and_os_errors_map_to_network(self) -> None:
        self.assertIs(GatewayErrorCategory.NETWORK, classify_exception(httpx.ConnectError("no")))
        self.assertIs(GatewayErrorCategory.NETWORK, classify_exception(httpx.TimeoutException("slow")))
        self.assertIs(GatewayErrorCategory.NETWORK, classify_exception(OSError("socket")))
        self.assertIs(GatewayErrorCategory.NETWORK, classify_exception(ConnectionError("refused")))

    def test_value_errors_map_to_config(self) -> None:
        self.assertIs(GatewayErrorCategory.CONFIG, classify_exception(ValueError("bad url")))

    def test_unknown_exceptions_map_to_unknown(self) -> None:
        self.assertIs(GatewayErrorCategory.UNKNOWN, classify_exception(RuntimeError("?")))

    def test_gateway_error_keeps_its_category(self) -> None:
        error = GatewayError(GatewayErrorCategory.AUTH, "无效令牌")
        self.assertIs(GatewayErrorCategory.AUTH, classify_exception(error))


class ConnectionCheckTests(unittest.TestCase):
    def test_all_stages_pass_with_configured_models(self) -> None:
        results = run_connection_check(
            ScriptedProvider(KNOWN_MODELS), CapabilityRegistry()
        )

        by_stage = {check.stage: check for check in results}
        self.assertTrue(by_stage[ConnectionStage.DNS_OR_CONNECT].ok)
        self.assertTrue(by_stage[ConnectionStage.AUTH].ok)
        self.assertTrue(by_stage[ConnectionStage.MODEL_LIST].ok)
        self.assertTrue(by_stage[ConnectionStage.CAPABILITY].ok)

    def test_network_failure_fails_connect_and_skips_rest(self) -> None:
        results = run_connection_check(
            ScriptedProvider(GatewayError(GatewayErrorCategory.NETWORK, "连不上")),
            CapabilityRegistry(),
        )

        by_stage = {check.stage: check for check in results}
        self.assertFalse(by_stage[ConnectionStage.DNS_OR_CONNECT].ok)
        self.assertIsNone(by_stage[ConnectionStage.AUTH].ok)
        self.assertIsNone(by_stage[ConnectionStage.MODEL_LIST].ok)
        self.assertIsNone(by_stage[ConnectionStage.CAPABILITY].ok)
        self.assertIn("连不上", by_stage[ConnectionStage.DNS_OR_CONNECT].message)

    def test_auth_failure_fails_auth_and_skips_rest(self) -> None:
        results = run_connection_check(
            ScriptedProvider(GatewayError(GatewayErrorCategory.AUTH, "密钥无效")),
            CapabilityRegistry(),
        )

        by_stage = {check.stage: check for check in results}
        self.assertTrue(by_stage[ConnectionStage.DNS_OR_CONNECT].ok)
        self.assertFalse(by_stage[ConnectionStage.AUTH].ok)
        self.assertIsNone(by_stage[ConnectionStage.MODEL_LIST].ok)
        self.assertIsNone(by_stage[ConnectionStage.CAPABILITY].ok)
        self.assertIn("密钥无效", by_stage[ConnectionStage.AUTH].message)

    def test_empty_model_list_fails_model_list_stage(self) -> None:
        results = run_connection_check(ScriptedProvider(()), CapabilityRegistry())

        by_stage = {check.stage: check for check in results}
        self.assertTrue(by_stage[ConnectionStage.DNS_OR_CONNECT].ok)
        self.assertTrue(by_stage[ConnectionStage.AUTH].ok)
        self.assertFalse(by_stage[ConnectionStage.MODEL_LIST].ok)
        self.assertIsNone(by_stage[ConnectionStage.CAPABILITY].ok)

    def test_no_configured_models_fails_capability_stage(self) -> None:
        results = run_connection_check(
            ScriptedProvider(("wan2.7-image",)), CapabilityRegistry()
        )

        by_stage = {check.stage: check for check in results}
        self.assertTrue(by_stage[ConnectionStage.DNS_OR_CONNECT].ok)
        self.assertTrue(by_stage[ConnectionStage.AUTH].ok)
        self.assertTrue(by_stage[ConnectionStage.MODEL_LIST].ok)
        self.assertFalse(by_stage[ConnectionStage.CAPABILITY].ok)
        self.assertIn("未配置", by_stage[ConnectionStage.CAPABILITY].message)


if __name__ == "__main__":
    unittest.main()