# 发布打包与分发

把 UGC AI 生图工具构建为 Windows 10/11 x64 与 macOS（Apple Silicon）便携版，
经 `publish_release.py` 发布到 Gitea Release 供团队下载。分发决策见
`docs/adr/0007-gitea-release-as-sole-distribution-channel.md`。

## 发布产物

Gitea Release 只挂三个附件：

    ugc-image-tool-<版本>-win-x64.zip
    ugc-image-tool-<版本>-macos-arm64.zip
    SHA256SUMS

本地 `release/` 顶层只保留 zip 与 `SHA256SUMS`、`build-info.json`；
便携目录、`.app`、PyInstaller 中间产物统一进 `release/work/`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `ugc-image-tool.spec` | PyInstaller 目录模式规格；版本号驱动构建与压缩包命名；macOS 上额外产出 `.app`（BUNDLE） |
| `build_release.py` | Windows 构建/压缩/校验值/发布检查（默认不签名） |
| `build_macos.py` | macOS 构建：`.app` + ad-hoc 签名 + zip + 发布检查 |
| `publish_release.py` | 发布到 Gitea Release：创建或复用 tag `v<版本>`、校验后上传/替换三个附件、写入 release 正文 |
| `verify_release.py` | 无密钥扫描 + SHA256SUMS 核对（CLI） |
| `security_scan.py` | 扫描规则与校验工具（纯标准库，可被测试复用） |
| `sign.ps1` | Authenticode 签名（可选路径，需团队证书时才用） |

## 用法

版本号唯一来源是 `pyproject.toml` 的 `version`，发版前手动 bump；
构建与发布都拒绝 tag 与包内版本号不一致。PyInstaller 不能交叉编译，
两个平台必须各在对应机器上构建。

    # Windows 工具机：构建（默认不签名）
    .venv\Scripts\python.exe -m pip install -e .[test] pyinstaller
    .venv\Scripts\python.exe packaging/build_release.py --skip-dev-deploy

    # macOS（Apple Silicon）：构建
    .venv/bin/pip install -e .[test] pyinstaller
    .venv/bin/python packaging/build_macos.py

    # 任一端构建完成后发布（可重复执行，幂等合并到同一 release）
    $env:GITEA_TOKEN = "***"          # Windows；macOS 用 export
    python packaging/publish_release.py

发布脚本先重核 `SHA256SUMS`，不通过拒绝上传；token 只从环境变量读取。
release 标题为版本号，正文来自 `docs/release/release-notes-<版本>.md`，
并附 build-info 摘要。

构建默认把最新 Windows 便携目录覆盖同步到 `Desktop\dev\ugc-image-tool\`
供开发自测（`--skip-dev-deploy` 跳过；目标 exe 运行中需先关闭）。

## 用户侧提示（必须写入发布说明）

- Windows 包未签名：首次运行 SmartScreen 提示"未知发布者"，点"仍要运行"。
- macOS 包仅 ad-hoc 签名、未公证、只支持 Apple Silicon：首次启动被
  Gatekeeper 拦截时，右键图标 →"打开"。

## 验收

- 完整验收运行手册：`docs/release/release-checklist.md`。
- 无密钥检查自动化测试：`tests/test_release_security.py`。

## 说明

- 目录模式保证目标机器无需 Python；应用不写程序目录，用户数据位于
  LocalAppData/图片目录（macOS 为对应用户目录），因此整体覆盖升级安全。
- 是否签名在 `build-info.json` 的 `signed` / `signature_status` 中记录。
- `sign.ps1` 与 `--cert` 保留为可选路径：将来若购买团队证书，签名完成后
  仍强制校验签名状态必须为 `Valid`，否则构建失败。
