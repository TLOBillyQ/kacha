---
name: tea
description: Gitea 工单工作流。用于读取或变更工单、评论与标签，登记台账、待办或悬而未决事项；所有工单读写经 tea（lzxsvn:3000）。
---

# Tea 工单工作流

在仓库目录内执行 `tea`，由 git remote 解析目标仓库。

## 执行流程

1. **读取现状**

   ```bash
   tea issue <idx> --comments -o json
   ```

   完成标准：取得标题、状态、正文、标签和全部评论；需要编辑或删除评论时，同时取得 comment ID。

   长正文工单整体 dump 会被输出截断（含后台任务日志）；只提取所需字段：

   ```bash
   tea issue <idx> -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["body"])'
   ```

2. **执行最小变更**
   - 只传需要变更的字段。
   - 修改正文前保留现有全文；`tea issue edit -d` 会整体替换正文。
   - 多行 Markdown 使用 quoted heredoc。
   - 使用标签前以 `tea labels list -o json` 核对名称。

3. **回读核验**

   ```bash
   tea issue <idx> --comments -o json
   ```

   完成标准：目标字段、状态和评论与请求一致；删除的 comment ID 已不存在；Markdown 结构完整。

## 常用操作

```bash
tea issue list --state all --keyword 关键词 -o json
tea issue create -t "标题" -d "正文" -L 标签1,标签2
tea issue edit <idx> -t "新标题" -d "完整新正文"
tea issue edit <idx> -L 追加标签 --remove-labels 去除标签
tea issue close <idx>
tea issue reopen <idx>

tea comments add <idx> "正文"
tea comments list <idx> -o json
tea comments edit <comment_id> "新正文"
tea comments delete <comment_id>

tea labels list -o json
```

`create` 返回新工单 URL；从 URL 末段取得 `<idx>`，随后按执行流程回读核验。

## 多行正文

```bash
tea issue create -t "标题" -d "$(cat <<'EOF'
## 章节
正文……
EOF
)"
```

`issue create`/`issue edit` 用 `-d` 传正文；`comments add`/`comments edit` 正文是位置参数（无 `-d`，传了报 `flag provided but not defined`）。两类都可用 quoted heredoc 喂多行。

## 必要约定

- `tea issue <idx>` 缺省不含评论；读取完整上下文显式传 `--comments`。
- 评论编辑和删除使用 comment ID，不使用工单号。
- `tea issue edit -L` 追加标签；删除标签使用 `--remove-labels`。
- 机器读取使用 JSON，不解析终端表格或 hyperlink 转义。
- 本实例 assignees 端点 404（`tea issue edit -a` 不可用）；指派走 API：

  ```bash
  tea api -X PATCH -F 'assignees=["<user>"]' /repos/{owner}/{repo}/issues/<idx>
  ```

  `tea api` 的 `-f` 按字符串传值（数组字段报 unmarshal 错）；数组/对象字段用 `-F`（以 `[`/`{` 开头的值按 JSON 解析）。
- `tea issue list -o json` 的 `labels` 是字符串数组；单工单 `tea issue <idx> -o json` 里是对象数组。
- 仓库发现失败时检查 `tea logins list`，或显式传 `-l`、`-R`、`-r`。
- CLI 未覆盖端点时才使用 `tea api`；不改用裸 curl。

## 真源

- 命令和参数以 `tea <command> --help` 为准。
- 工单登记和读写红线见仓库 `CLAUDE.md`「常驻规则」。
