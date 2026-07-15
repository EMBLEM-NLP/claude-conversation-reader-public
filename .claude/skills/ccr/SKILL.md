---
name: ccr
description: This skill should be used when the user wants to check their Claude.ai login/session status, get a live count or list of Claude.ai conversations, search old conversations, or pull an old Claude.ai conversation (or Claude Code session) into the current chat as context. Invoke directly with /ccr, or when the user asks things like "how many conversations do I have", "find that old chat about X", or "bring conversation <id/url> into this chat".
compatibility: Requires Node.js 18+. Live commands need a valid ~/.ccr/session.json session — re-run login when expired. Uses claude.ai's undocumented internal API via Playwright-captured cookies, not an official API key.
metadata:
  version: "1.0.0"
  created: "2026-07-15T20:05:23Z"
  last_updated: "2026-07-15T20:05:23Z"
---

# Claude Conversation Reader

Fetch, count, search, and inject Claude.ai conversations (and Claude Code sessions) as context — live via claude.ai's internal API, or offline via a SQLite import of the official data export. All commands below run from `${CLAUDE_PROJECT_DIR}` via `npm run dev -- <command>` (tsx, no build needed).

This project can also be wired as an MCP server (VS Code `mcp.json`, Claude Desktop `claude_desktop_config.json`, or Claude Code's user-scope config — see `/ccr-doctor`), exposing the same functionality as 33 MCP tools (`list_conversations`, `get_conversation_as_context`, `search_code_sessions`, etc.). If those tools are connected in the current session, prefer calling them directly. This skill exists for the CLI path — use it when the MCP tools aren't connected/available, or when running a multi-step flow (like login) that's easier to drive from the shell.

## Critical gotchas (read first)

- **Session expiry is silent until you hit it.** `~/.ccr/session.json` is only checked against the `sessionKey` cookie's own `expires` timestamp — there's no proactive warning. A stale session fails with `Session cookies have expired. Run \`ccr login\`.` on the first live call. Always be ready to re-login rather than assume a saved session still works, especially if it's been more than a few weeks.
- **`stats` is offline-only.** `npm run dev -- stats <db>` reads the local SQLite import, not the live API — it errors with `missing required argument 'dbPath'` if you forget the db path, and it will never reflect conversations added since the last import.
- **`list` truncates to 20 by default.** For an accurate live count, pass a large `-n`, e.g. `npm run dev -- list -n 100000`, then count the UUID-prefixed lines — don't trust the default output as "all conversations."
- **Login opens a real, visible Chrome window** (Playwright, `headless: false`) and needs a human to complete email+code or Google SSO — it cannot be automated further. It waits up to 90s after page load for a successful `/api/organizations` response before timing out (screenshot saved to `~/.ccr/last-login-failure.png` on failure).
- **Rate limited to ~1 request/second** against claude.ai — large `search`/`list` operations take time; don't parallelize calls against the live API.
- **Never commit real conversation data.** Don't create sample/fixture files from live exports or SQLite imports in this repo — see `.gitignore` for what's already excluded.

## Step 1 — Check session status

```bash
cd ${CLAUDE_PROJECT_DIR}
npm run dev -- status
```

If it reports no session or an expired one, go to Step 2 before attempting any live command (`list`, `get`, `search`, `stats` on live data isn't a thing — offline `stats` doesn't need this).

## Step 2 — Log in (only when session is missing/expired)

Run in the background — it blocks on browser interaction, and the user needs to complete it themselves:

```bash
npm run dev -- login
```

(Bash tool: pass `run_in_background: true`.) Tell the user a Chrome window is opening and to complete the login there (email+code or Google SSO). Poll the task output for:

```
Authentication complete. Extracting session cookies...
Session saved successfully.
✔ Logged in and session saved.
```

Do not proceed to Step 3 until this line appears — an interrupted/failed login leaves no valid session.

## Step 3 — Get a live conversation count / list

```bash
npm run dev -- list -n 100000
```

Count the returned lines (each starts with a UUID) rather than trusting a header — there isn't one. For a filtered count (e.g. conversations matching a keyword), use `search` instead:

```bash
npm run dev -- search "<keyword>" -n 100000
```

## Step 4 — Bring an old conversation into the current chat

Get the conversation's UUID (from `list`/`search` output, or from its claude.ai URL), then:

```bash
npm run dev -- get <uuid> --format compact
```

`--format compact` produces the token-minimized XML-tagged block meant for pasting as context; omit it for full Markdown, or use `--format json` for raw data. For a **Claude Code session** (not a web chat — different ID space, `session_<slug>`), use:

```bash
npm run dev -- get-code-session <session-id>
```

## Step 5 — Offline fallback (session expired / API unavailable / need bulk search)

If live commands aren't working and re-login isn't an option right now, fall back to the SQLite import built from claude.ai's official data export (Settings → Privacy → Export Data on claude.ai):

```bash
npm run dev -- import-sqlite <export.json> .ccr-import.sqlite   # one-time per export
npm run dev -- stats .ccr-import.sqlite                          # offline conversation/message stats
npm run dev -- search-sqlite .ccr-import.sqlite "<query>"        # full-text search (FTS5)
```

This path is also the more durable one long-term — it doesn't depend on the undocumented live API or cookie freshness, at the cost of only being as fresh as the last export. `.ccr-import.sqlite` is gitignored — never commit it.

## Reference: key commands

| Goal | Command |
|---|---|
| Check login | `npm run dev -- status` |
| Log in / refresh session | `npm run dev -- login` |
| Live count/list | `npm run dev -- list -n 100000` |
| Search live | `npm run dev -- search "<q>" -n 100000` |
| Fetch one conversation | `npm run dev -- get <uuid> --format compact` |
| Fetch a Claude Code session | `npm run dev -- get-code-session <session-id>` |
| List Claude.ai projects | `npm run dev -- projects` |
| Import official export | `npm run dev -- import-sqlite <export.json> <db>` |
| Offline stats | `npm run dev -- stats <db>` |
| Offline full-text search | `npm run dev -- search-sqlite <db> "<q>"` |
| Build knowledge graph | `npm run dev -- graph-build <db>` (see `/ccr-graph`) |

Equivalent MCP tools (when connected): `claude_login`, `list_conversations`, `search_conversations`, `get_conversation`, `get_conversation_as_context`, `list_projects`, `get_code_session`, `list_code_sessions`, `search_code_sessions`, `search_sqlite`, `conversation_stats`, `graph_build`.
