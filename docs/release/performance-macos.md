# 性能与包体实测（v2 Tauri 客户端）

v2 规格 §13 要求补测 macOS 性能与包体数字；Windows 包体一并记录，便于对比。
**以下表格全部「待在 Apple Silicon 机器上实测」（Windows 行待在 Windows x64 机器上实测），
未实测前不得填写估计值。**

## 测量方法

前提：使用 `packaging/build_release.py` 产出的正式发布包（release 构建），不要用 `tauri dev`。
每项测 5 次，去掉最大最小值后取中位数，并记录机器型号、芯片、内存、系统版本。

1. **冷启动到首帧**：重启机器或执行 `sudo purge` 后等待 1 分钟；用秒表或录屏（60fps）从双击
   `.app` 开始计时，到主窗口画板区域首次完整绘制为止。Windows 同法，从双击 exe 开始计时。
2. **空闲内存（RSS）**：启动后打开空画板，静置 60 秒，记录应用全部相关进程 RSS 之和：
   macOS 用「活动监视器」（“内存”列，含 WebKit `WebContent` 等子进程），或
   `ps -axo rss,comm | grep -i -E 'ugc|WebKit'`（单位 KB）；
   Windows 用任务管理器「详细信息」页中 `ugc-image-tool.exe` 与其 `msedgewebview2.exe` 子进程的「内存（专用工作集）」之和。
3. **50 节点画板内存（RSS）**：打开含 50 个图片节点的 `.ugcboard.json`（图片分辨率记录在备注中），
   等缩略图全部加载完成后静置 60 秒，按第 2 步方法记录。
4. **`.app` 大小**：`du -sh "/Applications/UGC AI 生图工具.app"`。
5. **zip 大小**：`ls -l release/ugc-image-tool-<版本>-macos-arm64.zip`；
   Windows：`(Get-Item release\ugc-image-tool-<版本>-win-x64.zip).Length` 与
   `(Get-Item client\src-tauri\target\release\ugc-image-tool.exe).Length`。

## 结果

测试版本：待填　测试提交：待填

### macOS（Apple Silicon）— 待在 Apple Silicon 机器上实测

| 指标 | 数值 | 备注 |
| --- | --- | --- |
| 冷启动到首帧 |  | 待在 Apple Silicon 机器上实测 |
| 空闲 RSS |  | 待在 Apple Silicon 机器上实测 |
| 50 节点画板 RSS |  | 待在 Apple Silicon 机器上实测 |
| `.app` 大小 |  | 待在 Apple Silicon 机器上实测 |
| zip 大小 |  | 待在 Apple Silicon 机器上实测 |

机器：待填（型号 / 芯片 / 内存 / macOS 版本）

### Windows x64 — 待在 Windows x64 机器上实测

| 指标 | 数值 | 备注 |
| --- | --- | --- |
| 冷启动到首帧 |  | 待实测 |
| 空闲 RSS |  | 待实测 |
| 50 节点画板 RSS |  | 待实测 |
| exe 大小 |  | 待实测 |
| zip 大小 |  | 待实测 |

机器：待填（型号 / CPU / 内存 / Windows 版本 / WebView2 版本）
