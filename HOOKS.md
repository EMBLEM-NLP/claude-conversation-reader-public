---
title: "Claude Code Hook Audit — claude-conversation-reader"
description: "Catalog of Claude Code hooks active in this project and the global user settings, plus the git-side hooks under .githooks/."
version: 1.0.0
created: 2026-05-28T14:32:33Z
last_updated: 2026-05-28T14:32:33Z
---

# Claude Code Hook Audit — claude-conversation-reader

Snapshot taken 2026-05-28. Audit covers three layers: global user hooks, this project's Claude hooks, and the git-side hooks living under `.githooks/`.

## 1. Project Claude hooks — `.claude/settings.json`

| Event | Matcher | Command | Timeout | Behavior |
|---|---|---|---|---|
| `Stop` | `""` (all stops) | `bash .githooks/stop-git-check.sh` | default | Exit-2 if there are uncommitted, untracked, or unpushed changes. Includes a "Do not create a pull request unless explicitly asked" reminder string. |
| `PostToolUse` | `Edit\|Write` | `bash .githooks/post-edit-update.sh` | 10s | If the file has a real content change (timestamp-stripped diff), bumps `@lastUpdated` (`.ts/.js/.cjs/.sh`) or `last_updated:` (`.md` frontmatter) to the current UTC timestamp and stages the file. |

Both hooks early-exit gracefully if they're not in a git repo or if input is missing — they never block work spuriously.

## 2. Global user hooks — `~/.claude/settings.json`

Inherited from the user-scope settings (apply to every project the user runs Claude Code in):

| Event | Matcher | Command | Timeout | Behavior |
|---|---|---|---|---|
| `SessionStart` | (default) | PowerShell one-liner echoing current UTC time as `additionalContext` | default | Injects `Current UTC time: <ISO>` into the session-start context so Claude can timestamp work accurately. |
| `SessionStart` | `*` | `node C:/Users/romar/.claude/skills/recall/recall.mjs hook-session-start` | 5000ms | Loads relevant memory via the `/recall` skill on every session start. |
| `PostToolUse` | `Write` | `node C:/Users/romar/.claude/skills/recall/recall.mjs hook-post-tool-use` | 5000ms | Same recall integration, focused on the Write tool. |
| `PostToolUse` | `*` | `node C:/Users/romar/.claude/skills/recall/recall.mjs hook-post-tool-use` | 5000ms | Catch-all recall hook for every other tool use. |

Global PostToolUse `*` runs after CCR's project-level `Edit|Write` hook for matching tools — the order is deterministic but both fire.

## 3. Git-side hooks — `.githooks/`

These are NOT Claude hooks. They are git hooks executed by git itself when `core.hooksPath` is configured. Files present:

- `pre-commit`
- `pre-push`
- `prepare-commit-msg`
- `stop-git-check.sh` (also used as a Claude hook — dual purpose)
- `post-edit-update.sh` (also used as a Claude hook — dual purpose)

### Wiring check

`package.json` ships an `install-hooks` script:

```json
"install-hooks": "git config core.hooksPath .githooks"
```

Until that's run once, the `pre-commit` / `pre-push` / `prepare-commit-msg` files exist but git never invokes them — they're inert. Verify in any clone with:

```
git config --get core.hooksPath
```

If it returns `.githooks`, the git-side hooks are active. If empty or `core.hooks`, they aren't.

## 4. Observations

- **Coverage is good.** Stop + PostToolUse cover the two most important "don't lose work / keep metadata fresh" moments.
- **No PreToolUse hooks.** No "should this be allowed?" gating. Permission is left to the auto-mode classifier and the `permissions.allow` list in `.claude/settings.json` + `settings.local.json`.
- **`settings.local.json` has accumulated** — 180+ allowlisted Bash command patterns, several pre-historical. Worth periodic pruning (a `/fewer-permission-prompts` pass would compact it).
- **The `enableAllProjectMcpServers: true` setting** auto-enables the `time` MCP server from `.mcp.json`. Confirmed working.
- **`prepare-commit-msg` is the riskiest hook to forget about** — it can rewrite commit messages. If `core.hooksPath` is set, this fires on every commit. Audit the script before relying on it for important commits.

## 5. Related rules

- `.claude/rules/markdown-frontmatter.md` — versioning convention the post-edit hook implements.
- `.githooks/stop-git-check.sh` — the canonical implementation. Ported to `roots-4-winds-pharmacy` on 2026-05-28.
- `.githooks/post-edit-update.sh` — handles `.ts/.js/.cjs/.sh` JSDoc headers AND `.md` YAML frontmatter in one script.
