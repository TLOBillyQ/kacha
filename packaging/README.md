# 发布打包与分发（v2）

把 v2 Tauri 客户端构建为官方 updater 可安装的双端发布物，并经
`publish_release.py` 发布到 Gitea Release。Windows 使用按当前用户安装的 NSIS 安装器；
macOS（Apple Silicon）保留首次安装 zip，并发布官方 updater 使用的 `.app.tar.gz`。
分发与 updater 决策见 `docs/adr/0007-gitea-release-as-sole-distribution-channel.md`、
`docs/adr/0017-tauri-official-updater-for-desktop-updates.md`。脚本只依赖 Python 3.11+ 标准库。

## 发布产物

Gitea Release（tag `v<版本>`）按平台挂以下附件：

    kacha-<版本>-win-x64-setup.exe          # NSIS，当前用户安装；首次安装与更新共用
    kacha-<版本>-win-x64-setup.exe.sig      # updater minisign 签名
    updater-win-x64.json                    # Windows 平台描述
    kacha-<版本>-macos-arm64.zip            # 内含 Kacha.app（ad-hoc 签名，首次安装）
    kacha-<版本>-macos-arm64.app.tar.gz     # macOS updater 更新包
    kacha-<版本>-macos-arm64.app.tar.gz.sig # updater minisign 签名
    updater-macos-arm64.json                # macOS 平台描述
    SHA256SUMS                              # 覆盖实际发布产物

平台描述采用 Tauri 静态 JSON 协议，只声明本端平台键：
`windows-x86_64` 或 `darwin-aarch64`；每个平台集合中的描述最后发布，重复发布时先撤下本端旧描述，
完成附件替换后重新发布。描述里的 `url` 使用 Gitea 附件上传后返回的 `browser_download_url`，
`signature` 是 `.sig` 文件的原始 base64 文本。

本地输出在仓库根目录 `release/`（已被 .gitignore 忽略）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `release_meta.py` | 版本号唯一来源（`client/src-tauri/Cargo.toml`，`tauri.conf.json` 若有 version 必须一致）、产物命名、SHA256SUMS 工具 |
| `build_release.py` | 在目标机器上 `npm ci` + `npx tauri build`，收集安装器、官方更新包与签名；macOS 校验应用签名后用 `ditto` 制作首次安装 zip，写 SHA256SUMS |
| `publish_release.py` | 创建或复用 tag `v<版本>` 的 Release，核对后上传/替换附件，SHA256SUMS 与远端合并 |
| `tests/` | 标准库 unittest（临时目录 + 内存假 Gitea，不联网） |

## 用法

日常本地打包在 `client/` 下执行：

    npm run build:desktop

该入口使用 Rust dev/debug profile（`tauri build --debug --config src-tauri/tauri.dev.conf.json`），
默认安装包位于 `client/src-tauri/target/debug/bundle/`；不生成 updater 更新包与签名。
前端仍执行 `npm run build`，让安装包内含可独立运行的静态资源。
`npm run tauri -- dev` 用于交互开发，不生成安装包。

正式发布才使用 release 构建。在 `client/` 下执行 `npm run build:release`，
或在仓库根目录执行 `packaging/build_release.py`；继续使用 release 优化及 updater 签名发布产物。

发版前在 `client/src-tauri/Cargo.toml` bump 版本。Tauri 不能交叉构建，两个平台各在对应机器上执行：

    python3 packaging/build_release.py            # 自动识别 win-x64 / macos-arm64，其他机器拒绝
    python3 packaging/build_release.py --skip-npm-ci

    export GITEA_TOKEN=***                        # Windows PowerShell：$env:GITEA_TOKEN = "***"
    python3 packaging/publish_release.py          # 可重复执行，幂等合并到同一 Release

Tauri 原始产物与本脚本输出名称不同。Windows 从
`client/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Kacha_<版本>_x64-setup.exe`
及其 `.sig` 复制到 `release/kacha-<版本>-win-x64-setup.exe(.sig)`。
macOS 从 `client/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/` 收集
`Kacha.app` 同目录的 `Kacha.app.tar.gz` 与 `Kacha.app.tar.gz.sig`，复制并命名为
`release/kacha-<版本>-macos-arm64.app.tar.gz(.sig)`；首次安装 zip 是
`release/kacha-<版本>-macos-arm64.zip`。

`bundle.macOS.signingIdentity: "-"` 让 Tauri 在生成 updater archive 前完成 ad-hoc 签名。
构建脚本随后只执行 `codesign --verify --deep --strict`，不重新签名应用或重建 updater archive，
使首次安装 zip 与更新包使用同一份已签名应用；updater archive 与 `.sig` 按字节原样复制。
依据为 Tauri CLI 2.11.4 官方源码：
[macOS 应用签名](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/macos/app.rs)、
[bundler 顺序](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs)、
[macOS updater 归档路径](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/updater_bundle.rs)、
[CLI updater 签名](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-cli/src/bundle.rs)。

## updater 签名密钥

两端共用一套长期、无密码的 minisign 密钥。密钥生成一次并保存在当前用户目录下的项目专用位置：

    # Windows PowerShell；macOS/Linux 用 ~/.kacha/updater/signing.key
    $env:USERPROFILE\.kacha\updater\signing.key

公钥已内置 `client/src-tauri/tauri.conf.json`；私钥绝不提交仓库、不写入日志或聊天。Windows 构建机的
私钥复制到 macOS 构建机的同一相对位置后，两端分别设置：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.kacha\updater\signing.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
```

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.kacha/updater/signing.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

密钥文件应随项目发布材料备份到受限位置；丢失后必须更换公钥并发布一次只供手动安装的新版本。

发布前需先按 `docs/release/release-notes-template.md` 撰写 `docs/release/release-notes-<版本>.md`，
其全文即 Release 正文与 updater 更新说明。更新说明只写本版变化摘要，连同标题控制在 200 字以内；
安装、系统放行、校验与故障恢复步骤保留在 `docs/release/auto-update-user-guide.md`，不重复写进更新说明。
发布脚本的安全闸门：token 只从环境变量读取；`release/`
有其他版本的发布产物、缺少 updater 签名、SHA256SUMS 不一致或未列出本端发布集合、缺少发布说明时，
一律不发起任何上传。

## 测试

在仓库根目录执行：

    python3 -m unittest discover -s packaging/tests

构建测试通过完整 `build_release.main()` 调用，在临时仓库中模拟 subprocess 生成官方目录布局的
Windows NSIS 与 macOS `.app`、`.app.tar.gz`、`.sig`，核对收集、重命名及 SHA256SUMS；
macOS 测试还比较首次安装 zip 与更新包内的应用内容，捕获归档后重新签名造成的分歧。
这些是假产物测试，不验证真实 codesign、minisign、macOS 扩展属性或安装更新。
发布测试使用内存假 Gitea，不执行真实上传；macOS 真机安装、迁移及自动更新未验收。

## 用户侧提示（见用户指南）

- Windows 安装器未购买代码签名：SmartScreen「更多信息 → 仍要运行」；按当前用户安装，
  通常不需要管理员权限；依赖 WebView2（Win10 21H2+/Win11 预装）。
- HTTP Gitea 只在可信内网或 VPN 使用；updater 显式允许非 HTTPS 端点，但强制验证 minisign 签名。
- 打开画板：在应用内画板列表中打开，或把 `.ugcboard.json` 文件拖到应用窗口 / exe 图标上。不登记双击关联：系统按最后一段扩展名识别文件，`.ugcboard.json` 会被当作 `.json`，登记即抢占所有 JSON 文件。
- macOS 包仅 ad-hoc 签名、未公证、只支持 Apple Silicon：首次右键「打开」。

完整验收流程见 `docs/release/release-checklist.md`。
