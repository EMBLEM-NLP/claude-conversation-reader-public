---
name: ccr-doctor
description: This skill should be used to audit and fix claude-conversation-reader's MCP server wiring across VS Code, Claude Desktop, and Claude Code, and to check/refresh its Claude.ai login session. Use when the user asks "why isn't ccr working", "is claude-conversation-reader wired up", "check/fix my MCP servers for the conversation reader", or when its tools aren't showing up in a session despite being expected.
compatibility: Windows paths assumed (VS Code mcp.json, Claude Desktop claude_desktop_config.json, Claude Code's ~/.claude.json) — adapt paths for macOS/Linux equivalents if needed. Requires the `claude` CLI on PATH and Node.js 18+.
metadata:
  version: "1.0.0"
  created: "2026-07-15T20:05:23Z"
  last_updated: "2026-07-15T20:05:23Z"
---

# CCR Doctor

Audit and repair `claude-conversation-reader`'s MCP registration across all three clients it can be wired into, plus its Claude.ai login session. This encodes the exact troubleshooting flow used to originally wire it up.

## Step 1 — Check Claude Code registration (user scope)

```bash
claude mcp list
```

Look for a line like `claude-conversation-reader: npx tsx ...\src\server.ts - ✓ Connected`. If missing entirely:

```bash
claude mcp add claude-conversation-reader -s user -- npx tsx "${CLAUDE_PROJECT_DIR}/src/server.ts"
```

`-s user` registers it in the top-level `mcpServers` block of `~/.claude.json`, available to every Claude Code session on this machine (not just the current project). Note: a registration added mid-session won't retroactively add tools to the *current* live session — it takes effect in new sessions. A `✗ Failed to connect` result during a health check can also just mean cold-start latency (`npx tsx` resolving on first run) — retry once before concluding it's broken.

## Step 2 — Check VS Code registration

Read `%APPDATA%\Code\User\mcp.json` (macOS: `~/Library/Application Support/Code/User/mcp.json`; Linux: `~/.config/Code/User/mcp.json`). Look for a `claude-conversation-reader` entry under `"servers"`. If missing, add:

```json
"claude-conversation-reader": {
  "command": "npx",
  "args": ["tsx", "<absolute-path-to-this-repo>/src/server.ts"]
}
```

VS Code's `mcp.json` doesn't support the `${CLAUDE_PROJECT_DIR}` substitution (that's Claude Code-specific) — use the actual absolute path on this machine.

## Step 3 — Check Claude Desktop registration

Read `%APPDATA%\Claude\claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`). Look for a `claude-conversation-reader` entry under `"mcpServers"`. If missing, add the same command/args shape as Step 2, nested under `mcpServers` instead of `servers`. **Always validate the JSON is still parseable after editing** — a malformed config breaks Claude Desktop entirely on next launch:

```bash
node -e "JSON.parse(require('fs').readFileSync(process.env.APPDATA+'/Claude/claude_desktop_config.json','utf8')); console.log('valid')"
```

Claude Desktop only reads this file at startup — tell the user they must **fully quit and relaunch** the app (not just close the window) for a new registration to take effect.

## Step 4 — Check Claude.ai login session freshness

```bash
node -e "
const fs=require('fs');
const j=JSON.parse(fs.readFileSync(process.env.USERPROFILE/*or HOME on mac/linux*/+'/.ccr/session.json','utf8'));
console.log('savedAt:', j.savedAt);
const sk = j.cookies.raw.find(c=>c.name==='sessionKey');
console.log('sessionKey expires:', sk ? new Date(sk.expires*1000).toISOString() : 'MISSING');
"
```

Compare the printed expiry to the current date. If the file doesn't exist, or the expiry is in the past, the session is stale — go to Step 5. A stale session isn't visible until a live call actually fails (`Session cookies have expired. Run \`ccr login\`.`), so don't assume a saved session still works just because the file exists.

## Step 5 — Re-login (only if Step 4 found it stale/missing)

```bash
cd ${CLAUDE_PROJECT_DIR}
npm run dev -- login
```

Run this in the **background** (Bash tool: `run_in_background: true`) — it opens a real, visible Chrome window via Playwright and blocks waiting for the user to complete email+code or Google SSO (up to 90s after page load). Tell the user to complete it in the browser window. Poll the task output for:

```
Session saved successfully.
✔ Logged in and session saved.
```

## Step 6 — Verify end-to-end

```bash
npm run dev -- list -n 20
```

If it returns conversation titles/UUIDs rather than an auth error, the whole chain (registration + session) is healthy. Report back which of Steps 1–5 actually needed a fix versus were already fine — don't silently redo work that was already correct.
