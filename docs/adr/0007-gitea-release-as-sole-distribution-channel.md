# Gitea Release 是唯一分发渠道，updater 签名独立于操作系统签名

面向内网团队分发，发布仍收敛到现有 Gitea Release，由 `packaging/publish_release.py` 以 tag `v<版本>` 上传；版本号唯一来源为 `client/src-tauri/Cargo.toml`。启用 Tauri 官方 updater 后，Windows 发布按当前用户安装的 NSIS 安装器，不再发布免安装 zip；macOS 保留首次安装 zip，另发布官方 updater 的 `.app.tar.gz` 更新包。每个平台再携带 updater 签名 `.sig` 与平台描述 `updater-<平台>.json`；描述在更新包、签名和 SHA256SUMS 上传完成后最后发布，重复发布时先撤下本端描述。

我们决定不为 Windows 购买代码签名证书，也不做 Apple 公证；macOS 保留 ad-hoc 签名。Tauri updater 使用两端共享的一套无密码 minisign 密钥，私钥留在发布环境并通过环境变量提供，公钥内置客户端，密钥不进入仓库。代价是 Windows 首次启动仍需绕过 SmartScreen，macOS 首次安装仍需系统放行；这两个说明必须写进发布说明。签名代码路径（`sign.ps1`、`--cert`）保留但不属于默认流程，将来购证可直接启用。

> v2 补记（#94）：结论不变。版本号唯一来源改为 `client/src-tauri/Cargo.toml`（`tauri.conf.json` 不写 version 即沿用），发布脚本重写为 `packaging/build_release.py` 与 `packaging/publish_release.py`；签名代码路径（`sign.ps1`、`--cert`）未随 v2 移植。
