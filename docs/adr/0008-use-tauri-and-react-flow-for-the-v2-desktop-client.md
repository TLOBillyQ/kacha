# v2 桌面客户端改用 Tauri 2 + React Flow，不再沿用 Python/PySide6

v2 节点图画布工作台的壳与画布采用 Tauri 2（Rust 壳，系统 WebView2 / WKWebView）+ React Flow（TypeScript），取代 ADR 0002 的 PySide6 路线；网关调用、能力表、设置、结果落盘等现有约 8.4k 行 Python（第三方依赖仅 httpx）用 TypeScript 重写，不再有 Python 运行时。依据是 #63 三线原型在 Windows 真机上的同画板对比：Qt 自研画布、React Flow + pywebview、React Flow + Tauri 三者帧率都够（85–135 FPS），分歧在体积、启动、开发量与内存——Tauri 单 exe 3.2 MB、首开 0.5–0.7 s，画布交互靠库现成（拉连线一行回调，Qt 版自写 60 行）；pywebview 保住 Python 却多出 105 MB 的 CLR 桥进程与 pythonnet 的路径、序列化坑；Qt 常驻内存最低（172 MB，Tauri 419 MB）但包体 39 MB、画布全部手写。我们接受内存多 250 MB 与放弃 Python 的代价，换取轻量分发、与 ComfyUI/Figma 一致的画布手感和一个量级更少的画布开发量。正式构建的 Windows 工具链为 MSVC（`x86_64-pc-windows-msvc`）；原型阶段用 windows-gnu + mingw windres 验证过可编译，只作应急备选。旧 PySide6 客户端冻结，只修阻塞性 bug；ADR 0001、0003–0007 的约束（网关唯一入口、HTTP 信任网络、能力表、JSON 透传、Gitea Release 分发）对新壳继续生效。

> 后续：旧 PySide6 客户端已于 #96 从 main 移除，归档于 `archive/v1` 分支与标签 `v0.1.0`。
