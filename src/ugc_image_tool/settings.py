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
from dataclasses import dataclass, replace
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
    reference_expanded: bool = False
    image_count_expanded: bool = False
    disclosure_hint_seen: bool = False
    selected_preset_id: str | None = None
    settings_advanced_expanded: bool = False


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

    def _save_bool_state(self, value: bool, error_message: str, **field: bool) -> AppSettings:
        if not isinstance(value, bool):
            raise ValueError(error_message)
        return self._update(**field)

    def save_negative_prompt_enabled(self, enabled: bool) -> AppSettings:
        return self._save_bool_state(
            enabled, "负向提示词勾选状态必须是布尔值", negative_prompt_enabled=enabled
        )

    def reference_expanded(self) -> bool:
        return self._settings.reference_expanded

    def save_reference_expanded(self, expanded: bool) -> AppSettings:
        return self._save_bool_state(
            expanded, "参考图区展开状态必须是布尔值", reference_expanded=expanded
        )

    def image_count_expanded(self) -> bool:
        return self._settings.image_count_expanded

    def save_image_count_expanded(self, expanded: bool) -> AppSettings:
        return self._save_bool_state(
            expanded, "出图数量展开状态必须是布尔值", image_count_expanded=expanded
        )

    def disclosure_hint_seen(self) -> bool:
        return self._settings.disclosure_hint_seen

    def save_disclosure_hint_seen(self, seen: bool) -> AppSettings:
        return self._save_bool_state(
            seen, "进阶项提示已读状态必须是布尔值", disclosure_hint_seen=seen
        )

    def selected_preset_id(self) -> str | None:
        return self._settings.selected_preset_id

    def save_selected_preset_id(self, preset_id: str) -> AppSettings:
        if not isinstance(preset_id, str) or not preset_id.strip():
            raise ValueError("项目预设 ID 不能为空")
        return self._update(selected_preset_id=preset_id)

    def settings_advanced_expanded(self) -> bool:
        return self._settings.settings_advanced_expanded

    def save_settings_advanced_expanded(self, expanded: bool) -> AppSettings:
        return self._save_bool_state(
            expanded, "高级设置展开状态必须是布尔值", settings_advanced_expanded=expanded
        )

    def _update(self, **changes: object) -> AppSettings:
        # None 表示“不修改该字段”，逐字段过滤后交给 dataclasses.replace。
        updated = replace(
            self._settings,
            **{key: value for key, value in changes.items() if value is not None},
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
        reference_expanded = self._parse_bool_setting(raw, "reference_expanded")
        image_count_expanded = self._parse_bool_setting(raw, "image_count_expanded")
        disclosure_hint_seen = self._parse_bool_setting(raw, "disclosure_hint_seen")
        selected_preset_id = raw.get("selected_preset_id")
        if selected_preset_id is not None and (
            not isinstance(selected_preset_id, str) or not selected_preset_id.strip()
        ):
            raise SettingsStoreError("设置文件的 selected_preset_id 无效")
        settings_advanced_expanded = self._parse_bool_setting(
            raw, "settings_advanced_expanded"
        )
        return AppSettings(
            output_root,
            base_url,
            concurrency_limit,
            selected_tier,
            negative_prompt_enabled,
            reference_expanded,
            image_count_expanded,
            disclosure_hint_seen,
            selected_preset_id,
            settings_advanced_expanded,
        )

    def _parse_bool_setting(self, raw: dict[str, object], key: str) -> bool:
        value = raw.get(key, False)
        if not isinstance(value, bool):
            raise SettingsStoreError(f"设置文件的 {key} 无效")
        return value

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
                "reference_expanded": settings.reference_expanded,
                "image_count_expanded": settings.image_count_expanded,
                "disclosure_hint_seen": settings.disclosure_hint_seen,
                "selected_preset_id": settings.selected_preset_id,
                "settings_advanced_expanded": settings.settings_advanced_expanded,
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

    def generation_reference_expanded(self) -> bool:
        return self._store.reference_expanded()

    def save_generation_reference_expanded(self, expanded: bool) -> None:
        self._store.save_reference_expanded(expanded)

    def generation_image_count_expanded(self) -> bool:
        return self._store.image_count_expanded()

    def save_generation_image_count_expanded(self, expanded: bool) -> None:
        self._store.save_image_count_expanded(expanded)

    def generation_disclosure_hint_seen(self) -> bool:
        return self._store.disclosure_hint_seen()

    def save_generation_disclosure_hint_seen(self, seen: bool) -> None:
        self._store.save_disclosure_hint_seen(seen)

    def generation_selected_preset_id(self) -> str | None:
        return self._store.selected_preset_id()

    def save_generation_selected_preset_id(self, preset_id: str) -> None:
        self._store.save_selected_preset_id(preset_id)

    def settings_advanced_expanded(self) -> bool:
        return self._store.settings_advanced_expanded()

    def save_settings_advanced_expanded(self, expanded: bool) -> None:
        self._store.save_settings_advanced_expanded(expanded)

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
# projectHash=4ee8812e22807610
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
# scope.4.startLine=99
# scope.4.endLine=108
# scope.4.semanticHash=897d0d2a9b485a81
# scope.5.id=settings.SettingsStore.storage_path
# scope.5.kind=method
# scope.5.startLine=111
# scope.5.endLine=112
# scope.5.semanticHash=8e7cb1ad44753ef7
# scope.6.id=settings.SettingsStore.user_data_dir
# scope.6.kind=method
# scope.6.startLine=115
# scope.6.endLine=116
# scope.6.semanticHash=8e7cb1ad44753ef7
# scope.7.id=settings.SettingsStore.settings
# scope.7.kind=method
# scope.7.startLine=119
# scope.7.endLine=120
# scope.7.semanticHash=8e7cb1ad44753ef7
# scope.8.id=settings.SettingsStore.save_output_root
# scope.8.kind=method
# scope.8.startLine=122
# scope.8.endLine=126
# scope.8.semanticHash=149cbb581af6d955
# scope.9.id=settings.SettingsStore.save_base_url
# scope.9.kind=method
# scope.9.startLine=128
# scope.9.endLine=129
# scope.9.semanticHash=d812ee42d1283cbd
# scope.10.id=settings.SettingsStore.save_concurrency_limit
# scope.10.kind=method
# scope.10.startLine=131
# scope.10.endLine=132
# scope.10.semanticHash=d812ee42d1283cbd
# scope.11.id=settings.SettingsStore.selected_tier
# scope.11.kind=method
# scope.11.startLine=134
# scope.11.endLine=135
# scope.11.semanticHash=935c8b1c5041dea2
# scope.12.id=settings.SettingsStore.save_selected_tier
# scope.12.kind=method
# scope.12.startLine=137
# scope.12.endLine=140
# scope.12.semanticHash=fe744fcb2d8df0b0
# scope.13.id=settings.SettingsStore.negative_prompt_enabled
# scope.13.kind=method
# scope.13.startLine=142
# scope.13.endLine=143
# scope.13.semanticHash=935c8b1c5041dea2
# scope.14.id=settings.SettingsStore._save_bool_state
# scope.14.kind=method
# scope.14.startLine=145
# scope.14.endLine=148
# scope.14.semanticHash=92aea81e1a3fbedb
# scope.15.id=settings.SettingsStore.save_negative_prompt_enabled
# scope.15.kind=method
# scope.15.startLine=150
# scope.15.endLine=153
# scope.15.semanticHash=9721242ad4f6722b
# scope.16.id=settings.SettingsStore.reference_expanded
# scope.16.kind=method
# scope.16.startLine=155
# scope.16.endLine=156
# scope.16.semanticHash=935c8b1c5041dea2
# scope.17.id=settings.SettingsStore.save_reference_expanded
# scope.17.kind=method
# scope.17.startLine=158
# scope.17.endLine=161
# scope.17.semanticHash=9721242ad4f6722b
# scope.18.id=settings.SettingsStore.image_count_expanded
# scope.18.kind=method
# scope.18.startLine=163
# scope.18.endLine=164
# scope.18.semanticHash=935c8b1c5041dea2
# scope.19.id=settings.SettingsStore.save_image_count_expanded
# scope.19.kind=method
# scope.19.startLine=166
# scope.19.endLine=169
# scope.19.semanticHash=9721242ad4f6722b
# scope.20.id=settings.SettingsStore.disclosure_hint_seen
# scope.20.kind=method
# scope.20.startLine=171
# scope.20.endLine=172
# scope.20.semanticHash=935c8b1c5041dea2
# scope.21.id=settings.SettingsStore.save_disclosure_hint_seen
# scope.21.kind=method
# scope.21.startLine=174
# scope.21.endLine=177
# scope.21.semanticHash=9721242ad4f6722b
# scope.22.id=settings.SettingsStore.selected_preset_id
# scope.22.kind=method
# scope.22.startLine=179
# scope.22.endLine=180
# scope.22.semanticHash=8ae895f3a31e4ca4
# scope.23.id=settings.SettingsStore.save_selected_preset_id
# scope.23.kind=method
# scope.23.startLine=182
# scope.23.endLine=185
# scope.23.semanticHash=a5fdbf99f3fc413d
# scope.24.id=settings.SettingsStore.settings_advanced_expanded
# scope.24.kind=method
# scope.24.startLine=187
# scope.24.endLine=188
# scope.24.semanticHash=935c8b1c5041dea2
# scope.25.id=settings.SettingsStore.save_settings_advanced_expanded
# scope.25.kind=method
# scope.25.startLine=190
# scope.25.endLine=193
# scope.25.semanticHash=9721242ad4f6722b
# scope.26.id=settings.SettingsStore._parse_bool_setting
# scope.26.kind=method
# scope.26.startLine=265
# scope.26.endLine=269
# scope.26.semanticHash=9148a7f8c257256e
# scope.27.id=settings.SettingsStore._parse_selected_tier
# scope.27.kind=method
# scope.27.startLine=271
# scope.27.endLine=278
# scope.27.semanticHash=ee1f8ed521dc2427
# scope.28.id=settings.SettingsStore._parse_selected_tiers
# scope.28.kind=method
# scope.28.startLine=280
# scope.28.endLine=294
# scope.28.semanticHash=e674cbfe1535c8a6
# scope.29.id=settings.SettingsStore._parse_negative_prompt_enabled
# scope.29.kind=method
# scope.29.startLine=296
# scope.29.endLine=302
# scope.29.semanticHash=3a43f13a6289fc57
# scope.30.id=settings.SettingsStore._parse_legacy_negative_prompt_enabled
# scope.30.kind=method
# scope.30.startLine=304
# scope.30.endLine=323
# scope.30.semanticHash=b52f7e35db7c058a
# scope.31.id=settings.CredentialService.save_api_key
# scope.31.kind=method
# scope.31.startLine=350
# scope.31.endLine=350
# scope.31.semanticHash=005ac25ea302796c
# scope.32.id=settings.CredentialService.api_key
# scope.32.kind=method
# scope.32.startLine=352
# scope.32.endLine=352
# scope.32.semanticHash=fb077c15ee88cca7
# scope.33.id=settings.CredentialService.clear_api_key
# scope.33.kind=method
# scope.33.startLine=354
# scope.33.endLine=354
# scope.33.semanticHash=15a6f5c603776605
# scope.34.id=settings.MemoryCredentialService.__init__
# scope.34.kind=method
# scope.34.startLine=360
# scope.34.endLine=361
# scope.34.semanticHash=6393dff470855301
# scope.35.id=settings.MemoryCredentialService.save_api_key
# scope.35.kind=method
# scope.35.startLine=363
# scope.35.endLine=366
# scope.35.semanticHash=7112cb83af400b97
# scope.36.id=settings.MemoryCredentialService.api_key
# scope.36.kind=method
# scope.36.startLine=368
# scope.36.endLine=369
# scope.36.semanticHash=15aa707eae016a37
# scope.37.id=settings.MemoryCredentialService.clear_api_key
# scope.37.kind=method
# scope.37.startLine=371
# scope.37.endLine=372
# scope.37.semanticHash=f9e5abce2b3073aa
# scope.38.id=settings.KeychainCredentialService.__init__
# scope.38.kind=method
# scope.38.startLine=381
# scope.38.endLine=386
# scope.38.semanticHash=be88feb961da1663
# scope.39.id=settings.KeychainCredentialService.save_api_key
# scope.39.kind=method
# scope.39.startLine=388
# scope.39.endLine=391
# scope.39.semanticHash=23b27edb400effaa
# scope.40.id=settings.KeychainCredentialService.api_key
# scope.40.kind=method
# scope.40.startLine=393
# scope.40.endLine=394
# scope.40.semanticHash=41fc583fcaf51a6e
# scope.41.id=settings.KeychainCredentialService.clear_api_key
# scope.41.kind=method
# scope.41.startLine=396
# scope.41.endLine=400
# scope.41.semanticHash=5eec6d28731fd5d8
# scope.42.id=settings.WindowsCredentialService.__init__
# scope.42.kind=method
# scope.42.startLine=430
# scope.42.endLine=434
# scope.42.semanticHash=d60b35c9650cb487
# scope.43.id=settings.WindowsCredentialService.save_api_key
# scope.43.kind=method
# scope.43.startLine=436
# scope.43.endLine=453
# scope.43.semanticHash=b6cdf6351f059501
# scope.44.id=settings.WindowsCredentialService.api_key
# scope.44.kind=method
# scope.44.startLine=455
# scope.44.endLine=476
# scope.44.semanticHash=47df0f43898619e6
# scope.45.id=settings.WindowsCredentialService.clear_api_key
# scope.45.kind=method
# scope.45.startLine=478
# scope.45.endLine=481
# scope.45.semanticHash=13105b332debc3aa
# scope.46.id=settings.SettingsApplication.__init__
# scope.46.kind=method
# scope.46.startLine=487
# scope.46.endLine=493
# scope.46.semanticHash=afa1e2ed123c1409
# scope.47.id=settings.SettingsApplication.output_root
# scope.47.kind=method
# scope.47.startLine=496
# scope.47.endLine=497
# scope.47.semanticHash=7f3f84e14542d45d
# scope.48.id=settings.SettingsApplication.base_url
# scope.48.kind=method
# scope.48.startLine=500
# scope.48.endLine=501
# scope.48.semanticHash=7f3f84e14542d45d
# scope.49.id=settings.SettingsApplication.concurrency_limit
# scope.49.kind=method
# scope.49.startLine=504
# scope.49.endLine=505
# scope.49.semanticHash=7f3f84e14542d45d
# scope.50.id=settings.SettingsApplication.storage_path
# scope.50.kind=method
# scope.50.startLine=508
# scope.50.endLine=509
# scope.50.semanticHash=6e40772bd2c7038c
# scope.51.id=settings.SettingsApplication.set_output_root
# scope.51.kind=method
# scope.51.startLine=511
# scope.51.endLine=512
# scope.51.semanticHash=7f7580640a9a1062
# scope.52.id=settings.SettingsApplication.set_base_url
# scope.52.kind=method
# scope.52.startLine=514
# scope.52.endLine=515
# scope.52.semanticHash=62bcaefaaab9eeeb
# scope.53.id=settings.SettingsApplication.uses_plaintext_http
# scope.53.kind=method
# scope.53.startLine=518
# scope.53.endLine=519
# scope.53.semanticHash=389ef4ee71580b3c
# scope.54.id=settings.SettingsApplication.set_concurrency_limit
# scope.54.kind=method
# scope.54.startLine=521
# scope.54.endLine=522
# scope.54.semanticHash=62bcaefaaab9eeeb
# scope.55.id=settings.SettingsApplication.generation_tier
# scope.55.kind=method
# scope.55.startLine=526
# scope.55.endLine=527
# scope.55.semanticHash=c33ad8f01f54adcb
# scope.56.id=settings.SettingsApplication.save_generation_tier
# scope.56.kind=method
# scope.56.startLine=529
# scope.56.endLine=530
# scope.56.semanticHash=62bcaefaaab9eeeb
# scope.57.id=settings.SettingsApplication.generation_negative_prompt_enabled
# scope.57.kind=method
# scope.57.startLine=532
# scope.57.endLine=533
# scope.57.semanticHash=c33ad8f01f54adcb
# scope.58.id=settings.SettingsApplication.save_generation_negative_prompt_enabled
# scope.58.kind=method
# scope.58.startLine=535
# scope.58.endLine=536
# scope.58.semanticHash=62bcaefaaab9eeeb
# scope.59.id=settings.SettingsApplication.generation_reference_expanded
# scope.59.kind=method
# scope.59.startLine=538
# scope.59.endLine=539
# scope.59.semanticHash=c33ad8f01f54adcb
# scope.60.id=settings.SettingsApplication.save_generation_reference_expanded
# scope.60.kind=method
# scope.60.startLine=541
# scope.60.endLine=542
# scope.60.semanticHash=62bcaefaaab9eeeb
# scope.61.id=settings.SettingsApplication.generation_image_count_expanded
# scope.61.kind=method
# scope.61.startLine=544
# scope.61.endLine=545
# scope.61.semanticHash=c33ad8f01f54adcb
# scope.62.id=settings.SettingsApplication.save_generation_image_count_expanded
# scope.62.kind=method
# scope.62.startLine=547
# scope.62.endLine=548
# scope.62.semanticHash=62bcaefaaab9eeeb
# scope.63.id=settings.SettingsApplication.generation_disclosure_hint_seen
# scope.63.kind=method
# scope.63.startLine=550
# scope.63.endLine=551
# scope.63.semanticHash=c33ad8f01f54adcb
# scope.64.id=settings.SettingsApplication.save_generation_disclosure_hint_seen
# scope.64.kind=method
# scope.64.startLine=553
# scope.64.endLine=554
# scope.64.semanticHash=62bcaefaaab9eeeb
# scope.65.id=settings.SettingsApplication.generation_selected_preset_id
# scope.65.kind=method
# scope.65.startLine=556
# scope.65.endLine=557
# scope.65.semanticHash=0cbf349038d012e9
# scope.66.id=settings.SettingsApplication.save_generation_selected_preset_id
# scope.66.kind=method
# scope.66.startLine=559
# scope.66.endLine=560
# scope.66.semanticHash=62bcaefaaab9eeeb
# scope.67.id=settings.SettingsApplication.settings_advanced_expanded
# scope.67.kind=method
# scope.67.startLine=562
# scope.67.endLine=563
# scope.67.semanticHash=c33ad8f01f54adcb
# scope.68.id=settings.SettingsApplication.save_settings_advanced_expanded
# scope.68.kind=method
# scope.68.startLine=565
# scope.68.endLine=566
# scope.68.semanticHash=62bcaefaaab9eeeb
# scope.69.id=settings.SettingsApplication.output_directory_error
# scope.69.kind=method
# scope.69.startLine=568
# scope.69.endLine=570
# scope.69.semanticHash=d71154ca01c7b2d4
# scope.70.id=settings.SettingsApplication._output_directory_error
# scope.70.kind=method
# scope.70.startLine=572
# scope.70.endLine=586
# scope.70.semanticHash=cc32efe4abb66f81
# scope.71.id=settings.SettingsApplication.save_api_key
# scope.71.kind=method
# scope.71.startLine=588
# scope.71.endLine=599
# scope.71.semanticHash=a2e87d09f7ee87b2
# scope.72.id=settings.SettingsApplication.api_key
# scope.72.kind=method
# scope.72.startLine=602
# scope.72.endLine=603
# scope.72.semanticHash=2dce07efe553f41b
# scope.73.id=settings.SettingsApplication.clear_api_key
# scope.73.kind=method
# scope.73.startLine=605
# scope.73.endLine=606
# scope.73.semanticHash=6052ba3cc5aca668
