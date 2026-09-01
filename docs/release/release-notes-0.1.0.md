# UGC AI 生图工具 0.1.0

本地 AI 图片生成与编辑客户端。下载对应平台的压缩包即可使用。

## 下载

- **Windows**：`ugc-image-tool-0.1.0-win-x64.zip`
- **macOS**：`ugc-image-tool-0.1.0-macos-arm64.zip`（Apple Silicon）

## 首次运行

本软件未做代码签名，首次启动会被系统拦截，按下方步骤放行一次即可。

- **Windows**：SmartScreen 提示“未知发布者”时，点 **更多信息 → 仍要运行**。
- **macOS**：必须用**访达双击解压**，然后 **右键应用图标 → 打开**。命令行 `unzip` 会破坏应用包。

## 安全提示

- 默认网关使用 **明文 HTTP**，API 密钥、提示词和参考图在传输中不加密。**请勿在公共网络使用**，仅限隔离内网或可信 VPN。
- 若团队网关已启用 HTTPS，请在应用“设置 → 团队网关基础地址”中切换。
- API 密钥仅保存在本机系统凭据库，不会写入配置文件或发布包。

## 校验

附件 `SHA256SUMS` 包含各压缩包的 SHA-256 值。Windows 可用 PowerShell 核对：

```powershell
Get-FileHash -Algorithm SHA256 -Path ugc-image-tool-0.1.0-win-x64.zip
```
