# Issue tracker: Gitea

Issues and specs for this repo live in Gitea Issues at `http://lzxsvn:3000/qinyuanj/ugc-image-tool`.

## CLI

Use the authenticated `tea` CLI with login `lzxsvn` and repository `qinyuanj/ugc-image-tool`.

- List issues: `tea issues list --login lzxsvn --repo qinyuanj/ugc-image-tool`
- View an issue: `tea issues <number> --login lzxsvn --repo qinyuanj/ugc-image-tool`
- Create an issue: `tea issues create --login lzxsvn --repo qinyuanj/ugc-image-tool`
- Add a comment: `tea comment --login lzxsvn --repo qinyuanj/ugc-image-tool <number>`

Prefer repository discovery through the configured `origin` remote when it is reliable, but pass `--login` and `--repo` explicitly in automation.

## When a skill says "publish to the issue tracker"

Create a Gitea Issue. Put the concise feature or task name in the title and the complete specification or ticket in the description. Apply the requested triage label when one is specified.

Do not publish tracker files from `.scratch/`. That directory is a local ignored workspace and is not part of Git history.

## When a skill says "fetch the relevant ticket"

Read the referenced Gitea Issue with `tea`. The user will normally provide an issue number or URL.

## Pull requests as a request surface

Pull requests are not part of the issue-triage queue unless the user explicitly asks to include one.
