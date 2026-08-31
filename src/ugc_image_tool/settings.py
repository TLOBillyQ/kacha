"""普通设置与凭据存取。

普通设置（输出根目录、网关基础地址、并发上限）以 JSON 写入当前用户的
LocalAppData/ugc-image-tool/；API 密钥单独交给当前 Windows 用户的凭据库，
永远不进入设置文件、任务记录、日志或测试数据。程序目录保持只读。
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
from dataclasses import dataclass
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
_LEGACY_GENERATION_WORKFLOW = Workflow.IMAGE_EDIT


def default_user_data_dir() -> Path:
    """当前用户的 LocalAppData/ugc-image-tool/，程序目录保持只读。"""
    # 用 sys.platform 而非 os.name 判断，测试可以在非 Windows 开发机上模拟
    # Windows 分支而不影响 pathlib 对具体路径类的选择。
    if sys.platform == "win32":
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
    # urlparse 接受 Unicode 主机名，但 httpx 发请求时按 ASCII 编码会直接抛
    # UnicodeEncodeError（实测：地址里混入“→”时连接检查报看不懂的编解码错误）。
    # 在保存时就拦下并指出具体字符。
    for char in stripped:
        if ord(char) > 127:
            raise ValueError(
                f"网关基础地址含有非法字符“{char}”，"
                "请确认没有混入箭头、中文标点或多余文字"
            )
    return stripped


@dataclass(frozen=True)
class AppSettings:
    output_root: Path
    base_url: str
    concurrency_limit: int
    selected_tier: ModelTier = ModelTier.FLAGSHIP
    negative_prompt_enabled: bool = False


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

    def selected_tier(self) -> ModelTier:
        return self._settings.selected_tier

    def save_selected_tier(self, tier: ModelTier) -> AppSettings:
        if not isinstance(tier, ModelTier):
            raise ValueError("档位必须是 ModelTier")
        return self._update(selected_tier=tier)

    def negative_prompt_enabled(self) -> bool:
        return self._settings.negative_prompt_enabled

    def save_negative_prompt_enabled(self, enabled: bool) -> AppSettings:
        if not isinstance(enabled, bool):
            raise ValueError("负向提示词勾选状态必须是布尔值")
        return self._update(negative_prompt_enabled=enabled)

    def _update(
        self,
        *,
        output_root: Path | None = None,
        base_url: str | None = None,
        concurrency_limit: int | None = None,
        selected_tier: ModelTier | None = None,
        negative_prompt_enabled: bool | None = None,
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
            selected_tier=(
                selected_tier if selected_tier is not None else current.selected_tier
            ),
            negative_prompt_enabled=(
                negative_prompt_enabled
                if negative_prompt_enabled is not None
                else current.negative_prompt_enabled
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
        selected_tier = self._parse_selected_tier(raw)
        negative_prompt_enabled = self._parse_negative_prompt_enabled(
            raw.get("negative_prompt_enabled")
        )
        return AppSettings(
            output_root,
            base_url,
            concurrency_limit,
            selected_tier,
            negative_prompt_enabled,
        )

    def _parse_selected_tier(self, raw: dict[str, object]) -> ModelTier:
        if "selected_tier" in raw:
            try:
                return ModelTier(raw["selected_tier"])
            except (TypeError, ValueError) as error:
                raise SettingsStoreError("设置文件的 selected_tier 无效") from error
        legacy = self._parse_selected_tiers(raw.get("selected_tiers"))
        return legacy.get(_LEGACY_GENERATION_WORKFLOW, ModelTier.FLAGSHIP)

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

    def _parse_negative_prompt_enabled(self, raw_states: object) -> bool:
        if raw_states is None:
            return False
        if isinstance(raw_states, bool):
            return raw_states
        legacy = self._parse_legacy_negative_prompt_enabled(raw_states)
        return legacy.get(_LEGACY_GENERATION_WORKFLOW, False)

    def _parse_legacy_negative_prompt_enabled(
        self,
        raw_states: object,
    ) -> dict[Workflow, bool]:
        if not isinstance(raw_states, dict):
            raise SettingsStoreError("设置文件的 negative_prompt_enabled 无效")
        states: dict[Workflow, bool] = {}
        for key, value in raw_states.items():
            try:
                workflow = Workflow(key)
            except ValueError as error:
                raise SettingsStoreError(
                    f"设置文件的 negative_prompt_enabled 无效：{key!r}"
                ) from error
            if not isinstance(value, bool):
                raise SettingsStoreError(
                    f"设置文件的 negative_prompt_enabled 无效：{key!r}={value!r}"
                )
            states[workflow] = value
        return states

    def _persist(self, settings: AppSettings) -> None:
        content = json.dumps(
            {
                "schema_version": self.SCHEMA_VERSION,
                "output_root": str(settings.output_root),
                "base_url": settings.base_url,
                "concurrency_limit": settings.concurrency_limit,
                "selected_tier": settings.selected_tier.value,
                "negative_prompt_enabled": settings.negative_prompt_enabled,
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


class KeychainCredentialService:
    """macOS 钥匙串凭据服务；keyring 只在 darwin 安装（pyproject 平台标记），
    导入延迟到构造时，避免其他平台 import 失败。"""

    _USERNAME = "api-key"

    def __init__(self) -> None:
        import keyring
        import keyring.errors

        self._keyring = keyring
        self._delete_error = keyring.errors.PasswordDeleteError

    def save_api_key(self, key: str) -> None:
        if not isinstance(key, str):
            raise TypeError("API 密钥必须是字符串")
        self._keyring.set_password(CREDENTIAL_SERVICE_NAME, self._USERNAME, key)

    def api_key(self) -> str | None:
        return self._keyring.get_password(CREDENTIAL_SERVICE_NAME, self._USERNAME)

    def clear_api_key(self) -> None:
        try:
            self._keyring.delete_password(CREDENTIAL_SERVICE_NAME, self._USERNAME)
        except self._delete_error:
            pass


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

    # 合并后的单一「生成」页只有一套状态（档位 + 负向勾选），新设置写入
    # singular key；读取旧字典时只回退 image_edit，弃用 text_to_image。
    def generation_tier(self) -> ModelTier:
        return self._store.selected_tier()

    def save_generation_tier(self, tier: ModelTier) -> None:
        self._store.save_selected_tier(tier)

    def generation_negative_prompt_enabled(self) -> bool:
        return self._store.negative_prompt_enabled()

    def save_generation_negative_prompt_enabled(self, enabled: bool) -> None:
        self._store.save_negative_prompt_enabled(enabled)

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
        # 实测事故：把整段中文说明文字粘进密钥框后，httpx 在编码认证头时抛
        # UnicodeEncodeError，连接检查只报看不懂的编解码错误。保存时拦下。
        for char in key:
            if ord(char) > 127:
                raise ValueError(
                    f"API 密钥含有非法字符“{char}”，"
                    "请确认粘贴的是密钥本身，没有混入其他文字"
                )
        self._credentials.save_api_key(key)

    @property
    def api_key(self) -> str | None:
        return self._credentials.api_key()

    def clear_api_key(self) -> None:
        self._credentials.clear_api_key()

# mutate4py-manifest
# version=4
# projectHash=59814d936825315e
# scope.0.id=settings.default_user_data_dir
# scope.0.kind=function
# scope.0.startLine=32
# scope.0.endLine=40
# scope.0.semanticHash=0150e2ad867f4d84
# scope.1.id=settings.default_output_root
# scope.1.kind=function
# scope.1.startLine=43
# scope.1.endLine=45
# scope.1.semanticHash=a6362809d1e0f663
# scope.2.id=settings.validate_concurrency_limit
# scope.2.kind=function
# scope.2.startLine=48
# scope.2.endLine=55
# scope.2.semanticHash=c0ec9747d5e1ce49
# scope.3.id=settings.validate_base_url
# scope.3.kind=function
# scope.3.startLine=58
# scope.3.endLine=72
# scope.3.semanticHash=6a50a5c35ea7045c
# scope.4.id=settings.SettingsStore.__init__
# scope.4.kind=method
# scope.4.startLine=94
# scope.4.endLine=103
# scope.4.semanticHash=897d0d2a9b485a81
# scope.5.id=settings.SettingsStore.storage_path
# scope.5.kind=method
# scope.5.startLine=106
# scope.5.endLine=107
# scope.5.semanticHash=8e7cb1ad44753ef7
# scope.6.id=settings.SettingsStore.user_data_dir
# scope.6.kind=method
# scope.6.startLine=110
# scope.6.endLine=111
# scope.6.semanticHash=8e7cb1ad44753ef7
# scope.7.id=settings.SettingsStore.settings
# scope.7.kind=method
# scope.7.startLine=114
# scope.7.endLine=115
# scope.7.semanticHash=8e7cb1ad44753ef7
# scope.8.id=settings.SettingsStore.save_output_root
# scope.8.kind=method
# scope.8.startLine=117
# scope.8.endLine=121
# scope.8.semanticHash=149cbb581af6d955
# scope.9.id=settings.SettingsStore.save_base_url
# scope.9.kind=method
# scope.9.startLine=123
# scope.9.endLine=124
# scope.9.semanticHash=d812ee42d1283cbd
# scope.10.id=settings.SettingsStore.save_concurrency_limit
# scope.10.kind=method
# scope.10.startLine=126
# scope.10.endLine=127
# scope.10.semanticHash=d812ee42d1283cbd
# scope.11.id=settings.SettingsStore.selected_tier
# scope.11.kind=method
# scope.11.startLine=129
# scope.11.endLine=130
# scope.11.semanticHash=935c8b1c5041dea2
# scope.12.id=settings.SettingsStore.save_selected_tier
# scope.12.kind=method
# scope.12.startLine=132
# scope.12.endLine=135
# scope.12.semanticHash=fe744fcb2d8df0b0
# scope.13.id=settings.SettingsStore.negative_prompt_enabled
# scope.13.kind=method
# scope.13.startLine=137
# scope.13.endLine=138
# scope.13.semanticHash=935c8b1c5041dea2
# scope.14.id=settings.SettingsStore.save_negative_prompt_enabled
# scope.14.kind=method
# scope.14.startLine=140
# scope.14.endLine=143
# scope.14.semanticHash=fe744fcb2d8df0b0
# scope.15.id=settings.SettingsStore._update
# scope.15.kind=method
# scope.15.startLine=145
# scope.15.endLine=174
# scope.15.semanticHash=ec7baca16901bd65
# scope.16.id=settings.SettingsStore._load
# scope.16.kind=method
# scope.16.startLine=176
# scope.16.endLine=218
# scope.16.semanticHash=1175e1935bcf0e4b
# scope.17.id=settings.SettingsStore._parse_selected_tier
# scope.17.kind=method
# scope.17.startLine=220
# scope.17.endLine=227
# scope.17.semanticHash=ee1f8ed521dc2427
# scope.18.id=settings.SettingsStore._parse_selected_tiers
# scope.18.kind=method
# scope.18.startLine=229
# scope.18.endLine=243
# scope.18.semanticHash=e674cbfe1535c8a6
# scope.19.id=settings.SettingsStore._parse_negative_prompt_enabled
# scope.19.kind=method
# scope.19.startLine=245
# scope.19.endLine=251
# scope.19.semanticHash=3a43f13a6289fc57
# scope.20.id=settings.SettingsStore._parse_legacy_negative_prompt_enabled
# scope.20.kind=method
# scope.20.startLine=253
# scope.20.endLine=272
# scope.20.semanticHash=b52f7e35db7c058a
# scope.21.id=settings.SettingsStore._persist
# scope.21.kind=method
# scope.21.startLine=274
# scope.21.endLine=290
# scope.21.semanticHash=84079080abea092b
# scope.22.id=settings.CredentialService.save_api_key
# scope.22.kind=method
# scope.22.startLine=294
# scope.22.endLine=294
# scope.22.semanticHash=005ac25ea302796c
# scope.23.id=settings.CredentialService.api_key
# scope.23.kind=method
# scope.23.startLine=296
# scope.23.endLine=296
# scope.23.semanticHash=fb077c15ee88cca7
# scope.24.id=settings.CredentialService.clear_api_key
# scope.24.kind=method
# scope.24.startLine=298
# scope.24.endLine=298
# scope.24.semanticHash=15a6f5c603776605
# scope.25.id=settings.MemoryCredentialService.__init__
# scope.25.kind=method
# scope.25.startLine=304
# scope.25.endLine=305
# scope.25.semanticHash=6393dff470855301
# scope.26.id=settings.MemoryCredentialService.save_api_key
# scope.26.kind=method
# scope.26.startLine=307
# scope.26.endLine=310
# scope.26.semanticHash=7112cb83af400b97
# scope.27.id=settings.MemoryCredentialService.api_key
# scope.27.kind=method
# scope.27.startLine=312
# scope.27.endLine=313
# scope.27.semanticHash=15aa707eae016a37
# scope.28.id=settings.MemoryCredentialService.clear_api_key
# scope.28.kind=method
# scope.28.startLine=315
# scope.28.endLine=316
# scope.28.semanticHash=f9e5abce2b3073aa
# scope.29.id=settings.KeychainCredentialService.__init__
# scope.29.kind=method
# scope.29.startLine=325
# scope.29.endLine=330
# scope.29.semanticHash=be88feb961da1663
# scope.30.id=settings.KeychainCredentialService.save_api_key
# scope.30.kind=method
# scope.30.startLine=332
# scope.30.endLine=335
# scope.30.semanticHash=23b27edb400effaa
# scope.31.id=settings.KeychainCredentialService.api_key
# scope.31.kind=method
# scope.31.startLine=337
# scope.31.endLine=338
# scope.31.semanticHash=41fc583fcaf51a6e
# scope.32.id=settings.KeychainCredentialService.clear_api_key
# scope.32.kind=method
# scope.32.startLine=340
# scope.32.endLine=344
# scope.32.semanticHash=5eec6d28731fd5d8
# scope.33.id=settings.WindowsCredentialService.__init__
# scope.33.kind=method
# scope.33.startLine=374
# scope.33.endLine=378
# scope.33.semanticHash=d60b35c9650cb487
# scope.34.id=settings.WindowsCredentialService.save_api_key
# scope.34.kind=method
# scope.34.startLine=380
# scope.34.endLine=397
# scope.34.semanticHash=b6cdf6351f059501
# scope.35.id=settings.WindowsCredentialService.api_key
# scope.35.kind=method
# scope.35.startLine=399
# scope.35.endLine=420
# scope.35.semanticHash=47df0f43898619e6
# scope.36.id=settings.WindowsCredentialService.clear_api_key
# scope.36.kind=method
# scope.36.startLine=422
# scope.36.endLine=425
# scope.36.semanticHash=13105b332debc3aa
# scope.37.id=settings.SettingsApplication.__init__
# scope.37.kind=method
# scope.37.startLine=431
# scope.37.endLine=437
# scope.37.semanticHash=afa1e2ed123c1409
# scope.38.id=settings.SettingsApplication.output_root
# scope.38.kind=method
# scope.38.startLine=440
# scope.38.endLine=441
# scope.38.semanticHash=7f3f84e14542d45d
# scope.39.id=settings.SettingsApplication.base_url
# scope.39.kind=method
# scope.39.startLine=444
# scope.39.endLine=445
# scope.39.semanticHash=7f3f84e14542d45d
# scope.40.id=settings.SettingsApplication.concurrency_limit
# scope.40.kind=method
# scope.40.startLine=448
# scope.40.endLine=449
# scope.40.semanticHash=7f3f84e14542d45d
# scope.41.id=settings.SettingsApplication.storage_path
# scope.41.kind=method
# scope.41.startLine=452
# scope.41.endLine=453
# scope.41.semanticHash=6e40772bd2c7038c
# scope.42.id=settings.SettingsApplication.set_output_root
# scope.42.kind=method
# scope.42.startLine=455
# scope.42.endLine=456
# scope.42.semanticHash=7f7580640a9a1062
# scope.43.id=settings.SettingsApplication.set_base_url
# scope.43.kind=method
# scope.43.startLine=458
# scope.43.endLine=459
# scope.43.semanticHash=62bcaefaaab9eeeb
# scope.44.id=settings.SettingsApplication.uses_plaintext_http
# scope.44.kind=method
# scope.44.startLine=462
# scope.44.endLine=463
# scope.44.semanticHash=389ef4ee71580b3c
# scope.45.id=settings.SettingsApplication.set_concurrency_limit
# scope.45.kind=method
# scope.45.startLine=465
# scope.45.endLine=466
# scope.45.semanticHash=62bcaefaaab9eeeb
# scope.46.id=settings.SettingsApplication.generation_tier
# scope.46.kind=method
# scope.46.startLine=470
# scope.46.endLine=471
# scope.46.semanticHash=c33ad8f01f54adcb
# scope.47.id=settings.SettingsApplication.save_generation_tier
# scope.47.kind=method
# scope.47.startLine=473
# scope.47.endLine=474
# scope.47.semanticHash=62bcaefaaab9eeeb
# scope.48.id=settings.SettingsApplication.generation_negative_prompt_enabled
# scope.48.kind=method
# scope.48.startLine=476
# scope.48.endLine=477
# scope.48.semanticHash=c33ad8f01f54adcb
# scope.49.id=settings.SettingsApplication.save_generation_negative_prompt_enabled
# scope.49.kind=method
# scope.49.startLine=479
# scope.49.endLine=480
# scope.49.semanticHash=62bcaefaaab9eeeb
# scope.50.id=settings.SettingsApplication.output_directory_error
# scope.50.kind=method
# scope.50.startLine=482
# scope.50.endLine=484
# scope.50.semanticHash=d71154ca01c7b2d4
# scope.51.id=settings.SettingsApplication._output_directory_error
# scope.51.kind=method
# scope.51.startLine=486
# scope.51.endLine=500
# scope.51.semanticHash=cc32efe4abb66f81
# scope.52.id=settings.SettingsApplication.save_api_key
# scope.52.kind=method
# scope.52.startLine=502
# scope.52.endLine=513
# scope.52.semanticHash=a2e87d09f7ee87b2
# scope.53.id=settings.SettingsApplication.api_key
# scope.53.kind=method
# scope.53.startLine=516
# scope.53.endLine=517
# scope.53.semanticHash=2dce07efe553f41b
# scope.54.id=settings.SettingsApplication.clear_api_key
# scope.54.kind=method
# scope.54.startLine=519
# scope.54.endLine=520
# scope.54.semanticHash=6052ba3cc5aca668
