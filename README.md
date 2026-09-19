# Kacha（咔嚓）

📸 咔嚓一下，图就来了。

面向蛋仔派对与千星 UGC 美术团队的本地图片生成工作台。以节点图画板为主界面：提示词、参考图、生成任务、结果都是画板上的节点，连线表达「这次输入从哪儿来」。生成只经团队网关提交，结果保存在本机。

## 下载与安装

到 [Gitea Releases](http://lzxsvn:3000/qinyuanj/ugc-image-tool/releases) 下载最新版本，解压即用，无需安装：

| 附件 | 适用平台 |
| --- | --- |
| `kacha-<版本>-win-x64.zip` | Windows 10 21H2+ / Windows 11（x64），依赖预装的 WebView2 |
| `kacha-<版本>-macos-arm64.zip` | macOS，仅 Apple Silicon |

两个平台的包都未做正式签名：Windows 首次运行在 SmartScreen 点「更多信息 → 仍要运行」；macOS 首次右键应用「打开」。
校验、放行与画板打开方式详见对应版本的发布说明。

首次启动后在「高级设置」填团队网关地址与 API 密钥即可使用。设置与日志保存在系统应用数据目录，覆盖升级不丢失。

## 主要功能

- **画板**：多画板标签页、框选 / 平移、撤销 / 重做、右键菜单、拖线建节点；画板文件为 `.ugcboard.json`。
- **文生图与图片编辑**：生成任务节点按模型能力露出端口，参考图按「图N」接入；超出模型输入上限时自动缩放。
- **区域指示**：在参考图上框选矩形，按「区域N」分色并在提示词里指代。
- **迭代动作**：以此继续编辑、加为参考图、生成变体，每一步都留下连线，谱系可追溯。
- **图层拆分**：支持的模型可把结果拆为带透明通道的图层。
- **画板包**：把画板连同引用的图片打成单个文件，换机器导入后继续工作。
- **诊断包**：一键导出脱敏日志与设置，不含 API 密钥。
- **检查更新**：启动后自动询问 Gitea 最新版本，有新版时顶栏提示下载；只提示，不自动替换。

内置模型：Seedream 5.0 pro / lite、qwen-image-3.0-pro / qwen-image-3.0。模型能力表内置于客户端，网关只负责转发。

## 文档

- 领域语言：[CONTEXT.md](CONTEXT.md)
- 架构决策：[docs/adr/](docs/adr/)
- 网关契约：[docs/contracts/team-gateway-contract.md](docs/contracts/team-gateway-contract.md)，夹具与冒烟脚本在 `contracts/`
- 模型选型：[docs/model-matrix.md](docs/model-matrix.md)
- 发布流程：[docs/release/release-checklist.md](docs/release/release-checklist.md)、[packaging/README.md](packaging/README.md)
- 需求与缺陷：[Gitea Issues](http://lzxsvn:3000/qinyuanj/ugc-image-tool/issues)

## 开发

客户端为 Tauri 2 + React Flow，位于 `client/`，需 Node、Rust 工具链与 Python 3.11+（打包脚本）：

```bash
cd client
npm ci
npm run tauri dev                                  # 启动桌面客户端
npm test                                           # vitest
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml
cd ..
python3 -m unittest discover -s packaging/tests    # 打包脚本测试
```

发布：在 `client/src-tauri/Cargo.toml` bump 版本，写 `docs/release/release-notes-<版本>.md`，在各目标机器上跑 `packaging/build_release.py` 与 `packaging/publish_release.py`。

## v1

v1 PySide6 客户端（最后发布 `v0.1.0`）已从 main 移除，完整代码、测试、打包脚本与用户手册保存在 [`archive/v1`](http://lzxsvn:3000/qinyuanj/ugc-image-tool/src/branch/archive/v1) 分支，清单见该分支的 `V1-INVENTORY.md`。
