# 发布打包（issue #13）

把 UGC AI 生图工具构建为 **Windows 10/11 x64 便携版**：PyInstaller 目录
模式 + 版本号压缩包 + Windows 代码签名 + SHA-256 校验值 + 无密钥发布检查。

## 文件

| 文件 | 作用 |
| --- | --- |
| `ugc-image-tool.spec` | PyInstaller 目录模式规格；版本号驱动构建与压缩包命名 |
| `build_release.py` | 一键构建/签名/压缩/校验值/发布检查 |
| `verify_release.py` | 无密钥扫描 + SHA256SUMS 核对（CLI） |
| `security_scan.py` | 扫描规则与校验工具（纯标准库，可被测试复用） |
| `sign.ps1` | Authenticode 签名（优先 signtool，退回 PowerShell） |

## 用法

    # 安装构建依赖
    .venv\Scripts\python.exe -m pip install -e .[test] pyinstaller

    # 开发构建（不签名）
    .venv\Scripts\python.exe packaging/build_release.py --skip-sign

构建默认把最新便携目录覆盖同步到 `Desktop\dev\ugc-image-tool\`，开发时直接双击
运行（目标里的 exe 正在运行时需先关闭再构建）。正式发布或不需要本地副本时加
`--skip-dev-deploy` 跳过。

    # 正式发布（团队证书）
    $env:UGC_IMAGE_TOOL_CERT = "C:\cert\team.pfx"
    $env:UGC_IMAGE_TOOL_CERT_PASSWORD = "***"
    .venv\Scripts\python.exe packaging/build_release.py

产物：

    release/
      work/                       # PyInstaller 中间产物（gitignored）
      ugc-image-tool-<v>-win-x64/ # 便携目录
      ugc-image-tool-<v>-win-x64.zip
      SHA256SUMS
      build-info.json

## 验收

- 完整验收运行手册：`docs/release/release-checklist.md`。
- 发布说明：`docs/release/release-notes-0.1.0.md`。
- 无密钥检查自动化测试：`tests/test_release_security.py`。

## 说明

- 目录模式保证目标机器无需 Python；应用不写程序目录，用户数据位于
  LocalAppData/图片目录，因此整体覆盖升级安全。
- 是否签名在 `build-info.json` 的 `signed` / `signature_status` 中记录；
  未签名包仅供开发验证，SmartScreen 会提示“未知发布者”。
- 提供 `--cert` 时，签名完成后会强制校验签名状态必须为 `Valid`，否则
  构建失败；正式发布必须用团队证书构建并确认 build-info.json 记录。
