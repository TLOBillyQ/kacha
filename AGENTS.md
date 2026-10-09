# Agent instructions

默认使用中文与用户沟通；代码、命令、路径和既有技术术语按项目惯例保留原文。

## 构建与打包

日常验证与本地打包使用 dev/debug 构建；正式发布才使用 release 构建。保留 Cargo 默认并行策略。执行桌面打包或发布前，先读 `packaging/README.md` 并使用对应入口。

## Agent skills

### Issue tracker

Issues：创建、读取、更新工作票或推进 wayfinder 地图时，使用 GitHub Issues，并先读 `docs/agents/issue-tracker.md`。

### Domain docs

项目采用 single-context 域文档布局。详见 `docs/agents/domain.md`。
