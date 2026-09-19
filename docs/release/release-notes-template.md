<!--
发布说明模板。复制为 docs/release/release-notes-<版本>.md 后把 {{版本}} 全部替换为实际版本号，
并填写「本版变化」。publish_release.py 会把该文件全文作为 Gitea Release 正文。
-->

# Kacha {{版本}}

本地 AI 图片生成与编辑客户端（画板版）。下载对应平台的压缩包，解压即用，无需安装。

## 本版变化

- {{变化 1}}
- {{变化 2}}

## 下载

| 附件 | 适用平台 | 说明 |
| --- | --- | --- |
| `kacha-{{版本}}-win-x64.zip` | Windows 10 21H2+ / Windows 11（x64） | 内含单个 `kacha.exe` |
| `kacha-{{版本}}-macos-arm64.zip` | macOS（仅 Apple Silicon） | 内含 `Kacha.app` |
| `SHA256SUMS` | — | 上面两个压缩包的 SHA-256 校验值 |

## 校验下载文件

把压缩包与 `SHA256SUMS` 下载到同一目录后核对。

Windows（PowerShell），将输出与 `SHA256SUMS` 中对应行比较（大小写不敏感）：

```powershell
Get-FileHash -Algorithm SHA256 -Path .\kacha-{{版本}}-win-x64.zip
```

macOS（终端，未下载的另一平台压缩包会报“文件不存在”，忽略即可）：

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## Windows

1. 解压 `kacha-{{版本}}-win-x64.zip` 到任意目录（可含中文路径），双击 `kacha.exe` 运行。
   升级时关闭旧版本后直接用新 exe 覆盖即可，设置与日志不在程序目录里，不受影响。
2. **WebView2**：本应用依赖 Microsoft Edge WebView2 运行时，Windows 10 21H2 及以上与 Windows 11 均已预装。
   若机器上缺失，启动时会弹窗说明，并给出官方下载地址
   <https://developer.microsoft.com/microsoft-edge/webview2/>，安装「常青版运行时」后重新打开即可。
3. **SmartScreen**：本软件未做代码签名，首次运行可能提示“Windows 已保护你的电脑 / 未知发布者”，
   点「更多信息」→「仍要运行」。若压缩包是从浏览器下载的，也可以在解压前右键压缩包 →「属性」→
   勾选「解除锁定」→「确定」，再解压运行。
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

## 数据位置与问题反馈

- 设置与日志保存在系统的应用数据目录中（不在程序目录里），覆盖升级不会丢失。
- 遇到问题时，在应用「高级设置」底部点「导出诊断包…」，把导出的文件发给维护者。
  诊断包导出时会再做一次脱敏，不包含 API 密钥。
