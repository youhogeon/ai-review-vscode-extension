# AI Review

VS Code extension that automatically requests an AI code review after a git commit or push.
<img width="1024" alt="image" src="https://github.com/user-attachments/assets/c04530cb-a074-4a4d-96d6-47d55402f719" />


<img width="1440" alt="image" src="https://github.com/user-attachments/assets/5949b8c2-6cb3-4387-831c-577ab8d5cc83" />

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


----

# AI 리뷰

git 커밋 또는 푸시 이후 자동으로 AI 코드 리뷰를 요청하는 VS Code 확장 프로그램.

## 지원 기능

- 실행할 CLI 선택: `claude`, `codex`, 또는 `copilot`
- 리뷰 실행 시점 선택: `commit` 이후, `push` 이후, 둘 다, 또는 수동만
- 작은 변경 사항에 대해 경량 모델 사용 (설정 가능한 라인 수 임계값 이하)
- 템플릿 토큰을 사용하여 프롬프트 파일 구성
- 커밋 메시지에 특정 키워드가 포함된 경우 리뷰 건너뛰기
- 활성 실행 모니터링, 히스토리 확인, 프롬프트 편집을 위한 대시보드 열기
- i18n 지원 (영어, 한국어)

## 명령어

- `AI Review: Run Review Now` — 현재 HEAD에 대해 수동으로 리뷰 실행
- `AI Review: Open Review Dashboard` — 리뷰 대시보드 패널 열기
- `AI Review: Select Prompt File` — 파일 대화상자를 통해 프롬프트 파일 선택
- `AI Review: Select Review Folder` — 파일 대화상자를 통해 리뷰 출력 폴더 선택

## 설정

| 설정 | 기본값 | 설명 |
|---------|---------|-------------|
| `aiReview.enabled` | `true` | 자동 AI 리뷰 활성화 |
| `aiReview.cli` | `"claude"` | 사용할 CLI: `claude`, `codex`, 또는 `copilot` |
| `aiReview.trigger` | `"commit"` | 실행 시점: `commit`, `push`, `commitAndPush`, 또는 `manual` |
| `aiReview.model` | `""` | 기본 모델 이름 (비어있음 = CLI 기본값 사용) |
| `aiReview.smallChangeModel` | `""` | 작은 변경 사항용 경량 모델 (비어있음 = 항상 기본값 사용) |
| `aiReview.smallChangeLineThreshold` | `50` | 변경된 라인 수가 이 값보다 적을 때 경량 모델 사용 |
| `aiReview.promptFile` | `".review/prompt.md"` | 프롬프트 템플릿 파일 경로 |
| `aiReview.reviewDirectory` | `".review"` | 리뷰 파일이 작성되는 폴더 |
| `aiReview.keepReviewFileCount` | `10` | 유지할 최대 리뷰 파일 수 |
| `aiReview.startNotificationMode` | `"progress"` | 시작 알림: `progress` 또는 `brief` |
| `aiReview.completionNotificationMode` | `"sticky"` | 완료 알림: `sticky` 또는 `brief` |
| `aiReview.skipCommitKeywords` | `[]` | 커밋 메시지에 해당 키워드가 포함되면 리뷰 건너뜀 |

## 프롬프트 토큰

프롬프트 파일에서 다음 플레이스홀더를 사용할 수 있음:

| 토큰 | 대체 값 |
|-------|---------------|
| `$commit$` | 현재 HEAD 커밋 해시 |
| `$commit_range$` | 리뷰를 위한 커밋 범위 |
| `$trigger$` | 리뷰를 트리거한 이벤트 (`commit`, `push`, 또는 `manual`) |
| `$repo$` | 저장소 루트 경로 |

## 참고 사항

- 순수 커밋(수정 커밋, 체리픽 포함)과 푸시만 리뷰를 트리거함. pull, rebase, merge, fetch, reset은 무시됨.
- 푸시 감지는 ahead/behind 상태 변화를 사용하며, 외부 git 활동에 대해서는 best-effort 방식임.
- 확장 프로그램은 선택된 CLI가 이미 설치되어 있고 `PATH`에서 사용 가능하다고 가정함.
