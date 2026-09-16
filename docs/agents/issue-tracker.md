# Issue tracker: Gitea

Issues and specs for this repo live in Gitea Issues at `http://lzxsvn:3000/qinyuanj/ugc-image-tool`. All issue reads and writes go through the authenticated `tea` CLI.

## CLI

Run `tea` inside the repo directory; the target repository is resolved from the git remote. When repository discovery fails, check `tea logins list`, or pass `-l`, `-R`, `-r` explicitly — in automation, prefer explicit `--login lzxsvn --repo qinyuanj/ugc-image-tool` over relying on discovery.

## Workflow

1. **Read the current state**

   ```bash
   tea issue <idx> --comments -o json
   ```

   Done when you have the title, state, body, labels, and all comments; if you need to edit or delete a comment, also capture its comment ID.

   Long bodies get truncated when the whole issue is dumped (including background task logs); extract only the fields you need:

   ```bash
   tea issue <idx> -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["body"])'
   ```

2. **Make the minimal change**
   - Pass only the fields that change.
   - `tea issue edit -d` replaces the entire body — keep the existing full text before editing.
   - Use a quoted heredoc for multi-line Markdown (see below).
   - Verify label names with `tea labels list -o json` before applying them.

3. **Re-read to verify**

   ```bash
   tea issue <idx> --comments -o json
   ```

   Done when the target fields, state, and comments match the request; deleted comment IDs are gone; Markdown structure is intact.

## Common operations

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

`create` returns the new issue URL; take `<idx>` from the last URL segment, then re-read to verify as above.

## Multi-line bodies

```bash
tea issue create -t "标题" -d "$(cat <<'EOF'
## 章节
正文……
EOF
)"
```

`issue create`/`issue edit` take the body via `-d`; `comments add`/`comments edit` take it as a positional argument (no `-d` — passing one errors with `flag provided but not defined`). Both accept a quoted heredoc for multi-line content.

## Conventions and gotchas

- `tea issue <idx>` does not include comments by default; pass `--comments` explicitly for full context.
- Comment edit and delete use the comment ID, not the issue number.
- `tea issue edit -L` appends labels; use `--remove-labels` to remove them.
- For machine reading, use JSON output; never parse the terminal table or hyperlink escapes.
- This instance's assignees endpoint returns 404 (`tea issue edit -a` is unavailable); assign via the API:

  ```bash
  tea api -X PATCH -F 'assignees=["<user>"]' /repos/{owner}/{repo}/issues/<idx>
  ```

  `tea api -f` passes values as strings (array fields fail to unmarshal); use `-F` for array/object fields (values starting with `[`/`{` are parsed as JSON).
- Issue dependencies (blocked-by) go through `tea api`, and the body fields are `index`/`owner`/`repo` passed as raw JSON with `-d` (`-F owner=... name=...` fails with `repository does not exist`):

  ```bash
  tea api /repos/{owner}/{repo}/issues/<idx>/dependencies
  tea api -X POST -d '{"index":<blocker>,"owner":"qinyuanj","repo":"ugc-image-tool"}' \
    /repos/{owner}/{repo}/issues/<idx>/dependencies
  ```

- `tea issue list -o json` returns `labels` as a string array; a single-issue `tea issue <idx> -o json` returns an object array.
- Use `tea api` only for endpoints the CLI does not cover; do not fall back to raw curl.

## Source of truth

Commands and flags are authoritative as reported by `tea <command> --help`.

## When a skill says "publish to the issue tracker"

Create a Gitea Issue. Put the concise feature or task name in the title and the complete specification or ticket in the description. Apply the requested triage label when one is specified.

Do not publish tracker files from `.scratch/`. That directory is a local ignored workspace and is not part of Git history.

## When a skill says "fetch the relevant ticket"

Read the referenced Gitea Issue with `tea`. The user will normally provide an issue number or URL.

## Pull requests as a request surface

Pull requests are not part of the issue-triage queue unless the user explicitly asks to include one.
