"""模型发现与连接检查的后台控制器。

界面不直接创建发现线程，也不保存刷新代际。页面只订阅本控制器的
``discovered`` 与 ``checked`` 信号；快速连续修改地址或密钥时，
只有最新一次刷新结果会被发出。
"""

from __future__ import annotations

from threading import Thread
from typing import Protocol

from PySide6.QtCore import QObject, Signal

from ...capabilities import CapabilityRegistry
from ...diagnostics import DiagnosticSink
from ...discovery import (
    ConnectionCheck,
    ConnectionStage,
    DiscoveryState,
    ModelProvider,
    run_connection_check,
)


class DiscoveryService(Protocol):
    """控制器所需的模型发现服务；ModelDiscovery 默认实现该协议。"""

    @property
    def state(self) -> DiscoveryState: ...

    def refresh(self) -> DiscoveryState: ...


class DiscoveryController(QObject):
    """发现、离线状态、连接检查与刷新竞态的单一后台入口。"""

    discovered = Signal(object)
    checked = Signal(object)

    def __init__(
        self,
        discovery: DiscoveryService,
        *,
        provider: ModelProvider,
        capabilities: CapabilityRegistry,
        diagnostics: DiagnosticSink | None = None,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._discovery = discovery
        self._provider = provider
        self._capabilities = capabilities
        self._diagnostics = diagnostics
        # 发现代际计数：快速连续改地址/密钥时只采纳最新一次刷新的结果。
        self._epoch = 0

    @property
    def state(self) -> DiscoveryState:
        return self._discovery.state

    def refresh(self) -> None:
        """异步刷新模型列表；旧代际的结果到达后会被丢弃。"""
        self._epoch += 1
        epoch = self._epoch
        Thread(
            target=self._refresh_discovery,
            args=(epoch,),
            name=f"model-discovery-{epoch}",
            daemon=True,
        ).start()

    def run_connection_check(self) -> None:
        """异步执行 DNS/连接、鉴权、模型列表与能力匹配检查。"""
        Thread(
            target=self._run_connection_check,
            name="connection-check",
            daemon=True,
        ).start()

    def _refresh_discovery(self, epoch: int) -> None:
        state = self._discovery.refresh()
        # 期间又发起过更晚的刷新时，丢弃本次过期结果，避免跨线程信号串扰。
        if epoch == self._epoch:
            self.discovered.emit(state)

    def _run_connection_check(self) -> None:
        try:
            checks = run_connection_check(
                self._provider,
                self._capabilities,
                self._diagnostics,
            )
        except Exception as error:
            # 检查器本身的意外异常也不能让连接测试按钮永远停在禁用态。
            checks = (
                ConnectionCheck(
                    ConnectionStage.DNS_OR_CONNECT,
                    False,
                    f"连接检查失败：{error}",
                ),
                ConnectionCheck(ConnectionStage.AUTH, None, "未到达鉴权阶段"),
                ConnectionCheck(ConnectionStage.MODEL_LIST, None, "未到达模型列表阶段"),
                ConnectionCheck(ConnectionStage.CAPABILITY, None, "未到达能力匹配阶段"),
            )
        self.checked.emit(checks)
