---
title: Claude Conversation Reader
description: MCP server + CLI tool for reading Claude.ai conversations, SQLite offline search, and knowledge graph visualization
version: 3.1.0
created: 2025-04-11T00:00:00Z
last_updated: 2026-05-27T19:20:00Z
---

# Claude Conversation Reader

MCP server + CLI tool that authenticates to Claude.ai via Playwright, reads your conversation threads, and exposes them to GitHub Copilot via MCP tools and a custom `@claude-reader` agent. Also supports importing Claude export JSON into a local SQLite FTS5 database for offline full-text search, entity analysis, and knowledge graph visualization.

## Prerequisites

- Node.js 18+
- A Claude.ai account

## Installation

```bash
npm install
npm run build
```

## Quick Start

### 1. Open the project in VS Code

The agents and instructions activate automatically.

### 2. Log in to Claude.ai

```bash
npm run dev -- login
```

Playwright will open a browser. Complete the login flow (email + verification code or Google SSO). Your session is saved to `~/.ccr/session.json` (override with `SESSION_PATH` env var).

### 3. Fetch a conversation

```bash
npm run dev -- get 4e31905d-79bb-4c5b-9589-2d943180208a
```

Replace the UUID with any conversation ID from `npm run dev -- list`.

### 4. Import a Claude export for offline search

```bash
npm run dev -- import-sqlite conversations.json .ccr-import.sqlite
npm run dev -- extract-entities .ccr-import.sqlite
npm run dev -- search-sqlite .ccr-import.sqlite "playwright"
```

### 5. Build and explore the knowledge graph

```bash
npm run dev -- graph-build .ccr-import.sqlite
npm run dev -- graph-god-nodes .ccr-import.sqlite
npm run dev -- graph-export .ccr-import.sqlite graph.html
```

Open `graph.html` in a browser to explore an interactive visualization with a searchable conversation sidebar and Claude.ai deep-links.

### 6. Use in Copilot Chat

From any VS Code workspace, open Copilot Chat and use:

```
@claude-reader list
@claude-reader get <conversation-id>
@claude-reader search <keyword>
```

## CLI Reference

### Live API Commands

```bash
npm run dev -- login                          # Authenticate via browser
npm run dev -- status                         # Check session validity
npm run dev -- logout                         # Clear saved session
npm run dev -- list                           # List all conversations
npm run dev -- get <id>                       # Fetch a conversation (Markdown output)
npm run dev -- search <q>                     # Search conversations by title/keyword
```

Options for `get`:
- `--format json` -- raw JSON output
- `--format compact` -- condensed XML-style format

### SQLite Offline Commands

```bash
npm run dev -- import-sqlite <export.json> <db>   # Import Claude export to SQLite FTS5
npm run dev -- extract-entities <db>               # Extract topics, URLs, UUIDs from messages
npm run dev -- search-sqlite <db> <query>          # Full-text search (FTS5 syntax)
npm run dev -- search-entity <db> <entity>         # Search by extracted entity
npm run dev -- edit-history <db> <msg-uuid>        # Show edit history for a message
npm run dev -- search-attachments <db> <query>     # Search attachments by keyword
npm run dev -- main-branch <db> <conv-uuid>        # List all messages in a conversation
npm run dev -- search-thinking <db> <query>        # Search Claude's thinking blocks
npm run dev -- search-tools <db> <tool-name>       # Find tool calls by name
npm run dev -- search-content <db> <query>         # Search all content blocks (--type filter)
npm run dev -- audit <db>                          # Conversation stats (untitled, empty)
npm run dev -- audit <db> --untitled               # List conversations with no title
npm run dev -- audit <db> --empty                  # List conversations with no messages
npm run dev -- branches <db> <conv-uuid>           # List all threads/branches in a conversation
npm run dev -- thread <db> <conv-uuid> <index>     # View a specific thread (0=main, 1+=alternates)
npm run dev -- delete <conversation-id> --yes      # Delete a conversation from Claude.ai
npm run dev -- delete-empty <db> --dry-run          # List empty conversations (no messages)
npm run dev -- delete-empty <db> --yes              # Delete all empty conversations
npm run dev -- stats <db>                           # Comprehensive usage statistics
npm run dev -- projects                             # List all Claude.ai projects with links
```

### Claude Code Session Commands

```bash
npm run dev -- discover-code-api <session-id>      # Reverse-engineer the /v1/sessions/<id> API surface via Playwright traffic capture
npm run dev -- get-code-session <session-id>       # Fetch a claude.ai/code session + import to SQLite in one step
npm run dev -- import-code-session <fetched.json>  # Import a previously-fetched session JSON into the SQLite DB
```

Options for `get-code-session`:
- `--db <path>` -- target SQLite DB (default: `.ccr-import.sqlite`)
- `-o, --output <path>` -- JSON dump path (default: `fetched-<id>.json`)
- `--no-import` -- only fetch + save JSON, skip SQLite import
- `--headed` -- show the underlying browser

Claude Code sessions are served from `claude.ai/v1/sessions/<id>` (different from the web-chat conversation API at `/api/organizations/<org>/chat_conversations/<uuid>`). They require additional Anthropic headers (`anthropic-version`, `anthropic-client-platform`, `x-organization-uuid`, `anthropic-beta`) and are protected by Cloudflare bot management — so the client uses Playwright's `BrowserContext.request` API for the right TLS fingerprint.

### Knowledge Graph Commands

```bash
npm run dev -- graph-build <db>                    # Build graph (extract + build + cluster)
npm run dev -- graph-query <db> <keyword>           # BFS subgraph search (--depth N)
npm run dev -- graph-god-nodes <db>                 # Most connected entities
npm run dev -- graph-export <db> [output.html]      # Interactive HTML visualization
npm run dev -- graph-path <db> <from> <to>          # Shortest path between entities
```

Options for `graph-build`:
- `--method kmeans` -- use k-means clustering instead of label propagation
- `--k <n>` -- specify number of clusters (auto-selects via silhouette if omitted)

Options for `graph-god-nodes`:
- `--tools` -- show tool usage stats instead
- `--bridges` -- show bridge entities connecting communities
- `--bursts` -- show temporal burst patterns

Options for `graph-export`:
- `--max-nodes <n>` -- limit graph size (default: 50)
- `--seed <entity>` -- ego graph centered on an entity
- `--entity-only` -- exclude conversation and tool nodes

## MCP Server

Start the MCP server for Copilot integration:

```bash
npm run dev:server
```

Register it in your VS Code `mcp.json`:

```json
{
  "servers": {
    "claude-conversation-reader": {
      "command": "npx",
      "args": ["tsx", "<absolute-path>/src/server.ts"]
    }
  }
}
```

### Available MCP Tools (33)

| Tool | Category | Description |
|------|----------|-------------|
| `claude_login` | Live API | Trigger browser-based login |
| `list_conversations` | Live API | List recent conversations with optional filters |
| `get_conversation` | Live API | Fetch full conversation by ID |
| `search_conversations` | Live API | Search by title/keyword/date |
| `get_conversation_as_context` | Live API | Fetch conversation formatted as LLM context |
| `search_sqlite` | SQLite | Full-text search across all imported messages (FTS5) |
| `search_entity` | SQLite | Search by extracted entity (topic, URL, UUID) |
| `get_conversation_messages` | SQLite | Get main-branch messages from a conversation |
| `search_thinking` | SQLite | Search Claude's thinking/reasoning blocks |
| `search_tool_calls` | SQLite | Find messages where Claude used a specific tool |
| `search_content` | SQLite | Unified FTS across all content blocks with type filter |
| `delete_conversation` | Delete | Delete a conversation from Claude.ai and local SQLite |
| `audit_conversations` | Audit | Find untitled/empty conversations or get stats |
| `get_conversation_branches` | Branch | List all threads/branches in a conversation |
| `get_conversation_thread` | Branch | Get messages from a specific thread |
| `graph_build` | Graph | Build/rebuild knowledge graph with clustering |
| `graph_query` | Graph | BFS subgraph search by keyword |
| `graph_god_nodes` | Graph | Get most connected entities with suggestions |
| `graph_neighbors` | Graph | Get direct neighbors of a node |
| `graph_shortest_path` | Graph | Find shortest path between two entities |
| `graph_community` | Graph | Get all members of a community |
| `graph_surprising_connections` | Graph | Find cross-community entity connections |
| `graph_export` | Graph | Export interactive HTML visualization |
| `list_projects` | Projects | List all Claude.ai projects with links |
| `conversation_stats` | Stats | Comprehensive usage statistics (prompts, tools, temporal) |
| `get_code_session` | Code Sessions | Fetch a Claude Code session by ID + format as markdown/JSON/compact |
| `list_code_sessions` | Code Sessions | List Claude Code sessions on the account (optional title filter) |
| `search_code_sessions` | Code Sessions | Search Claude Code sessions by title substring |

## Security

- Credentials are never hardcoded -- authentication is browser-based
- Session cookies are stored in `~/.ccr/session.json` (mode `0600`, gitignored)
- All URL components are `encodeURIComponent`-encoded
- API calls are rate-limited (~1s delay) to avoid account flagging

## Architecture

```
src/
├── index.ts              # CLI entry (Commander.js, 26 commands)
├── server.ts             # MCP server entry (30 tools)
├── types.ts              # Shared TypeScript interfaces
├── auth/
│   ├── claude-login.ts   # Playwright Claude.ai login
│   └── session.ts        # Cookie persistence & validation
├── api/
│   └── client.ts         # Claude.ai internal API wrapper
├── extractors/
│   ├── conversation.ts   # Tree -> linear thread flattener
│   ├── formatter.ts      # Markdown/JSON/compact output
│   └── search.ts         # Search by title/date/keyword
├── importers/
│   ├── import-sqlite.ts  # Claude JSON export -> SQLite FTS5
│   ├── sqlite-search.ts  # Full-text search via FTS5 MATCH
│   ├── entity-extract.ts # Regex entity extraction (topics, URLs, UUIDs)
│   ├── entity-search.ts  # Query by extracted entity
│   └── advanced-queries.ts # Edit history, attachments, main-branch
├── graph/
│   ├── schema.ts         # Graph table DDL (3 tables)
│   ├── build.ts          # Entity + conversation + tool nodes, 3 edge types
│   ├── cluster.ts        # Label propagation or k-means dispatcher
│   ├── kmeans.ts         # K-means++ with silhouette auto-k
│   ├── query.ts          # BFS subgraph, neighbors, shortest path
│   ├── analyze.ts        # God nodes, bridges, bursts, tool stats
│   ├── export.ts         # Interactive HTML (vis-network.js, sidebar, context menu)
│   └── index.ts          # Barrel export
└── mcp/
    └── tools.ts          # MCP tool definitions & handlers
```
