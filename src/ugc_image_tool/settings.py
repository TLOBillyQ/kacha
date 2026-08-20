"""普通设置与凭据存取。

普通设置（输出根目录、网关基础地址、并发上限）以 JSON 写入当前用户的
LocalAppData/ugc-image-tool/；API 密钥单独交给当前 Windows 用户的凭据库，
永远不进入设置文件、任务记录、日志或测试数据。程序目录保持只读。
"""

from __future__ import annotations

import ctypes
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from urllib.parse import urlparse
from uuid import uuid4

from .capabilities import ModelTier, Workflow
from .storage import atomic_write_text


DEFAULT_BASE_URL = "http://lzxsvn:3001"
DEFAULT_CONCURRENCY_LIMIT = 3
MIN_CONCURRENCY_LIMIT = 1
MAX_CONCURRENCY_LIMIT = 6
CREDENTIAL_SERVICE_NAME = "ugc-image-tool"


def default_user_data_dir() -> Path:
    """当前用户的 LocalAppData/ugc-image-tool/，程序目录保持只读。"""
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return root / "ugc-image-tool"


def default_output_root() -> Path:
    """默认输出根目录：Windows 图片/UGC AI 生图工具/。"""
    return Path.home() / "Pictures" / "UGC AI 生图工具"


def validate_concurrency_limit(value: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not MIN_CONCURRENCY_LIMIT <= value <= MAX_CONCURRENCY_LIMIT
    ):
        raise ValueError("并发上限必须是 1～6 的整数")
    return value


def validate_base_url(value: str) -> str:
    stripped = value.strip().rstrip("/")
    parsed = urlparse(stripped)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        raise ValueError("网关基础地址必须以 http:// 或 https:// 开头并包含主机名")
    return stripped


@dataclass(frozen=True)
class AppSettings:
    output_root: Path
    base_url: str
    concurrency_limit: int
    # 各工作流已选档位；只存档位不存模型 ID，档内换模型后选择不变。
    selected_tiers: dict[Workflow, ModelTier] = field(default_factory=dict)


class SettingsStoreError(ValueError):
    pass


class SettingsStore:
    """持久化普通设置到用户数据目录；任一字段非法时拒绝整份文件。"""

    SCHEMA_VERSION = 1
    FILENAME = "settings.json"

    def __init__(self, user_data_dir: Path | None = None) -> None:
        self._user_data_dir = (
            Path(user_data_dir) if user_data_dir is not None else default_user_data_dir()
        )
        self._storage_path = self._user_data_dir / self.FILENAME
        try:
            self._user_data_dir.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise SettingsStoreError(f"无法创建用户数据目录：{self._user_data_dir}") from error
        self._settings = self._load()

    @property
    def storage_path(self) -> Path:
        return self._storage_path

    @property
    def user_data_dir(self) -> Path:
        return self._user_data_dir

    @property
    def settings(self) -> AppSettings:
        return self._settings

    def save_output_root(self, path: Path) -> AppSettings:
        candidate = Path(path)
        if not str(candidate).strip():
            raise ValueError("输出根目录不能为空")
        return self._update(output_root=candidate)

    def save_base_url(self, value: str) -> AppSettings:
        return self._update(base_url=validate_base_url(value))

    def save_concurrency_limit(self, value: int) -> AppSettings:
        return self._update(concurrency_limit=validate_concurrency_limit(value))

    def selected_tier(self, workflow: Workflow) -> ModelTier:
        """该工作流已选档位；无记录时回退到旗舰档。"""
        return self._settings.selected_tiers.get(workflow, ModelTier.FLAGSHIP)

    def save_selected_tier(self, workflow: Workflow, tier: ModelTier) -> AppSettings:
        if not isinstance(tier, ModelTier):
            raise ValueError("档位必须是 ModelTier")
        tiers = dict(self._settings.selected_tiers)
        tiers[workflow] = tier
        return self._update(selected_tiers=tiers)

    def _update(
        self,
        *,
        output_root: Path | None = None,
        base_url: str | None = None,
        concurrency_limit: int | None = None,
        selected_tiers: dict[Workflow, ModelTier] | None = None,
    ) -> AppSettings:
        current = self._settings
        updated = AppSettings(
            output_root=output_root if output_root is not None else current.output_root,
            base_url=base_url if base_url is not None else current.base_url,
            concurrency_limit=(
                concurrency_limit
                if concurrency_limit is not None
                else current.concurrency_limit
            ),
            selected_tiers=(
                selected_tiers if selected_tiers is not None else dict(current.selected_tiers)
            ),
        )
        self._persist(updated)
        self._settings = updated
        return updated

    def _load(self) -> AppSettings:
        defaults = AppSettings(
            output_root=default_output_root(),
            base_url=DEFAULT_BASE_URL,
            concurrency_limit=DEFAULT_CONCURRENCY_LIMIT,
        )
        if not self._storage_path.is_file():
            return defaults
        try:
            raw = json.loads(self._storage_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SettingsStoreError(f"无法读取设置：{error}") from error
        if not isinstance(raw, dict) or raw.get("schema_version") != self.SCHEMA_VERSION:
            raise SettingsStoreError("设置文件版本无效")
        output_root = defaults.output_root
        base_url = defaults.base_url
        concurrency_limit = defaults.concurrency_limit
        if "output_root" in raw:
            value = raw["output_root"]
            if not isinstance(value, str) or not value.strip():
                raise SettingsStoreError("设置文件的 output_root 无效")
            output_root = Path(value)
        if "base_url" in raw:
            try:
                base_url = validate_base_url(raw["base_url"])
            except (TypeError, ValueError) as error:
                raise SettingsStoreError(f"设置文件的 base_url 无效：{error}") from error
        if "concurrency_limit" in raw:
            try:
                concurrency_limit = validate_concurrency_limit(raw["concurrency_limit"])
            except (TypeError, ValueError) as error:
                raise SettingsStoreError(f"设置文件的 concurrency_limit 无效：{error}") from error
        selected_tiers = self._parse_selected_tiers(raw.get("selected_tiers"))
        return AppSettings(output_root, base_url, concurrency_limit, selected_tiers)

    def _parse_selected_tiers(self, raw_tiers: object) -> dict[Workflow, ModelTier]:
        """旧版本设置文件没有该字段，缺失时按空记录处理。"""
        if raw_tiers is None:
            return {}
        if not isinstance(raw_tiers, dict):
            raise SettingsStoreError("设置文件的 selected_tiers 无效")
        tiers: dict[Workflow, ModelTier] = {}
        for key, value in raw_tiers.items():
            try:
                tiers[Workflow(key)] = ModelTier(value)
            except ValueError as error:
                raise SettingsStoreError(
                    f"设置文件的 selected_tiers 无效：{key!r}={value!r}"
                ) from error
        return tiers

    def _persist(self, settings: AppSettings) -> None:
        content = json.dumps(
            {
                "schema_version": self.SCHEMA_VERSION,
                "output_root": str(settings.output_root),
                "base_url": settings.base_url,
                "concurrency_limit": settings.concurrency_limit,
                "selected_tiers": {
                    workflow.value: tier.value
                    for workflow, tier in settings.selected_tiers.items()
                },
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n"
        try:
            atomic_write_text(self._storage_path, content)
        except OSError as error:
            raise SettingsStoreError(f"无法保存设置：{error}") from error


class CredentialService(Protocol):
    def save_api_key(self, key: str) -> None: ...

    def api_key(self) -> str | None: ...

    def clear_api_key(self) -> None: ...


class MemoryCredentialService:
    """测试与开发用内存凭据服务，不写入系统凭据库。"""

    def __init__(self) -> None:
        self._key: str | None = None

    def save_api_key(self, key: str) -> None:
        if not isinstance(key, str):
            raise TypeError("API 密钥必须是字符串")
        self._key = key

    def api_key(self) -> str | None:
        return self._key

    def clear_api_key(self) -> None:
        self._key = None


_CRED_TYPE_GENERIC = 1
_CRED_PERSIST_LOCAL_MACHINE = 2
_ERROR_NOT_FOUND = 1168


class _Credential(ctypes.Structure):
    """CREDENTIAL 结构体（64 位布局），用于读写 Windows 凭据库。"""

    _fields_ = [
        ("Flags", ctypes.c_ulong),
        ("Type", ctypes.c_ulong),
        ("TargetName", ctypes.c_wchar_p),
        ("Comment", ctypes.c_wchar_p),
        ("LastWritten", ctypes.c_ulonglong),
        ("CredentialBlobSize", ctypes.c_ulong),
        ("CredentialBlob", ctypes.c_void_p),
        ("Persist", ctypes.c_ulong),
        ("AttributeCount", ctypes.c_ulong),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", ctypes.c_wchar_p),
        ("UserName", ctypes.c_wchar_p),
    ]


class WindowsCredentialService:
    """把 API 密钥保存到当前 Windows 用户凭据库，服务名固定为 ugc-image-tool。"""

    def __init__(self) -> None:
        if os.name != "nt":
            raise RuntimeError("Windows 凭据库仅支持 Windows")
        self._advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    def save_api_key(self, key: str) -> None:
        blob = key.encode("utf-16-le")
        blob_buffer = (ctypes.c_char * len(blob)).from_buffer_copy(blob)
        credential = _Credential()
        credential.Flags = 0
        credential.Type = _CRED_TYPE_GENERIC
        credential.TargetName = CREDENTIAL_SERVICE_NAME
        credential.Comment = None
        credential.LastWritten = 0
        credential.CredentialBlobSize = len(blob)
        credential.CredentialBlob = ctypes.cast(blob_buffer, ctypes.c_void_p)
        credential.Persist = _CRED_PERSIST_LOCAL_MACHINE
        credential.AttributeCount = 0
        credential.Attributes = None
        credential.TargetAlias = None
        credential.UserName = None
        if not self._advapi32.CredWriteW(ctypes.byref(credential), 0):
            raise OSError(ctypes.get_last_error(), "无法写入 Windows 凭据库")

    def api_key(self) -> str | None:
        pointer = ctypes.POINTER(_Credential)()
        ok = self._advapi32.CredReadW(
            CREDENTIAL_SERVICE_NAME,
            _CRED_TYPE_GENERIC,
            0,
            ctypes.byref(pointer),
        )
        try:
            if not ok:
                if ctypes.get_last_error() == _ERROR_NOT_FOUND:
                    return None
                raise OSError(ctypes.get_last_error(), "无法读取 Windows 凭据库")
            credential = pointer.contents
            size = credential.CredentialBlobSize
            blob_pointer = credential.CredentialBlob
            if size == 0 or not blob_pointer:
                return None
            return ctypes.string_at(blob_pointer, size).decode("utf-16-le")
        finally:
            if pointer:
                self._advapi32.CredFree(pointer)

    def clear_api_key(self) -> None:
        ok = self._advapi32.CredDeleteW(CREDENTIAL_SERVICE_NAME, _CRED_TYPE_GENERIC, 0)
        if not ok and ctypes.get_last_error() != _ERROR_NOT_FOUND:
            raise OSError(ctypes.get_last_error(), "无法删除 Windows 凭据库中的 API 密钥")


class SettingsApplication:
    """设置页应用服务：普通设置持久化，凭据只交给凭据服务，输出目录可操作。"""

    def __init__(
        self,
        store: SettingsStore | None = None,
        credentials: CredentialService | None = None,
    ) -> None:
        self._store = store or SettingsStore()
        self._credentials = credentials or WindowsCredentialService()

    @property
    def output_root(self) -> Path:
        return self._store.settings.output_root

    @property
    def base_url(self) -> str:
        return self._store.settings.base_url

    @property
    def concurrency_limit(self) -> int:
        return self._store.settings.concurrency_limit

    @property
    def storage_path(self) -> Path:
        return self._store.storage_path

    def set_output_root(self, path: Path) -> None:
        self._store.save_output_root(Path(path))

    def set_base_url(self, value: str) -> None:
        self._store.save_base_url(value)

    @property
    def uses_plaintext_http(self) -> bool:
        return self.base_url.startswith("http://")

    def set_concurrency_limit(self, value: int) -> None:
        self._store.save_concurrency_limit(value)

    def selected_tier(self, workflow: Workflow) -> ModelTier:
        return self._store.selected_tier(workflow)

    def save_selected_tier(self, workflow: Workflow, tier: ModelTier) -> None:
        self._store.save_selected_tier(workflow, tier)

    def output_directory_error(self) -> str | None:
        """返回阻止提交的可操作错误；输出目录可写时返回 None。"""
        return self._output_directory_error(probe=True)

    def _output_directory_error(self, *, probe: bool) -> str | None:
        root = self.output_root
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            return f"输出根目录不可用：{root}（{error}）。请到设置页修改输出根目录。"
        if not probe:
            return None
        probe_path = root / f".write-probe-{uuid4().hex}.tmp"
        try:
            probe_path.write_bytes(b"")
            probe_path.unlink()
        except OSError:
            return f"输出根目录不可写：{root}。请到设置页修改输出根目录。"
        return None

    def save_api_key(self, key: str) -> None:
        if not isinstance(key, str) or not key.strip():
            raise ValueError("API 密钥不能为空")
        self._credentials.save_api_key(key)

    @property
    def api_key(self) -> str | None:
        return self._credentials.api_key()

    def clear_api_key(self) -> None:
        self._credentials.clear_api_key()
