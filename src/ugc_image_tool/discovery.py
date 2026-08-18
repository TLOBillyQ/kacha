"""模型发现、离线状态与连接检查。

启动时通过网关获取模型列表；成功后把列表写入本地缓存并与能力表匹配。
获取失败时回退到上次成功缓存，并明确标记其可能过期和当前离线状态。

网关错误按类别分类，供界面区分配置错误、网络不可达、鉴权失败、网关拒绝和
服务错误。模型列表等只读请求只做有限重试；生成请求不继承该重试策略。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from time import monotonic, sleep
from typing import Protocol
from uuid import uuid4

import httpx

from .capabilities import CapabilityRegistry
from .settings import default_user_data_dir


DEFAULT_READONLY_RETRIES = 3
RETRY_DELAY_SECONDS = 0.3


class GatewayErrorCategory(StrEnum):
    """网关错误的用户可见分类。"""

    CONFIG = "config"  # 配置错误（无效地址等）
    NETWORK = "network"  # 网络不可达、DNS、连接、超时
    AUTH = "auth"  # 鉴权失败
    REJECTED = "rejected"  # 网关拒绝（4xx 非鉴权）
    SERVER = "server"  # 网关服务错误（5xx，可短暂重试）
    UNKNOWN = "unknown"  # 结果未知


_TRANSIENT_CATEGORIES = frozenset(
    {GatewayErrorCategory.NETWORK, GatewayErrorCategory.SERVER}
)


class GatewayError(Exception):
    """网关层错误；携带用户可见分类，供连接检查和任务状态使用。"""

    def __init__(
        self,
        category: GatewayErrorCategory,
        message: str,
        *,
        gateway_request_id: str | None = None,
    ) -> None:
        self.category = category
        self.gateway_request_id = gateway_request_id
        super().__init__(message)


def classify_exception(error: Exception) -> GatewayErrorCategory:
    """把未知异常归类为网关错误类别；GatewayError 保持原类别。"""
    if isinstance(error, GatewayError):
        return error.category
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if status == 401:
            return GatewayErrorCategory.AUTH
        if 400 <= status < 500:
            return GatewayErrorCategory.REJECTED
        if status >= 500:
            return GatewayErrorCategory.SERVER
        return GatewayErrorCategory.UNKNOWN
    if isinstance(error, httpx.HTTPError):
        return GatewayErrorCategory.NETWORK
    if isinstance(error, (OSError, ConnectionError)):
        return GatewayErrorCategory.NETWORK
    if isinstance(error, ValueError):
        return GatewayErrorCategory.CONFIG
    return GatewayErrorCategory.UNKNOWN


class ModelProvider(Protocol):
    def list_models(self) -> tuple[str, ...]: ...


@dataclass(frozen=True)
class CachedModels:
    model_ids: tuple[str, ...]
    fetched_at: datetime


class ModelCache:
    """把上次成功的模型列表缓存到用户数据目录；解析失败视为无缓存。"""

    FILENAME = "models.json"
    SCHEMA_VERSION = 1

    def __init__(self, user_data_dir: Path | None = None) -> None:
        root = (
            Path(user_data_dir)
            if user_data_dir is not None
            else default_user_data_dir()
        )
        self._path = root / self.FILENAME

    def save(self, model_ids: tuple[str, ...], fetched_at: datetime) -> None:
        content = (
            json.dumps(
                {
                    "schema_version": self.SCHEMA_VERSION,
                    "fetched_at": fetched_at.astimezone(UTC).isoformat(),
                    "model_ids": list(model_ids),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.parent / f".{self.FILENAME}.{uuid4().hex}.tmp"
        try:
            with temporary.open("x", encoding="utf-8", newline="") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self._path)
        finally:
            temporary.unlink(missing_ok=True)

    def load(self) -> CachedModels | None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(raw, dict) or raw.get("schema_version") != self.SCHEMA_VERSION:
            return None
        model_ids = raw.get("model_ids")
        fetched_at = raw.get("fetched_at")
        if not isinstance(model_ids, list) or not isinstance(fetched_at, str):
            return None
        parsed_ids = tuple(
            model_id for model_id in model_ids if isinstance(model_id, str) and model_id
        )
        try:
            parsed_at = datetime.fromisoformat(fetched_at)
        except ValueError:
            return None
        if parsed_at.tzinfo is None:
            parsed_at = parsed_at.replace(tzinfo=UTC)
        return CachedModels(parsed_ids, parsed_at)


@dataclass(frozen=True)
class DiscoveryState:
    """模型发现结果；pending 表示首次刷新尚未完成。"""

    model_ids: tuple[str, ...] = ()
    online: bool = False
    stale: bool = False
    from_cache: bool = False
    pending: bool = True
    fetched_at: datetime | None = None
    error: str | None = None


class ModelDiscovery:
    """启动时发现可用模型；失败时回退缓存并进入离线状态。

    只读模型列表请求只做有限重试（网络与服务错误可重试，鉴权与配置错误不重试）。
    """

    def __init__(
        self,
        provider: ModelProvider,
        *,
        cache: ModelCache | None = None,
        max_retries: int = DEFAULT_READONLY_RETRIES,
        retry_delay: float = RETRY_DELAY_SECONDS,
    ) -> None:
        if max_retries < 1:
            raise ValueError("只读请求重试次数必须大于 0")
        self._provider = provider
        self._cache = cache if cache is not None else ModelCache(default_user_data_dir())
        self._max_retries = max_retries
        self._retry_delay = retry_delay
        self._state = DiscoveryState()

    @property
    def state(self) -> DiscoveryState:
        return self._state

    def refresh(self) -> DiscoveryState:
        """拉取模型列表并更新缓存；失败时回退到上次成功缓存。"""
        last_error: Exception | None = None
        attempts = 0
        while attempts < self._max_retries:
            attempts += 1
            try:
                models = self._provider.list_models()
            except Exception as error:
                last_error = error
                if not _is_transient(error) or attempts >= self._max_retries:
                    break
                if self._retry_delay > 0:
                    sleep(self._retry_delay * attempts)
                continue
            model_ids = tuple(models)
            fetched_at = datetime.now(UTC)
            self._try_save_cache(model_ids, fetched_at)
            self._state = DiscoveryState(
                model_ids=model_ids,
                online=True,
                stale=False,
                from_cache=False,
                pending=False,
                fetched_at=fetched_at,
            )
            return self._state

        cached = self._cache.load()
        if cached is not None:
            self._state = DiscoveryState(
                model_ids=cached.model_ids,
                online=False,
                stale=True,
                from_cache=True,
                pending=False,
                fetched_at=cached.fetched_at,
                error=_error_message(last_error),
            )
        else:
            self._state = DiscoveryState(
                pending=False,
                error=_error_message(last_error),
            )
        return self._state

    def submission_block_reason(self) -> str | None:
        """返回阻止提交的可操作原因；网关在线时返回 None。"""
        if self._state.online:
            return None
        if self._state.pending:
            return "正在连接网关，暂不能提交生成任务"
        if self._state.from_cache:
            return "网关当前离线，模型列表可能已过期；连接恢复后可提交"
        return "网关当前离线或未连接，无法提交生成任务"

    def _try_save_cache(
        self, model_ids: tuple[str, ...], fetched_at: datetime
    ) -> None:
        try:
            self._cache.save(model_ids, fetched_at)
        except OSError:
            pass  # 缓存写入失败不应阻止发现成功


class ConnectionStage(StrEnum):
    DNS_OR_CONNECT = "dns_or_connect"  # DNS/连接
    AUTH = "auth"  # 鉴权
    MODEL_LIST = "model_list"  # 模型列表
    CAPABILITY = "capability"  # 能力匹配


@dataclass(frozen=True)
class ConnectionCheck:
    """连接检查单阶段结果；ok 为 None 表示前序失败跳过。"""

    stage: ConnectionStage
    ok: bool | None
    message: str


def run_connection_check(
    provider: ModelProvider,
    registry: CapabilityRegistry,
) -> tuple[ConnectionCheck, ...]:
    """分阶段检查网关连接，逐项报告 DNS/连接、鉴权、模型列表与能力匹配。"""
    checks: list[ConnectionCheck] = []

    def add(stage: ConnectionStage, ok: bool | None, message: str) -> None:
        checks.append(ConnectionCheck(stage, ok, message))

    try:
        models = provider.list_models()
    except Exception as error:
        category = classify_exception(error)
        if category is GatewayErrorCategory.NETWORK:
            add(ConnectionStage.DNS_OR_CONNECT, False, f"无法连接网关：{error}")
            add(ConnectionStage.AUTH, None, "未到达鉴权阶段")
            add(ConnectionStage.MODEL_LIST, None, "未到达模型列表阶段")
            add(ConnectionStage.CAPABILITY, None, "未到达能力匹配阶段")
            return tuple(checks)
        if category is GatewayErrorCategory.CONFIG:
            add(ConnectionStage.DNS_OR_CONNECT, False, f"网关配置错误：{error}")
            add(ConnectionStage.AUTH, None, "未到达鉴权阶段")
            add(ConnectionStage.MODEL_LIST, None, "未到达模型列表阶段")
            add(ConnectionStage.CAPABILITY, None, "未到达能力匹配阶段")
            return tuple(checks)
        if category is GatewayErrorCategory.AUTH:
            add(ConnectionStage.DNS_OR_CONNECT, True, "网关连接正常")
            add(ConnectionStage.AUTH, False, f"鉴权失败：{error}")
            add(ConnectionStage.MODEL_LIST, None, "鉴权未通过，跳过")
            add(ConnectionStage.CAPABILITY, None, "鉴权未通过，跳过")
            return tuple(checks)
        add(ConnectionStage.DNS_OR_CONNECT, True, "网关连接正常")
        add(ConnectionStage.AUTH, True, "鉴权通过")
        add(ConnectionStage.MODEL_LIST, False, f"获取模型列表失败：{error}")
        add(ConnectionStage.CAPABILITY, None, "模型列表未获取，跳过")
        return tuple(checks)

    model_ids = tuple(models)
    add(ConnectionStage.DNS_OR_CONNECT, True, "网关连接正常")
    add(ConnectionStage.AUTH, True, "鉴权通过")
    if not model_ids:
        add(ConnectionStage.MODEL_LIST, False, "网关返回的模型列表为空")
        add(ConnectionStage.CAPABILITY, None, "模型列表为空，跳过")
        return tuple(checks)
    add(ConnectionStage.MODEL_LIST, True, f"获取到 {len(model_ids)} 个模型")
    configured = [
        entry for entry in registry.merge(model_ids) if entry.capability is not None
    ]
    if not configured:
        add(ConnectionStage.CAPABILITY, False, "网关模型均未配置能力，无法提交")
    else:
        add(ConnectionStage.CAPABILITY, True, f"{len(configured)} 个模型已配置，可提交")
    return tuple(checks)


def _is_transient(error: Exception) -> bool:
    return classify_exception(error) in _TRANSIENT_CATEGORIES


def _error_message(error: Exception | None) -> str | None:
    return None if error is None else str(error)