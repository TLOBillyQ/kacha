from __future__ import annotations

import unittest
from typing import cast

from ugc_image_tool.sanitize import (
    is_sensitive_key,
    redact_value,
    sanitize_text,
)

SK_SECRET = "sk-SENSITIVE-API-KEY-0123456789"
BEARER_SECRET = "SENSITIVE-BEARER-TOKEN-9876"
COOKIE_SECRET = "SENSITIVE-COOKIE-VALUE"
URL_SECRET = "https://example.invalid/dl/SENSITIVE-URL-TOKEN?expires=9999&sig=abc"


class SanitizeTextTests(unittest.TestCase):
    def test_redacts_authorization_and_bearer_tokens(self) -> None:
        text = f"Authorization: Bearer {BEARER_SECRET}; Connection closed"

        redacted = sanitize_text(text)

        self.assertNotIn(BEARER_SECRET, redacted)
        self.assertNotIn("Authorization:", redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_redacts_openai_style_api_keys(self) -> None:
        text = f"拒绝：invalid api key {SK_SECRET}"

        redacted = sanitize_text(text)

        self.assertNotIn(SK_SECRET, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_redacts_api_key_and_cookie_assignment_patterns(self) -> None:
        text = f"api_key={SK_SECRET}; Cookie: {COOKIE_SECRET}; X-Api-Key: {BEARER_SECRET}"

        redacted = sanitize_text(text)

        self.assertNotIn(SK_SECRET, redacted)
        self.assertNotIn(COOKIE_SECRET, redacted)
        self.assertNotIn(BEARER_SECRET, cast(str, redacted))
        self.assertIn("[REDACTED]", cast(str, redacted))

    def test_redacts_http_urls_including_temporary_download_addresses(self) -> None:
        redacted = sanitize_text(f"下载地址 {URL_SECRET} 已失效")

        self.assertNotIn(URL_SECRET, redacted)
        self.assertIn("[REDACTED_URL]", redacted)

    def test_redacts_long_base64_image_content_blobs(self) -> None:
        image_blob = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB"
            "pfZFQAAAAABJRU5ErkJggg=="
        )
        redacted = sanitize_text(f"返回内容：{image_blob}")

        self.assertNotIn(image_blob, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_plain_text_is_unchanged(self) -> None:
        self.assertEqual("普通文本", sanitize_text("普通文本"))


class RedactValueTests(unittest.TestCase):
    def test_sensitive_keys_are_fully_replaced(self) -> None:
        value = {
            "authorization": "Bearer secret",
            "nested": {
                "api_key": "nested-secret",
                "X-Access-Token": "access-secret",
                "keep": "可见字段",
            },
        }

        redacted = cast(dict[str, object], redact_value(value))
        nested = cast(dict[str, object], redacted["nested"])

        self.assertEqual("[REDACTED]", redacted["authorization"])
        self.assertEqual("[REDACTED]", nested["api_key"])
        self.assertEqual("[REDACTED]", nested["X-Access-Token"])
        self.assertEqual("可见字段", nested["keep"])

    def test_strings_within_values_are_sanitized(self) -> None:
        redacted = redact_value(f"错误：Bearer {BEARER_SECRET}")

        self.assertNotIn(BEARER_SECRET, cast(str, redacted))
        self.assertIn("[REDACTED]", cast(str, redacted))

    def test_non_serializable_values_are_sanitized(self) -> None:
        redacted = redact_value(object())

        self.assertIsInstance(redacted, str)
        self.assertTrue(redacted)


class IsSensitiveKeyTests(unittest.TestCase):
    def test_detects_auth_and_credential_keys(self) -> None:
        sensitive = [
            "token",
            "api_key",
            "Authorization",
            "X-Api-Key",
            "x_access_token",
            "Cookie",
            "password",
        ]
        for key in sensitive:
            self.assertTrue(is_sensitive_key(key), key)

    def test_allows_ordinary_keys(self) -> None:
        for key in ["model", "size", "prompt", "width", "image_count"]:
            self.assertFalse(is_sensitive_key(key), key)


if __name__ == "__main__":
    unittest.main()