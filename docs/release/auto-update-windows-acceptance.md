# Windows 自动更新验收记录

记录日期：2026-10-09。对应 #3 与 #14，文档切片基于集成提交 `c937707`。本文区分基线自动测试、真实旧版启动事实及尚待补齐的安装更新证据，不以模拟测试代替真机验收。

当前结论：**Windows 完整迁移与自动更新尚未验收通过**。迁移目标待 Gitea 首个带 updater 签名的正式版发布，本次未真实发布、未关闭 Issue。本文的 signed 指 Tauri updater 签名，不指 Windows 代码签名证书或 Apple 公证。

## 已知环境与旧版事实

以下环境及旧版事实由本次集成主执行者提供，文档执行者未重新运行 GUI：

| 项目 | 已知值 / 观察 |
| --- | --- |
| 系统 | Windows 11，OS build 26220 |
| 旧版 | 真实 Gitea 免安装版 `v0.2.2` |
| 下载与启动 | 旧版 zip 已下载，解压出的 exe 已成功启动 |
| zip SHA256 | `2b085fdcaffa318f587b22b9b79fc8d2722cacb80290ccec6f45e42c6dd44cfa` |
| exe SHA256 | `6660737212ad67b78be251e3d23ca81778e52472777886f76c65cf3290e1c9dd` |
| GUI 边界 | 用户按 Esc 停止 GUI 操作，之后不再使用 GUI |
| 后续验收范围 | 基线签名 NSIS 已构建；签名 / 篡改结果与 CLI 静默安装及隐藏启动结果见下文，完整在线升级未实测 |

成功启动只证明旧版程序可启动，不证明首次迁移、系统凭据保留、数据恢复或自动更新通过。SmartScreen 实际放行、旧版数据样本与截图 / 日志证据未在本切片中补测。

## 基线 NSIS 构建产物

主执行者已报告 `0.2.2` 基线签名 NSIS 构建成功。产物位于主工作区
`.scratch/auto-update/installer-baseline`，包含以下三个文件；这是本地验收材料，未作为真实 Release 发布。
它与 Gitea 上原有 `v0.2.2` 免安装 zip 是不同产物，不能据此认定旧正式版已支持 updater。

| 文件 | SHA256 / 核对结果 |
| --- | --- |
| `kacha-0.2.2-win-x64-setup.exe` | `d9fa98fe9013825d451e9bf8ae91171649df958f18a8898a89e7e642fe339f91` |
| `kacha-0.2.2-win-x64-setup.exe.sig` | `51475afa1503c7e0672785e2d608fd445840f3e98e2ea7368380d714e52272a7` |
| `SHA256SUMS` | 包含上述两项；文档执行者通过 `Get-FileHash -Algorithm SHA256` 核对，两项均一致 |

文件存在与 SHA256 一致只证明本地产物清单一致。主代理另已运行 signature-check Cargo harness，报告
`verified installer using embedded public key; corrupted copy rejected`。
该结果证明 harness 使用内置公钥验证了原安装器，并拒绝篡改副本；它不是官方 updater 在线下载或安装流程的实测。
此结果来源于主代理报告，文档执行者未重复运行 harness。

## CLI 当前用户安装与进程启动实测

文档执行者于 2026-10-09 执行本节，文档分支起点为 `87f8433`。真实安装器仍是上述本地 `0.2.2` 基线产物，
实际构建提交及完整工具链记录尚待主代理补齐。没有使用 GUI 或真实发布。

### 备份与安装前保护

安装前无 `kacha` 进程，HKCU 中无 Kacha 卸载记录。执行账户的 Windows token
`IsInRole(Administrator)` 为 `false`，未使用 `RunAs`。
对 Roaming 和 Local 两个 `local.ugc.image-tool.v2` 目录中的全部既有文件执行备份并逐文件核对 SHA256，
共 783 个文件、101408308 字节；未打印文件内容。

Roaming appdata 中实际只有以下三个文件，**没有 `settings.json`**：

| 文件 | 安装前 SHA256 |
| --- | --- |
| `models-cache.json` | `d9000b436a46011b23529395ded82692d600b5e967f55c841354286e24428231` |
| `ui-state.json` | `4e569ab36c5fd78a41845661f29c6a50c0337f951d1462b27ce0a817da225228` |
| `diagnostics.log` | `3d29d02c1b7aa13c274b5afb48fbbada162cbda1b850ed1c61a1c9de74287a10` |

没有调用凭据读写工具，也没有填写或保存高级设置。没有设置文件及可验证的已保存 API 密钥样本，
所以本次**不能声称实际密钥或高级设置迁移通过**。

### 静默安装证据

在 20:53:23 至 20:53:25（Asia/Shanghai）通过 `Start-Process -WindowStyle Hidden` 运行安装器，
参数为 `/S /NS /D=<当前用户安装目录>`。`/S` 静默安装，`/NS` 避免创建快捷方式；
未传 `/R`，安装结束不启动应用。使用独立可写目录，验收后仅卸载这次创建的基线测试安装。

| 项目 | 实测结果 |
| --- | --- |
| 安装目录 | `%LOCALAPPDATA%\Programs\Kacha-Issue14-Acceptance` |
| 安装器退出码 | `0` |
| 安装配置 | 生成的 NSIS 脚本为 `INSTALLMODE currentUser`，`RequestExecutionLevel user` |
| 文件 | `kacha.exe` 与 `uninstall.exe` 均存在 |
| 安装后 exe SHA256 | `74db035492c8c7bc40be3ffe40abefd74155629eb2541969be6ffccfea45f213` |
| exe ProductVersion / FileVersion | 均为 `0.2.2` |
| HKCU 注册表 | `Software\Microsoft\Windows\CurrentVersion\Uninstall\Kacha` |
| 注册表 DisplayName / DisplayVersion | `Kacha` / `0.2.2` |
| 注册表 InstallLocation / UninstallString | 指向上述安装目录及其中的 `uninstall.exe` |
| HKLM 注册表 | 64 位及 WOW6432Node 卸载路径均无 Kacha 记录 |
| 安装后进程 | 无 `kacha` 进程 |
| 安装后 appdata 核对 | 783 个文件的相对路径、长度、SHA256 全部与安装前一致；差异为 0 |

以上支持非管理员账户的当前用户静默安装及安装过程保留既有 appdata 的结论。
这是旧 portable `v0.2.2` 到本地 NSIS 基线 `0.2.2` 的首次安装路径检查，不是版本升级或完整数据迁移验收。

### 新旧 exe 隐藏启动证据与清理

分别启动主工作区 `.scratch/auto-update/old-portable/kacha.exe` 与安装后的 `kacha.exe`，
均使用 `Start-Process -WindowStyle Hidden`，没有 GUI 交互。各观察 8 秒，进程仍存活且进程路径与对应 exe 一致；
stdout / stderr 均为 0 字节。随后仅停止本次启动的进程，最终无 `kacha` 进程。

该观察证明两个 exe 能创建并维持进程，不证明界面正常、网关连接成功、画板恢复或系统凭据可用。
启动后 `ui-state.json` SHA256 不变；诊断日志与模型缓存发生变化。保留启动后的日志及缓存证据，
并将本次启动改变的模型缓存从备份恢复，其 SHA256 再次等于安装前值。
诊断日志保留测试新增记录，`settings.json` 仍不存在，真实设置及凭据未被手动覆盖。

### 隔离安装卸载与数据保留

21:01:53（Asia/Shanghai）再次核对 HKCU 的 `InstallLocation`，去除注册表字符串外围引号并解析绝对路径后，
与 `%LOCALAPPDATA%\Programs\Kacha-Issue14-Acceptance` 精确匹配；`UninstallString` 同样指向该目录。
安装前已确认无既有 Kacha 安装记录。仅卸载本次创建的隔离安装，没有删除真实用户数据。

将卸载器复制到本地证据目录并核对 SHA256 一致后，通过 `Start-Process -WindowStyle Hidden` 执行
`/S _?=<上述隔离目录>`。复制的卸载器直接执行，便于取得实际退出码并移除安装目录中的原卸载器。
退出码为 `0`，隔离安装目录及 HKCU Kacha 卸载记录均已不存在，未给用户留下基线测试应用。

卸载前后对 Roaming appdata 的 3 个文件、Local appdata 的 783 个文件及默认输出根目录的 122 个文件
逐一比较相对路径、长度和 SHA256，共 908 个文件，差异为 0。appdata 与输出数据均保留，
`settings.json` 仍不存在。主工作区的原签名安装包、`.sig`、`SHA256SUMS` 及本地备份保留。
这里证明的是卸载未改动这些文件，不证明画板或生成结果已在新版界面恢复。

本地证据保存在文档 worktree 的 `.scratch/windows-cli-acceptance-20261009-205218/`：
`before-manifest.json`、`after-install-manifest.json`、`after-install-data-check.json`、
`install-result.json`、`launch-results.json`、`after-launch-roaming-check.json`、
`final-process-check.json`、`post-launch-limitations.json`、`restoration-result.json`、
`uninstall-preflight.json`、`uninstall-result.json`、`before-uninstall-manifest.json`、
`after-uninstall-manifest.json`、`uninstall-data-check.json` 及备份 / 日志。
这些材料含本机路径与私有数据备份，未提交到仓库，也未打印内容；主代理可在本机复查。

## 自动测试基线

以下是主执行者提供的既有基线，不是本文执行者在最新集成提交上重新跑出的结果：

| 测试类别 | 已报告基线 | 当前证据边界 |
| --- | --- | --- |
| Vitest | 845 | 基线已报告；后续 worker 最新结果未核验 |
| Rust | 44 | 基线已报告；后续 worker 最新结果未核验 |
| packaging | 33 | 基线已报告；后续 worker 最新结果未核验 |
| 浏览器 E2E | 43 | 基线已报告；后续 worker 最新结果未核验，不等同桌面安装更新实测 |

后续测试必须另记实际提交、命令、通过 / 失败数量与日志位置。不要将上述数量标作最新集成测试结果，也不要把自动测试覆盖写成 Windows 真机通过。

## 待补 Windows 证据

下表记录已取得证据的边界及剩余项目。当前仅取得签名 harness、静默安装、appdata 哈希与隐藏进程启动证据；
**完整在线升级未实测**。GUI 不再操作，无法观察的行为保留待验证或明确证据限制。

| 验证项 | 需要补齐的实际证据 | 状态 |
| --- | --- | --- |
| 构建元信息与签名 / 篡改验证 | 基线构建及 SHA256 已记录；签名通过与篡改拒绝由主代理 harness 报告，构建提交及完整工具链仍待补齐 | 部分完成 |
| 当前用户安装 | 非管理员 token 下 `/S` 安装退出码 0，HKCU / 文件版本为 `0.2.2`，无 HKLM 记录；隐藏启动只验证进程存活 | CLI 范围通过 |
| 旧免安装版首次迁移 | 安装后既有 appdata 的 783 个文件哈希全部不变；portable 与 NSIS 基线均为 `0.2.2`。无 `settings.json`，未验证实际密钥、高级设置及系统凭据可用性 | 部分完成 |
| 画板与输出保留 | 迁移前后画板、任务目录及生成结果样本可用性；凭据证据须脱敏 | 待验证 |
| 更新端点与发现 | 已安装旧版到更高正式版的平台描述、版本匹配、更新包地址、签名、更新说明与 HTTP 可信网络环境；自动 / 手动检查观察 | 待验证 |
| 后台下载与用户点击 | 实际下载状态 / 进度、签名通过、仅下载不安装；用户点击才安装和重启；任务结束不自动重启 | 待验证 |
| 队列保护 | 排队、执行中、限流退避及读取参考图时分别阻止更新；准备期间新提交与修改被阻止，包括已开始的异步操作 | 待验证 |
| 严格保存与恢复 | 全部已打开画板及界面状态写入成功；更新后版本、全部已打开画板、活动画板及界面状态恢复 | 待验证 |
| 保存错误 | 画板写入、此前失败 / 正在进行的写入及界面状态保存失败的可复现证据；不安装、不重启并恢复操作 | 待验证 |
| 下载 / 签名错误 | 可复现失败、实际错误与重试；校验失败不就绪、不安装 | 待验证 |
| 安装 / 目录权限错误 | 可复现的错误、手动下载入口及不自动提权；记录插件无法观测的安装器 / 新版启动结果限制 | 待验证 |
| 旧版手动恢复 | 从 Gitea 获取旧版的实际恢复步骤、版本与数据核对；不宣称自动回滚 | 待验证 |

更新端点应使用获授权的测试材料，测试记录明确区分本地 / 测试端点和真实 Gitea 正式 Release。本切片不上传真实 Release，也不把待发布的迁移目标写为已上线。

## 主执行者补证格式

每项使用以下字段追加实际结果；没有观察到的行为写「未观察」，不要用安装进程成功退出推断新版恢复成功。

| 字段 | 待填写内容 |
| --- | --- |
| 验证项与日期 | 对应上表行，实际执行时间 |
| 提交与版本 | 构建 / 测试提交，迁移前后或更新前后版本 |
| 环境与产物 | Windows 账户范围、安装目录、产物名、SHA256、端点性质 |
| 操作与结果 | CLI 命令或已获授权的操作，退出码、实际观察、通过 / 失败 / 未观察 |
| 证据 | 可复查且脱敏的日志或材料位置 |
| 限制与后续 | 未覆盖的行为、无法可靠触发的失败、所需补证 |

## macOS 范围

macOS 真机安装、迁移和自动更新**未验收**。本次不执行这些验证，也不将它们列为 #14 的完成条件。保留 macOS 构建与发布分支及可在本机运行的相关脚本测试；脚本通过不代表 macOS 真机验收通过。

Windows 没有购买操作系统代码签名证书，macOS 没有 Apple 公证。Updater 签名不消除首次 SmartScreen / Gatekeeper 手动放行要求，操作说明见 [自动更新用户指南](auto-update-user-guide.md)。
