# 自动更新采用 Tauri 官方 updater

Kacha 的自动更新使用 Tauri 官方 updater 与 process 插件，而不是自行维护免安装包替换进程。Windows 与 macOS 各自构建并在 Gitea Release 上传静态平台描述；客户端通过现有 Release 查询取得当前平台描述地址，再交给官方插件检查、下载、验证签名和安装。更新重启由用户主动触发，本决定不包含任务与保存保护流程。

Windows 使用 NSIS 按当前用户安装，同时承担首次安装与更新；macOS 保留首次安装 zip，更新使用官方 `.app.tar.gz` 签名产物。两端共用一套长期无密码 updater 密钥，私钥保存在当前用户目录下的项目专用位置，并在构建时通过 `TAURI_SIGNING_PRIVATE_KEY` 提供；公钥写入 `tauri.conf.json`。现有 HTTP Gitea 只在可信内网或 VPN 使用，客户端显式允许非 HTTPS updater 端点，同时仍强制验证 minisign 签名。
