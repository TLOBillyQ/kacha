<!--
发布说明模板。复制为 docs/release/release-notes-<版本>.md 后把 {{版本}} 全部替换为实际版本号，
并填写「本版变化」。publish_release.py 会把该文件全文作为 Gitea Release 正文。
本模板不是已发布记录。#14 首次迁移目标待首个带 updater 签名的正式版发布；
复制时按实际产物与验收证据填写，不把待验证项写成已通过。
-->

# Kacha {{版本}}

本地 AI 图片生成与编辑客户端（画板版）。Windows 下载 NSIS 安装器按当前用户安装；
macOS 首次安装仍下载 zip，解压后把应用拖入「应用程序」。

## 本版变化

- {{变化 1}}
- {{变化 2}}

## 下载

| 附件 | 适用平台 | 说明 |
| --- | --- | --- |
| `kacha-{{版本}}-win-x64-setup.exe` | Windows 10 21H2+ / Windows 11（x64） | 按当前用户安装，支持首次安装与后续自动更新 |
| `kacha-{{版本}}-macos-arm64.zip` | macOS（仅 Apple Silicon） | 内含 `Kacha.app` |
| `SHA256SUMS` | 双端 | 全部发布产物的 SHA-256 校验值 |

## 校验下载文件

把安装器或压缩包与 `SHA256SUMS` 下载到同一目录后核对。

Windows（PowerShell），将输出与 `SHA256SUMS` 中对应行比较（大小写不敏感）：

```powershell
Get-FileHash -Algorithm SHA256 -Path .\kacha-{{版本}}-win-x64-setup.exe
```

macOS（终端，未下载的另一平台压缩包会报“文件不存在”，忽略即可）：

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## Windows

1. 运行 `kacha-{{版本}}-win-x64-setup.exe`，按当前用户安装，通常不需要管理员权限。
   旧免安装版用户需要手动安装一次。用同一用户安装，沿用现有设置、系统凭据中的 API 密钥、
   画板、任务目录、生成结果及输出根目录。
2. **WebView2**：本应用依赖 Microsoft Edge WebView2 运行时，Windows 10 21H2 及以上与 Windows 11 均已预装。
   若机器上缺失，启动时会弹窗说明，并给出官方下载地址
   <https://developer.microsoft.com/microsoft-edge/webview2/>，安装「常青版运行时」后重新打开即可。
3. **SmartScreen**：本软件未做代码签名，首次运行可能提示“Windows 已保护你的电脑 / 未知发布者”，
   点「更多信息」→「仍要运行」。若安装器因浏览器下载标记被拦截，也可以右键安装器 →「属性」→
   勾选「解除锁定」→「确定」后再运行。该放行只在核对团队 Gitea 与 SHA256 后进行。
4. **打开画板**：在应用内的画板列表中打开，或把 `.ugcboard.json` 文件拖到应用窗口 / `kacha.exe` 图标上。
   不支持双击画板文件打开（系统会把它当作普通 `.json` 文件）。

## macOS（仅 Apple Silicon）

1. 在「访达」中双击解压 `kacha-{{版本}}-macos-arm64.zip`，把 `Kacha.app` 拖入「应用程序」。
   Intel 芯片的 Mac 不受支持。
2. **Gatekeeper**：本软件仅 ad-hoc 签名、未经 Apple 公证，首次启动会被拦截。任选一种方式放行一次：
   - 在「应用程序」中右键（或按住 Control 点按）应用图标 →「打开」→ 在弹窗中再点「打开」；
   - 或先双击一次被拦截后，打开「系统设置」→「隐私与安全性」，在页面下方点「仍要打开」；
   - 或在终端执行：

     ```sh
     xattr -dr com.apple.quarantine "/Applications/Kacha.app"
     ```
3. **打开画板**：在应用内的画板列表中打开，或把 `.ugcboard.json` 文件拖到应用窗口 / 程序坞图标上。不支持双击画板文件打开。

macOS 真机安装、迁移与自动更新未验收，不在本次 #14 交付范围内；保留构建与发布分支及相关脚本测试。

## 自动更新与故障恢复

- 现有 HTTP Gitea 与团队网关只用于可信内网或 VPN，不提供传输加密。
- 应用启动 3 秒后及每 6 小时自动检查，也可在「高级设置」手动检查。发现更高正式版后后台下载，
  顶栏与高级设置展示进度、版本及更新说明；检查或下载失败可重试。
- 下载并通过 updater 签名验证后，由你点击「重启并更新」。任务队列非空时阻止更新；
  任务结束不自动重启。全部已打开画板与界面状态保存成功后才安装，保存失败不安装、不重启并恢复操作。
- 安装失败或目录不可写时，从本版 Gitea Release 手动下载安装器或 macOS zip；应用不会自动提权。
  新版无法启动时从 Gitea 下载此前可用版本，按该版说明手动恢复。首版不提供自动回滚。

Updater 签名独立于操作系统代码签名与公证，不能代替首次 SmartScreen / Gatekeeper 手动放行。
完整迁移及恢复步骤见仓库中的 `docs/release/auto-update-user-guide.md`。

## 数据位置与问题反馈

- 设置与日志保存在系统的应用数据目录中（不在程序目录里），覆盖升级不会丢失。
- 遇到问题时，在应用「高级设置」底部点「导出诊断包…」，把导出的文件发给维护者。
  诊断包导出时会再做一次脱敏，不包含 API 密钥。
