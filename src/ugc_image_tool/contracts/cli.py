from __future__ import annotations

import argparse
import sys
import urllib.error
from pathlib import Path

from ugc_image_tool.contracts.recorder import (
    load_gateway_key,
    record_exchange,
    write_exchange,
)
from ugc_image_tool.contracts.validation import validate_fixture_directory


def _validate(fixture_directory: Path) -> int:
    errors = validate_fixture_directory(fixture_directory)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"契约夹具有效：{fixture_directory}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="验证团队网关脱敏契约夹具")
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate", help="验证夹具目录")
    validate_parser.add_argument("fixture_directory", type=Path)
    record_parser = subparsers.add_parser("record", help="执行一次请求并保存脱敏交互")
    record_parser.add_argument("--base-url", required=True)
    record_parser.add_argument("--interface", required=True, choices=("models", "text_to_image", "image_edit"))
    record_parser.add_argument("--path", required=True)
    record_parser.add_argument("--method", choices=("GET", "POST"), default="GET")
    record_parser.add_argument("--body-file", type=Path)
    record_parser.add_argument("--content-type", default="application/json")
    record_parser.add_argument("--key-file", type=Path)
    record_parser.add_argument("--timeout", type=float, default=30.0)
    record_parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args(argv)

    if arguments.command == "validate":
        return _validate(arguments.fixture_directory)
    if arguments.command == "record":
        try:
            key = load_gateway_key(arguments.key_file)
        except (ValueError, OSError) as error:
            print(error, file=sys.stderr)
            return 2
        try:
            exchange = record_exchange(
                base_url=arguments.base_url,
                interface=arguments.interface,
                path=arguments.path,
                method=arguments.method,
                key=key,
                body_file=arguments.body_file,
                content_type=arguments.content_type,
                timeout=arguments.timeout,
            )
            write_exchange(exchange, arguments.output)
        except (OSError, TimeoutError, urllib.error.URLError) as error:
            print(f"网关网络或文件错误：{error}", file=sys.stderr)
            return 3
        print(f"已保存脱敏交互：{arguments.output}")
        return 0
    parser.error(f"未知命令：{arguments.command}")


if __name__ == "__main__":
    raise SystemExit(main())
