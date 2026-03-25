# AI Review

VS Code extension that automatically requests an AI code review after a git commit or push.

## What it supports

- Choose which CLI to run: `claude`, `codex`, or `copilot`
- Choose when reviews run: after `commit`, after `push`, both, or manual only
- Use a lightweight model for small changes (below a configurable line threshold)
- Configure the prompt file with template tokens
- Skip reviews when commit messages contain specific keywords
- Open a dashboard to monitor active runs, view history, and edit prompts
- i18n support (English, Korean)

## Commands

- `AI Review: Run Review Now` — manually trigger a review for the current HEAD
- `AI Review: Open Review Dashboard` — open the review dashboard panel
- `AI Review: Select Prompt File` — pick a prompt file via file dialog
- `AI Review: Select Review Folder` — pick a review output folder via file dialog

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `aiReview.enabled` | `true` | Enable automatic AI reviews |
| `aiReview.cli` | `"claude"` | CLI to use: `claude`, `codex`, or `copilot` |
| `aiReview.trigger` | `"commit"` | When to run: `commit`, `push`, `commitAndPush`, or `manual` |
| `aiReview.model` | `""` | Default model name (empty = CLI default) |
| `aiReview.smallChangeModel` | `""` | Lightweight model for small changes (empty = always use default) |
| `aiReview.smallChangeLineThreshold` | `50` | Use the lightweight model when changed lines are below this value |
| `aiReview.promptFile` | `".review/prompt.md"` | Path to the prompt template file |
| `aiReview.reviewDirectory` | `".review"` | Folder where review files are written |
| `aiReview.keepReviewFileCount` | `10` | Max number of review files to keep |
| `aiReview.startNotificationMode` | `"progress"` | Start notification: `progress` or `brief` |
| `aiReview.completionNotificationMode` | `"sticky"` | Completion notification: `sticky` or `brief` |
| `aiReview.skipCommitKeywords` | `[]` | Skip review if commit message contains any of these keywords |

## Prompt Tokens

The prompt file can use these placeholders:

| Token | Replaced with |
|-------|---------------|
| `$commit$` | Current HEAD commit hash |
| `$commit_range$` | Commit range for the review |
| `$trigger$` | What triggered the review (`commit`, `push`, or `manual`) |
| `$repo$` | Repository root path |

## Notes

- Only pure commits (including amend and cherry-pick) and pushes trigger reviews. Pull, rebase, merge, fetch, and reset are ignored.
- Push detection uses ahead/behind transitions and is best-effort for external git activity.
- The extension assumes the selected CLI is already installed and available in `PATH`.
