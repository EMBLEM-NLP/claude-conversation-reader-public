---
title: CLAUDE.md
description: Project rules and architecture guide for Claude Code when working with claude-conversation-reader
version: 5.5.0
created: 2025-04-11T00:00:00Z
last_updated: 2026-05-27T19:30:00Z
---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev -- <command>    # Run CLI (tsx, no build needed)
npm run dev:server          # Run MCP server via stdio
npm run build               # Compile TypeScript to dist/
npm run typecheck           # Type-check only (no emit)
npm run lint                # ESLint
npm run format              # Prettier
```

There are no automated tests. Manual testing is done by running CLI commands against a live Claude.ai account.

## Architecture

Two entry points sharing the same core modules:

- **`src/index.ts`** — Commander.js CLI (`ccr` binary)
- **`src/server.ts`** — MCP server (stdio transport for VS Code Copilot)

**Data flow for live API path:**

1. `auth/session.ts` loads `~/.ccr/session.json` (cookies, mode 0600; override with `SESSION_PATH` env var)
2. If no valid session → `auth/claude-login.ts` runs Playwright to automate browser login, captures cookies
3. `api/client.ts` makes rate-limited fetch calls to Claude.ai's internal REST API using those cookies (no API key)
4. `extractors/conversation.ts` flattens the conversation tree (a DAG where branches form on message edits) into a linear thread by following the last child at each node
5. `extractors/formatter.ts` renders as markdown, JSON, or compact XML (`<human>`/`<assistant>` tags)
6. `mcp/tools.ts` registers **33 MCP tools** — 5 live API: `claude_login`, `list_conversations`, `get_conversation`, `search_conversations`, `get_conversation_as_context`; 6 SQLite offline: `search_sqlite`, `search_entity`, `get_conversation_messages`, `search_thinking`, `search_tool_calls`, `search_content`; 2 profile: `profile_conversations`, `query_profiles`; 1 rename (local only): `rename_local_untitled_conversations`; 1 delete: `delete_conversation`; 1 audit: `audit_conversations`; 2 branch: `get_conversation_branches`, `get_conversation_thread`; 2 extraction: `extract_attachments`, `extract_artifacts`; 8 graph: `graph_build`, `graph_query`, `graph_god_nodes`, `graph_neighbors`, `graph_shortest_path`, `graph_community`, `graph_surprising_connections`, `graph_export`; 1 projects: `list_projects`; 3 code sessions: `get_code_session`, `list_code_sessions`, `search_code_sessions` — **Update this line when adding/removing tools.**

**SQLite offline path** (`src/importers/`):

Import a Claude export JSON into a SQLite v2 database (4 regular tables + 2 FTS5 content-sync virtual tables + 6 triggers) for offline full-text search and entity analysis. CLI commands: `import-sqlite`, `extract-entities`, `profile`, `profile-query`, `rename-untitled`, `search-sqlite`, `search-entity`, `edit-history`, `search-attachments`, `main-branch`, `search-thinking`, `search-tools`, `search-content`, `audit`, `branches`, `thread`, `delete`, `delete-empty`.

MCP tools `search_sqlite`, `search_entity`, `get_conversation_messages`, `search_thinking`, `search_tool_calls`, `search_content`, `profile_conversations`, and `query_profiles` wrap the SQLite functions for Copilot use. Default db path: `.ccr-import.sqlite` in CWD.

**Knowledge graph path** (`src/graph/`):

Build a knowledge graph from extracted entities, tool calls, and conversations. Three node types (entity, conversation, tool) connected by co-occurrence, mentioned-in, and uses-tool edges. Two clustering methods: label propagation (topology-based) and k-means (feature-based, 7D vectors with silhouette auto-k). Interactive HTML visualization with searchable conversation sidebar, context menu, hash navigation, and Claude.ai deep-links for every conversation. Graph tables (`graph_nodes`, `graph_edges`, `graph_communities`) are derived artifacts built by `graph-build`, not by `import-sqlite`. CLI commands: `graph-build` (with `--method` and `--k` flags), `graph-query`, `graph-god-nodes` (with `--tools`, `--bridges`, `--bursts` flags), `graph-export`, `graph-path`.

## Key API Details

Claude.ai's internal (undocumented) API — no official API key, auth is via session cookies captured by Playwright:

- `GET /api/organizations` → org list
- `GET /api/organizations/{org}/chat_conversations` → conversation list
- `GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true` → full conversation tree

Conversations are trees (not linear) due to message edits creating branches. The primary branch is extracted by DFS following the last child at each node.

## Module Responsibilities

| File | What it owns |
|------|-------------|
| `src/types.ts` | All shared TypeScript interfaces — edit here when adding new data shapes |
| `src/api/client.ts` | All HTTP to Claude.ai; handles 401/403, rate limiting (1s delay) |
| `src/auth/claude-login.ts` | Playwright automation with Cloudflare bypass (custom user agent, `navigator.webdriver` spoofing) |
| `src/extractors/conversation.ts` | Tree-to-linear algorithm |
| `src/extractors/formatter.ts` | Three output formats: `markdown`, `json`, `compact` |
| `src/mcp/tools.ts` | Zod-validated MCP tool schemas and handlers (**33 tools**: 5 live API + 6 SQLite + 2 profile + 2 extraction + 1 delete + 1 stats + 1 audit + 2 branch + 1 projects + 8 graph + 1 rename-local + 3 code sessions) |
| `src/api/code-session-client.ts` | Typed client for `claude.ai/v1/sessions/<id>` endpoints (list/get/events/share-status); uses Playwright `BrowserContext.request` for Cloudflare bypass; auto-resolves orgId |
| `src/auth/discover-code-api.ts` | Playwright traffic capture for reverse-engineering undocumented Claude.ai API surfaces — used to discover the `/v1/sessions/<id>` family |
| `src/importers/import-code-session.ts` | Map a fetched `/v1/sessions/<id>/events` JSON dump into the v2 SQLite schema (additive, idempotent); skips control_* and result events |
| `src/importers/import-sqlite.ts` | Creates v2 schema (4 regular tables + 2 FTS5 content-sync tables + 6 triggers), bulk-inserts Claude export data |
| `src/importers/sqlite-search.ts` | FTS5 full-text search (messages + content blocks) with Porter stemming; searchThinking, searchByToolName, searchContent |
| `src/importers/entity-extract.ts` | Regex-based entity extraction: topics, URLs, UUIDs from messages and content_blocks |
| `src/importers/entity-search.ts` | Query messages by extracted entity value and type |
| `src/importers/conversation-profiler.ts` | Semantic profiler: 20 regex categories + structural metrics (code blocks, tool invocations, thinking, word count, duration) + per-sender profiling (human vs assistant) + category details; `conversation_profiles` table; auto-runs before graph-build |
| `src/importers/conversation-renamer.ts` | Auto-title untitled conversations: extracts titles from assistant answers (primary), topic entities (secondary), or first human message (fallback); strips markdown, skips boilerplate, caps at 80 chars |
| `src/importers/advanced-queries.ts` | Edit history, attachment search, getConversationTree(), branch enumeration, thread retrieval, audit (untitled/empty) |
| `src/graph/schema.ts` | Graph table DDL: `graph_nodes`, `graph_edges`, `graph_communities` (CREATE IF NOT EXISTS / DROP) |
| `src/graph/build.ts` | Entity + conversation + tool nodes; co-occurrence, mentioned-in, and uses-tool edges; degree + temporal enrichment; tool metadata on conversations |
| `src/graph/cluster.ts` | Dispatcher for label propagation or k-means clustering (`--method` flag) |
| `src/graph/kmeans.ts` | K-means++ with 7D feature vectors and silhouette-based auto-k selection |
| `src/graph/query.ts` | BFS subgraph search, neighbor lookup, community retrieval, shortest path |
| `src/graph/analyze.ts` | God nodes, bridge entities, temporal bursts, surprising connections, tool usage stats, question suggestions |
| `src/graph/export.ts` | Interactive HTML visualization with vis-network.js — conversation sidebar, context menu, hash navigation, Claude.ai deep-links |

## Code Conventions

- TypeScript strict mode, ES2022 target, NodeNext module resolution
- `import type` for type-only imports
- Named exports, one concern per file
- Async/await throughout; never swallow exceptions silently
- Session cookies written with mode `0o600`; never hardcode credentials
