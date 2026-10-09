# Issue tracker: GitHub

项目工作票、规格和 wayfinder 地图的唯一跟踪入口是 [TLOBillyQ/kacha 的 GitHub Issues](https://github.com/TLOBillyQ/kacha/issues)，通过已认证的 `gh` CLI 读写。

## Workflow

1. 读取目标票的完整正文、评论、标签、状态和 assignees：

   ```powershell
   gh issue view <number> --repo TLOBillyQ/kacha --json number,title,body,comments,labels,state,assignees,url
   ```

   涉及关系时，同时读取下文的原生关系接口。完成标准：取得所有将被修改的字段及其现值。

2. 只修改请求涉及的字段。替换正文前保留最新全文；多行正文和评论使用 UTF-8 临时文件配合 `--body-file`，以保留换行和字面字符。应用标签前用 `gh label list --repo TLOBillyQ/kacha --json name,color,description` 核对名称。

3. 回读目标票和变更过的关系。完成标准：正文、评论、状态、标签和关系与请求一致，所有交叉引用指向正确票。

## Common operations

```powershell
gh issue list --repo TLOBillyQ/kacha --state all --search "关键词" --json number,title,state,labels,url
gh issue create --repo TLOBillyQ/kacha --title "标题" --body-file <path> --label <label>
gh issue edit <number> --repo TLOBillyQ/kacha --body-file <path>
gh issue edit <number> --repo TLOBillyQ/kacha --add-label <label> --remove-label <label>
gh issue comment <number> --repo TLOBillyQ/kacha --body-file <path>
gh issue close <number> --repo TLOBillyQ/kacha --reason completed
gh issue reopen <number> --repo TLOBillyQ/kacha
```

列表默认有限制；完整枚举时用分页 API 或明确足够的 `--limit`。机器读取用 JSON。修改或删除评论时通过 `gh api` 使用评论数据库 ID；它与 issue number 不同。CLI 参数以 `gh <command> --help` 为准。

当技能要求发布规格或获取工作票时，在 GitHub 创建或读取 Issue。标题使用简洁任务名称，完整问题或规格放正文，按技能要求设置标签。`.scratch/` 是忽略的本地工作区，临时文件留在本地，正式上下文通过 Issue 或已提交资产链接保存。

PR 仅在用户明确要求包含时进入 issue 分诊范围。

## Wayfinding operations

- 地图是仅标记 `wayfinder:map` 的 Issue；决策票仅使用对应 `wayfinder:<type>` 标签，并通过 GitHub 原生 sub-issues 归属地图。
- 建票后再连接父子和阻塞关系、填写真实引用。用户可见引用用票名包装链接，避免裸编号。地图只索引已关闭决策及未明确范围；开放票通过子议题查询取得。
- 开始工作前认领票：先用 `gh api user --jq .login` 确认当前开发者，再用 `gh issue edit <number> --repo TLOBillyQ/kacha --add-assignee <login>` 分配。无 assignee 才是未认领。
- Issue number 用于 URL 路径；关系 POST 请求中的 `sub_issue_id` 和 `issue_id` 是数据库整数 ID，通过 `gh api repos/TLOBillyQ/kacha/issues/<number> --jq .id` 获取。

```powershell
# 父子关系：查询地图的全部子票；写入时 sub_issue_id 是子票数据库 ID。
gh api --paginate repos/TLOBillyQ/kacha/issues/<map-number>/sub_issues
gh api --method POST repos/TLOBillyQ/kacha/issues/<map-number>/sub_issues -F sub_issue_id=<child-id>

# 阻塞关系：查询阻塞当前票的票；写入时 issue_id 是阻塞方数据库 ID。
gh api --paginate repos/TLOBillyQ/kacha/issues/<number>/dependencies/blocked_by
gh api --method POST repos/TLOBillyQ/kacha/issues/<number>/dependencies/blocked_by -F issue_id=<blocker-id>
```

**Frontier**：读取所有子票，按创建顺序筛选 open、无 assignee、所有 blocked-by 票均 closed 的票。每条依赖通过原生接口核实，不能从正文猜测；用户指定票时仍先核对认领与依赖状态。

解决决策后，将答案发为 resolution comment，再关闭票，在地图的 Decisions so far 追加票名链接与一句 gist。新增票先创建、后连接关系；更新地图前读取最新全文，保留并发会话的变化。研究资产链接到实际推送分支或固定 commit，不将临时路径当作共享上下文。
