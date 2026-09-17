# 发布打包与分发（v2）

把 v2 Tauri 客户端构建为 Windows 10/11 x64 免安装包与 macOS（Apple Silicon）`.app`，
经 `publish_release.py` 发布到 Gitea Release 供团队下载。分发决策见
`docs/adr/0007-gitea-release-as-sole-distribution-channel.md`，规格见 `docs/v2-spec.md` §13。
脚本只依赖 Python 3.11+ 标准库。

## 发布产物

Gitea Release（tag `v<版本>`）只挂三个附件：

    ugc-image-tool-<版本>-win-x64.zip      # 内含单个 ugc-image-tool.exe
    ugc-image-tool-<版本>-macos-arm64.zip  # 内含 UGC AI 生图工具.app（ad-hoc 签名）
    SHA256SUMS

本地输出在仓库根目录 `release/`（已被 .gitignore 忽略）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `release_meta.py` | 版本号唯一来源（`client/src-tauri/Cargo.toml`，`tauri.conf.json` 若有 version 必须一致）、产物命名、SHA256SUMS 工具 |
| `build_release.py` | 在目标机器上 `npm ci` + `npx tauri build`，Windows 压 exe、macOS 签名后 `ditto` 压 `.app`，写 SHA256SUMS |
| `publish_release.py` | 创建或复用 tag `v<版本>` 的 Release，核对后上传/替换附件，SHA256SUMS 与远端合并 |
| `tests/` | 标准库 unittest（临时目录 + 内存假 Gitea，不联网） |

## 用法

发版前在 `client/src-tauri/Cargo.toml` bump 版本。Tauri 不能交叉构建，两个平台各在对应机器上执行：

    python3 packaging/build_release.py            # 自动识别 win-x64 / macos-arm64，其他机器拒绝
    python3 packaging/build_release.py --skip-npm-ci

    export GITEA_TOKEN=***                        # Windows PowerShell：$env:GITEA_TOKEN = "***"
    python3 packaging/publish_release.py          # 可重复执行，幂等合并到同一 Release

发布前需先按 `docs/release/release-notes-template.md` 撰写 `docs/release/release-notes-<版本>.md`，
其全文即 Release 正文。发布脚本的安全闸门：token 只从环境变量读取；`release/` 有其他版本的
压缩包、SHA256SUMS 不一致或未列出本地压缩包、缺少发布说明时，一律不发起任何上传。

## 测试

在仓库根目录执行：

    python3 -m unittest discover -s packaging/tests

## 用户侧提示（必须写入发布说明）

- Windows 包未签名：SmartScreen「更多信息 → 仍要运行」；依赖 WebView2（Win10 21H2+/Win11 预装）。
- Windows 无安装器：`.ugcboard.json` 双击关联需用户手动「打开方式」设置。
- macOS 包仅 ad-hoc 签名、未公证、只支持 Apple Silicon：首次右键「打开」。

完整验收流程见 `docs/release/release-checklist.md`。
