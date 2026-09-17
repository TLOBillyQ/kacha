# 发布验收清单（v2 Tauri 客户端）

分发决策见 `docs/adr/0007-gitea-release-as-sole-distribution-channel.md`，规格见
`docs/v2-spec.md` §13。Gitea Release 只挂三个附件：`ugc-image-tool-<版本>-win-x64.zip`、
`ugc-image-tool-<版本>-macos-arm64.zip`、`SHA256SUMS`，tag 为 `v<版本>`。
执行人逐条勾选，并在末尾「记录」表中留痕。

## 1. 定版本

- [ ] 在 `client/src-tauri/Cargo.toml` 的 `[package] version` bump 版本号（唯一来源）。
      `tauri.conf.json` 若写了 `version`，必须同步为相同值，否则构建/发布脚本直接报错；
      `client/package.json` 的 `version` 建议一并同步。
- [ ] `cargo` 更新 `Cargo.lock` 中本包版本（跑一次下面的 `cargo test` 即可），一起提交。
- [ ] 版本提交已合入 `main`，两台构建机都检出同一提交（记录 `git rev-parse HEAD`）。

## 2. 自动化检查

    cd client
    npm ci
    npm test
    npx tsc --noEmit
    cargo test --manifest-path src-tauri/Cargo.toml
    cd ..
    python3 -m unittest discover -s packaging/tests

- [ ] 以上命令全部通过（Windows 上 `python3` 换成 `python` 或 `py -3`，需 Python 3.11+）。

## 3. 构建（每台目标机器各一次）

Tauri 不能交叉构建，Windows 包在 Windows x64 机器上构建，macOS 包在 Apple Silicon Mac 上构建：

    python3 packaging/build_release.py                # 默认先在 client/ 下 npm ci
    python3 packaging/build_release.py --skip-npm-ci  # 已装好依赖时

- [ ] 构建前 `release/` 中没有旧版本压缩包（脚本会拒绝）。
- [ ] Windows：`release/ugc-image-tool-<版本>-win-x64.zip` 内只有 `ugc-image-tool.exe`。
- [ ] macOS：`codesign --verify --deep --strict` 通过；`release/ugc-image-tool-<版本>-macos-arm64.zip`
      由 `ditto` 生成，访达双击解压后得到 `UGC AI 生图工具.app`。
- [ ] `release/SHA256SUMS` 列出本机压缩包。

## 4. 发布说明

- [ ] 复制 `docs/release/release-notes-template.md` 为 `docs/release/release-notes-<版本>.md`，
      替换 `{{版本}}`、填写本版变化，删除模板头部注释；随版本提交合入。
- [ ] 内容包含：下载表（三个附件）、SHA256 校验命令、WebView2 说明与官方链接、
      SmartScreen「更多信息 → 仍要运行」、macOS Gatekeeper 放行方式、Windows 文件关联手动设置、
      数据位置与诊断导出入口。

## 5. 发布（每台构建机各一次）

    export GITEA_TOKEN=***            # Windows PowerShell：$env:GITEA_TOKEN = "***"
    python3 packaging/publish_release.py

- [ ] 脚本本地核对通过（SHA256SUMS 一致、无其他版本压缩包、发布说明存在）后才上传。
- [ ] 第二台机器发布后，同一 Release 下恰好三个附件，无重复。
- [ ] 重复执行只替换附件，不产生重复。

## 6. 下载核对

在一台干净的机器上从 Gitea Release 页面下载全部附件：

- [ ] Windows：`Get-FileHash -Algorithm SHA256 -Path .\ugc-image-tool-<版本>-win-x64.zip` 与 `SHA256SUMS` 一致。
- [ ] macOS：`shasum -a 256 -c SHA256SUMS --ignore-missing` 显示 `OK`。
- [ ] `SHA256SUMS` 同时包含两个平台的压缩包条目。
- [ ] Release 正文与 `release-notes-<版本>.md` 一致。

## 7. 冒烟测试

### Windows（Win10 21H2+ 与 Win11 各一台为佳）

- [ ] 解压后双击 exe 可启动；SmartScreen 按发布说明「更多信息 → 仍要运行」可放行。
- [ ] 中文路径下解压运行正常；非管理员账户可运行。
- [ ] **WebView2 缺失提示**：在未装 WebView2 的机器（或卸载运行时的虚拟机）上启动，弹窗说明并给出
      <https://developer.microsoft.com/microsoft-edge/webview2/> 链接，不闪退、不白屏。
- [ ] **文件关联**：按发布说明「打开方式 → 选择 exe → 始终使用」后，双击 `.ugcboard.json` 打开对应画板；
      应用已在运行时再次双击的行为符合预期。
- [ ] 文生图、图片编辑、画板保存/重新打开各跑通一次。
- [ ] 覆盖升级：用新 exe 覆盖旧 exe 后，设置、API 密钥与最近画板仍在。

### macOS（Apple Silicon）

- [ ] 访达解压并拖入「应用程序」；右键「打开」或「隐私与安全性 → 仍要打开」可放行。
- [ ] `xattr -dr com.apple.quarantine "/Applications/UGC AI 生图工具.app"` 方式同样有效。
- [ ] **双击打开画板**：应用未运行时在访达双击 `.ugcboard.json`，应用启动并打开该画板
      （走 `RunEvent::Opened`，前端就绪前到达的路径不丢）；应用已运行时再双击另一个文件也能打开。
- [ ] 文生图、图片编辑、画板保存/重新打开各跑通一次。

### 双端

- [ ] **诊断导出**：「高级设置」底部「导出诊断包…」导出成功，导出文件含版本号与日志，
      搜索不到 API 密钥与认证头。
- [ ] 设置与日志位于应用数据目录，程序目录内没有写入任何文件。
- [ ] 性能与包体数字补记到 `docs/release/performance-macos.md`（首次发布或有明显变化时）。

## 8. 记录

| 项目 | 值 |
| --- | --- |
| 发布版本 |  |
| 构建提交（git rev-parse HEAD） |  |
| 构建日期 |  |
| Windows 构建机 / 工具链版本 |  |
| macOS 构建机 / 工具链版本 |  |
| Gitea Release tag / 附件核对 | v<版本>，3 个附件齐全 |
| Win10 冒烟机器 |  |
| Win11 冒烟机器 |  |
| macOS 冒烟机器 |  |
| 发现的问题 |  |
