# UGC AI 生图工具

面向蛋仔派对与千星 UGC 美术团队的本地图片生成工作台。v2 以节点图画板为主界面（提示词、参考图、生成任务、结果皆为节点），只经团队网关提交生成，结果保存在本机。

v2 正在开发中，规格见 [docs/v2-spec.md](docs/v2-spec.md)，领域语言见 [CONTEXT.md](CONTEXT.md)，决策见 [docs/adr/](docs/adr/)。

## 开发

客户端为 Tauri 2 + React Flow，位于 `client/`：

```bash
cd client
npm install
npm run tauri dev   # 启动桌面客户端
npm test            # vitest
npm run typecheck
```

网关契约夹具与冒烟脚本在 `contracts/`，契约说明见 [docs/contracts/team-gateway-contract.md](docs/contracts/team-gateway-contract.md)。

## v1

v1 PySide6 客户端（最后发布 `v0.1.0`）已从 main 移除，完整代码、测试、打包脚本与用户手册保存在 [`archive/v1`](http://lzxsvn:3000/qinyuanj/ugc-image-tool/src/branch/archive/v1) 分支，清单见该分支的 `V1-INVENTORY.md`。
