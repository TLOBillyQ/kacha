# 使用 PySide6 构建桌面客户端

第一版使用 Python 与 PySide6，而不是原计划中的 CustomTkinter 或 Electron。统一任务中心、并发状态更新、参考图拖拽、缩略图、Windows 剪贴板和高分屏支持使界面超出简单表单范围；Qt 提供更成熟的桌面组件，同时保留 Python 打包与 API 集成的单一技术栈，代价是更大的便携包。

> 已被 [ADR 0008](0008-use-tauri-and-react-flow-for-the-v2-desktop-client.md) 取代：v2 改用 Tauri 2 + React Flow，v1 客户端已于 #96 从 main 移除，代码归档于 `archive/v1` 分支与标签 `v0.1.0`，本决议不再约束任何在维护的代码。
