"""桌面应用组合根：把设置、预设、网关、发现、任务与诊断装配为应用服务。

Qt 界面只使用本模块给出的服务组合，不直接构造或访问存储、凭据库与
网络资源。所有依赖保持可注入，便于应用级接缝测试在无 Qt、无真实
网关的环境下驱动启动、离线状态与任务生命周期。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Protocol

from .application import (
    Gateway,
    GenerationApplication,
    TaskListener,
)
from .capabilities import CapabilityOverrideError, CapabilityRegistry
from .diagnostics import DiagnosticExporter, DiagnosticLogger
from .discovery import ModelCache, ModelDiscovery
from .generation import GenerationTask
from .presets import PresetApplication, PresetStore
from .results import FileResultRepository
from .settings import (
    CredentialService,
    KeychainCredentialService,
    MemoryCredentialService,
    SettingsApplication,
    SettingsStore,
    WindowsCredentialService,
    default_user_data_dir,
)
from .team_gateway import TeamGateway

# 能力覆盖文件：团队无需重新发布客户端即可临时上架实测中的模型。
CAPABILITY_OVERRIDE_FILENAME = "capability-override.json"


class ServiceGateway(Gateway, Protocol):
    """应用服务所需的网关：发现、生成、设置热更新与资源关闭。"""

    def list_models(self) -> tuple[str, ...]: ...

    def set_base_url(self, value: str) -> None: ...

    def set_api_key(self, value: str) -> None: ...

    def close(self) -> None: ...


def default_credential_service() -> CredentialService:
    """Windows 用当前用户凭据库，macOS 用钥匙串；其他平台回退内存实现便于测试。"""
    if os.name == "nt":
        return WindowsCredentialService()
    if sys.platform == "darwin":
        return KeychainCredentialService()
    return MemoryCredentialService()


class ApplicationServices:
    """应用级服务组合；MainWindow 只调用这里的服务与信号。"""

    def __init__(
        self,
        *,
        output_root: Path | None = None,
        capabilities: CapabilityRegistry | None = None,
        preset_store: PresetStore | None = None,
        user_data_dir: Path | None = None,
        settings: SettingsApplication | None = None,
        credentials: CredentialService | None = None,
        gateway: ServiceGateway | None = None,
        diagnostics: DiagnosticLogger | None = None,
        diagnostic_exporter: DiagnosticExporter | None = None,
        discovery: ModelDiscovery | None = None,
        results: FileResultRepository | None = None,
        generation: GenerationApplication | None = None,
        on_task_changed: TaskListener | None = None,
    ) -> None:
        self.diagnostics = diagnostics or DiagnosticLogger(user_data_dir)
        self.capabilities = capabilities or self._compose_capabilities(user_data_dir)
        self.settings = settings or SettingsApplication(
            SettingsStore(user_data_dir),
            credentials or default_credential_service(),
        )
        if output_root is not None:
            self.settings.set_output_root(output_root)
        self.presets = PresetApplication(
            preset_store or PresetStore(user_data_dir)
        )
        self.gateway: ServiceGateway = gateway or TeamGateway(
            self.settings.base_url,
            self.settings.api_key or "",
            diagnostics=self.diagnostics,
            capabilities=self.capabilities,
        )
        self.results = results or FileResultRepository(
            self.settings.output_root,
            diagnostics=self.diagnostics,
        )
        self.discovery = discovery or ModelDiscovery(
            self.gateway,
            cache=ModelCache(user_data_dir),
            diagnostics=self.diagnostics,
        )
        # 任务事件由界面订阅；MainWindow 在装配后会挂接自己的信号中继。
        self.on_task_changed = on_task_changed
        self.generation = generation or GenerationApplication(
            gateway=self.gateway,
            results=self.results,
            capabilities=self.capabilities,
            on_task_changed=self._emit_task_changed,
            max_concurrency=self.settings.concurrency_limit,
            submission_guard=self.submission_block_reason,
            diagnostics=self.diagnostics,
        )
        self.diagnostic_exporter = diagnostic_exporter or DiagnosticExporter(
            user_data_dir
        )
        self._started = False
        self._closed = False

    def _emit_task_changed(self, task: GenerationTask) -> None:
        if self.on_task_changed is not None:
            self.on_task_changed(task)

    def _compose_capabilities(self, user_data_dir: Path | None) -> CapabilityRegistry:
        """接线能力覆盖文件；任一错误整份拒绝并回退内置能力表。"""
        data_dir = user_data_dir if user_data_dir is not None else default_user_data_dir()
        override_path = data_dir / CAPABILITY_OVERRIDE_FILENAME
        if not override_path.is_file():
            return CapabilityRegistry()
        try:
            return CapabilityRegistry(override_path)
        except CapabilityOverrideError as error:
            self.diagnostics.system(f"能力覆盖文件被拒绝，回退内置能力表：{error}")
            return CapabilityRegistry()

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self.diagnostics.system("应用启动")

    def submission_block_reason(self) -> str | None:
        """提交前检查输出目录与网关发现状态，返回可操作原因。"""
        output_error = self.settings.output_directory_error()
        if output_error:
            return output_error
        return self.discovery_block_reason()

    def discovery_block_reason(self) -> str | None:
        """只查询模型发现状态，不重复探测输出目录。"""
        return self.discovery.submission_block_reason()

    def set_output_root(self, path: Path) -> None:
        self.settings.set_output_root(Path(path))
        self.results.output_root = self.settings.output_root

    def set_base_url(self, value: str) -> None:
        self.settings.set_base_url(value)
        self.gateway.set_base_url(self.settings.base_url)

    def save_api_key(self, key: str) -> None:
        self.settings.save_api_key(key)
        self.gateway.set_api_key(self.settings.api_key or "")

    def clear_api_key(self) -> None:
        self.settings.clear_api_key()
        self.gateway.set_api_key("")

    def set_concurrency_limit(self, value: int) -> None:
        self.settings.set_concurrency_limit(value)
        self.generation.set_concurrency_limit(value)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.diagnostics.system("应用关闭")
        self.generation.close()
        self.gateway.close()
