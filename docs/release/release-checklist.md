# 发布验收清单：Windows 便携版交付（issue #13）

本文档是 issue #13“交付签名 Windows 便携版本”的验收运行手册。每一项对应
Gitea Issue #13 的一条验收标准，执行人逐条勾选并记录环境与结果。前两节
（构建与签名）是发布流水线步骤，后几节是需要人工执行的验收场景。

> **签名政策更新（ADR 0007）**：经决策，正式版默认**不签名**发布（不购买
> 代码签名证书），分发渠道为 Gitea Release。下文第 2 节与涉及签名的条目
> 已按该决策修订；`sign.ps1` 与 `--cert` 保留为将来购证后的可选路径。

## 0. 名词约定

- **程序目录**：解压/覆盖后存放 `ugc-image-tool-<版本>-win-x64/` 的目录，
  正式发布后保持只读。
- **用户目录**：`%LocalAppData%\\ugc-image-tool\`，保存普通设置、模型
  缓存、个人预设与脱敏日志。
- **图片目录**：`%USERPROFILE%\\Pictures\\UGC AI 生图工具\`，保存生成
  结果与任务记录。
- **凭据库**：当前 Windows 用户的系统凭据库，服务名 `ugc-image-tool`，
  只保存 API 密钥。

## 1. 构建（标准 A：便携目录与压缩包）

在工具机（Windows, Python 3.12 x64）执行：

    .venv\Scripts\python.exe -m pip install -e .[test] pyinstaller
    .venv\Scripts\python.exe packaging/build_release.py --skip-dev-deploy

macOS 包在 Apple Silicon Mac 上执行 `packaging/build_macos.py`。产物布局：

- `release/ugc-image-tool-<版本>-win-x64.zip` /
  `release/ugc-image-tool-<版本>-macos-arm64.zip` 带版本号压缩包。
- `release/SHA256SUMS` 校验值、`release/build-info.json` 构建信息。
- 便携目录、`.app` 与 PyInstaller 中间产物位于 `release/work/`，不发布。

发布：设好 `GITEA_TOKEN` 后运行 `python packaging/publish_release.py`，
脚本重核 SHA256SUMS、创建或复用 tag `v<版本>` 的 Release 并上传两个平台
产物（两端各构建后各跑一次，幂等合并）。

勾选项：

- [ ] 构建模式为 PyInstaller 目录模式（onedir），压包含顶层版本目录。
- [ ] 目标机器无需安装 Python，也无需管理员权限即可运行。
- [ ] `build-info.json` 记录发布版本与构建提交，与压缩包名版本号一致。
      （版本号写入 build-info.json 与发布说明；exe 不额外注入文件版本资源。）

## 2. 签名与校验值（标准 B，已按 ADR 0007 修订）

- [ ] 正式版默认**未签名**发布（决策记录：`docs/adr/0007-…`）；
      `build-info.json` 的 `signed` 为 `false`、`signature_status` 如实记录。
      发布说明必须包含首次运行的 SmartScreen 绕过提示（“未知发布者 →
      仍要运行”）与 macOS Gatekeeper 右键打开提示。
      将来若购证：`build_release.py --cert <团队证书.pfx>`，此时签名状态
      必须为 `Valid` 且带 RFC3161 时间戳，否则构建失败（现有逻辑）。
- [ ] `SHA256SUMS` 与压缩包一同发布（Gitea Release 附件）；接收方可用

      Get-FileHash -Algorithm SHA256 <压缩包>

      核对一致。
- [ ] 发布物、设置、日志、任务记录与测试数据均不含 API 密钥
      （见第 6 节自动化检查）。

## 3. 干净机器端到端验收（标准 C）

使用**干净的 Windows 10 与 Windows 11 x64** 各一台（虚拟机或换机），
系统级净装、未安装 Python。拷贝压缩包到本地，解压后直接双击主程序。

- [ ] 启动：应用带“正在连接网关…”状态启动，任务中心与三个页签可用。
- [ ] 文生图：选择一个已配置模型，输入提示词，提交并得到结果。
- [ ] 图片编辑：添加参考图，提交图片编辑并得到结果。
- [ ] 并发任务：同一客户端连续提交 ≥3 个任务，观察并行执行与排队顺序。
- [ ] 结果操作：对成功/部分成功结果分别执行“保存副本”“复制图片”
      “打开所在目录”，图片能出现在剪贴板与目标目录。

## 4. 环境场景验收（标准 D）

- [ ] **高分屏**：在 150% 与 200% 缩放下启动，界面文字与控件不模糊、
      ToolBar/列表可用，生成结果预览正确。
- [ ] **中文路径**：把压缩包解压到含中文字符的路径（如
      `D:\\美术工具\\UGC 生图\`）并运行；图片输出到含中文的
      “图片/UGC AI 生图工具/”正常。
- [ ] **非管理员用户**：以普通用户（非 Administrators）运行，程序目录
      无写权限时应用仍可启动并完成提交/保存。
- [ ] **Windows 凭据库**：设置页保存 API 密钥后，凭据管理器中出现
      `ugc-image-tool` 条目（类型“Windows 凭据”）；重启应用后密钥仍可读；
      清除后条目消失。
- [ ] **杀毒软件**：常用杀毒软件（Windows Defender 及团队常见 EDR）扫描
      官方发布包（未签名，ADR 0007）不报毒；未签名包更易触发启发式误报，
      若误报，登记误报并向厂商申诉或提交白名单。

## 5. 覆盖升级保留（标准 E）

1. 安装**旧版本**，完成：设置输出根目录/并发上限 → 保存 API 密钥 →
   复制一个内置预设为个人预设 → 生成至少一个成功任务。
2. 关闭旧版本客户端。
3. 用新版本压缩包**整体覆盖**程序目录（删除旧目录后解压新包，或直接覆盖）。
4. 启动新版本。

- [ ] 普通设置（输出根目录、网关地址、并发上限）仍保留。
- [ ] API 密钥仍存在（凭据库不受程序目录影响）。
- [ ] 个人预设仍可选择与编辑。
- [ ] 历史生成结果与任务记录仍可在“图片/UGC AI 生图工具/”中找到并可预览。
- [ ] 旧版本不会残留、新版本启动无报错。

## 6. 无密钥发布检查（标准 F）——自动化

构建完成后自动执行；也可手动运行：

    .venv\Scripts\python.exe packaging/verify_release.py release\ugc-image-tool-<版本>-win-x64 release\ugc-image-tool-<版本>-win-x64.zip --checksums release\SHA256SUMS

- [ ] 扫描便携目录与压缩包：不发现任何 API 密钥、认证头或轮转地址。
- [ ] SHA256SUMS 所列文件全部命中且哈希一致。
- [ ] 抽查：普通设置 `settings.json`、脱敏日志 `diagnostics*.log`、
      任务记录 `task.json` 均不含密钥字段值。
- [ ] 自动化测试 `tests/test_release_security.py` 通过（包含干净/含泄漏
      两方向的 CLI 验证）。

## 7. 发布说明与网络安全声明（标准 G）

- [ ] 发布说明（见 `docs/release/release-notes-0.1.0.md`）明确声明：
      默认网关地址为明文 HTTP，**仅允许**在隔离内网或可信 VPN 中使用；
      网关进入非可信网络前必须先在设置页启用 HTTPS 覆盖地址。
- [ ] 发布说明包含安装/升级步骤、校验值文件说明与已知限制。

## 8. 记录

| 项目 | 值 |
| --- | --- |
| 发布版本 |  |
| 构建提交（git rev-parse HEAD） |  |
| 构建日期 |  |
| Exe 签名状态 | 未签名（默认）/ Valid（购证后） |
| Gitea Release tag / 附件核对 | v<版本>，3 个附件齐全 |
| Win10 验收机器 |  |
| Win11 验收机器 |  |
| 覆盖升级测试结果 | 通过 / 未通过 |
| 杀毒误报登记 |  |
