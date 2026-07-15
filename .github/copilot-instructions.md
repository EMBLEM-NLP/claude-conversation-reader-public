---
title: Claude Conversation Reader — Project Guidelines
description: Project-wide Copilot guidelines for VS Code integration with claude-conversation-reader
version: 3.0.0
created: 2025-04-11T00:00:00Z
last_updated: 2026-04-16T00:00:00Z
---

# Claude Conversation Reader — Project Guidelines

## Project Overview
MCP server + CLI tool (Node.js/TypeScript) that authenticates to Claude.ai via Playwright, reads conversation threads via the internal web API, and exposes them to GitHub Copilot via MCP tools and custom agents.

## Architecture
- **Auth**: Playwright headless browser handles Claude.ai login (email + verification code or Google SSO), captures session cookies
- **API Client**: Direct HTTP (fetch) with session cookies against `https://claude.ai/api/organizations/{org}/chat_conversations`
- **Extractors**: Tree flattener (conversation DAG → linear thread), formatter (Markdown/JSON/compact), search
- **MCP Server**: `@modelcontextprotocol/sdk` with 27 tools: 5 live API (`claude_login`, `list_conversations`, `get_conversation`, `search_conversations`, `get_conversation_as_context`), 6 SQLite offline (`search_sqlite`, `search_entity`, `get_conversation_messages`, `search_thinking`, `search_tool_calls`, `search_content`), 1 delete (`delete_conversation`), 1 audit (`audit_conversations`), 2 branch (`get_conversation_branches`, `get_conversation_thread`), 8 graph (`graph_build`, `graph_query`, `graph_god_nodes`, `graph_neighbors`, `graph_shortest_path`, `graph_community`, `graph_surprising_connections`, `graph_export`), 1 stats (`conversation_stats`), 1 projects (`list_projects`)
- **CLI**: Commander.js entry with 30 subcommands: `login`, `status`, `logout`, `list`, `get`, `search`, `import-sqlite`, `search-sqlite`, `search-entity`, `extract-entities`, `edit-history`, `search-attachments`, `main-branch`, `search-thinking`, `search-tools`, `search-content`, `delete`, `delete-empty`, `audit`, `branches`, `thread`, `stats`, `projects`, `graph-build`, `graph-query`, `graph-god-nodes`, `graph-export`, `graph-path`
- **SQLite Importers**: Import Claude JSON exports into a local SQLite v2 database (4 regular tables + 2 FTS5 content-sync virtual tables + 6 triggers) for offline full-text search, thinking block search, tool call search, and entity analysis
- **Knowledge Graph**: Three node types (entity, conversation, tool) with co-occurrence, mentioned-in, and uses-tool edges. Label propagation + k-means clustering. Interactive HTML with searchable conversation sidebar, context menu, and Claude.ai deep-links

## Key API Reference (Claude.ai internal, undocumented)
- **Organizations**: `GET /api/organizations` → `[{ uuid, name }]`
- **List Conversations**: `GET /api/organizations/{org}/chat_conversations` → `[{ uuid, name, created_at, updated_at }]`
- **Get Conversation**: `GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true` → full conversation tree
- **Auth**: Session cookies (no API key). Cookies captured via Playwright after browser login.
- **Rate limiting**: 1s delay between requests to avoid account flagging.
- **Conversations are trees** (branching on message edits), not linear. The extractor walks the primary branch.

## Code Style
- TypeScript strict mode, ES2022 target, NodeNext modules
- Use `import type` for type-only imports
- Prefer `async/await` over raw promises
- Use named exports, one concern per file
- Error handling: wrap API calls with descriptive errors, never swallow exceptions silently

## Security Rules
- **NEVER hardcode credentials** — authentication is browser-based, cookies stored in `.session.json`
- **NEVER commit `.env` or `.session.json`** — both are gitignored
- Cookie files (`.session.json`) are written with mode 0o600
- All URL components are encoded with `encodeURIComponent`
- Rate-limit API calls (~1s delay between requests)

## Build & Test
- `npm run dev` — Run CLI with tsx
- `npm run dev:server` — Run MCP server with tsx
- `npm run build` — Compile to dist/
- `npm run typecheck` — Type checking only

## Directory Structure
```
src/
├── index.ts              # CLI entry (Commander.js)
├── server.ts             # MCP server entry
├── types.ts              # Shared TypeScript interfaces
├── auth/
│   ├── claude-login.ts   # Playwright Claude.ai login
│   └── session.ts        # Cookie persistence & validation
├── api/
│   └── client.ts         # Claude.ai internal API wrapper
├── extractors/
│   ├── conversation.ts   # Tree → linear thread flattener
│   ├── formatter.ts      # Markdown/JSON/compact output
│   └── search.ts         # Search by title/date/keyword
├── importers/
│   ├── import-sqlite.ts  # Claude JSON export → SQLite v2 (4 tables + 2 FTS5 + 6 triggers)
│   ├── sqlite-search.ts  # FTS5 search: messages, thinking, tool calls, content blocks
│   ├── entity-extract.ts # Regex entity extraction (topics, URLs, UUIDs)
│   ├── entity-search.ts  # Query by extracted entity
│   └── advanced-queries.ts # Edit history, attachments, getConversationTree()
├── graph/
│   ├── schema.ts         # Graph table DDL (graph_nodes, graph_edges, graph_communities)
│   ├── build.ts          # Entity + conversation + tool nodes, 3 edge types, tool metadata
│   ├── cluster.ts        # Dispatcher: label-propagation or k-means
│   ├── kmeans.ts         # K-means++ with 7D feature vectors and auto-k
│   ├── query.ts          # BFS subgraph search, neighbors, shortest path
│   ├── analyze.ts        # God nodes, bridge entities, temporal bursts, tool stats, suggestions
│   ├── export.ts         # Interactive HTML with sidebar, context menu, vis-network.js
│   └── index.ts          # Barrel export
└── mcp/
    └── tools.ts          # MCP tool definitions & handlers (live API + SQLite + graph)
```

## SQLite Offline Path
Import a Claude export JSON into a local SQLite v2 database for offline search:
- **Import**: `npm run dev -- import-sqlite <export.json> .ccr-import.sqlite`
- **Full-text search**: `npm run dev -- search-sqlite .ccr-import.sqlite "query"`
- **Entity extraction**: `npm run dev -- extract-entities .ccr-import.sqlite`
- **Entity search**: `npm run dev -- search-entity .ccr-import.sqlite "playwright"`
- **Edit history**: `npm run dev -- edit-history .ccr-import.sqlite <message-uuid>`
- **Attachments**: `npm run dev -- search-attachments .ccr-import.sqlite "filename"`
- **Main branch**: `npm run dev -- main-branch .ccr-import.sqlite <conversation-uuid>`
- **Thinking search**: `npm run dev -- search-thinking .ccr-import.sqlite "query"`
- **Tool search**: `npm run dev -- search-tools .ccr-import.sqlite "bash_tool"`
- **Content search**: `npm run dev -- search-content .ccr-import.sqlite "query" --type thinking`

MCP tools `search_sqlite`, `search_entity`, `get_conversation_messages`, `search_thinking`, `search_tool_calls`, and `search_content` wrap the above for Copilot use. Default db path: `.ccr-import.sqlite` in CWD.

## Knowledge Graph
Build a knowledge graph from extracted entities for exploring relationships across conversations:
- **Build**: `npm run dev -- graph-build .ccr-import.sqlite` (extract → build → cluster; `--method kmeans`, `--k N`)
- **Query**: `npm run dev -- graph-query .ccr-import.sqlite "typescript" --depth 2`
- **God nodes**: `npm run dev -- graph-god-nodes .ccr-import.sqlite` (also `--tools`, `--bridges`, `--bursts`)
- **Export**: `npm run dev -- graph-export .ccr-import.sqlite graph.html --max-nodes 50 --seed "react"`
- **Path**: `npm run dev -- graph-path .ccr-import.sqlite "typescript" "playwright"`

Graph tables (`graph_nodes`, `graph_edges`, `graph_communities`) are derived artifacts — rebuilt independently of `import-sqlite`. MCP tools `graph_build`, `graph_query`, `graph_god_nodes`, `graph_neighbors`, `graph_shortest_path`, `graph_community`, `graph_surprising_connections`, and `graph_export` wrap the above for Copilot use.
