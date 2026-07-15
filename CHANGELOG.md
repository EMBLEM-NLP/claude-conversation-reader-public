---
title: Changelog
description: All notable changes to claude-conversation-reader, organized by version
version: 2.0.0
created: 2026-04-15T21:10:12Z
last_updated: 2026-04-15T21:10:12Z
---

# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.1.0] — 2026-04-16

Post-launch features, bug fixes, and infrastructure.

### Added
- **Projects support** — `projects` CLI command and `list_projects` MCP tool; discovered `/api/organizations/{org}/projects` endpoint returning 128 projects with Claude.ai links; `project_uuid` column added to SQLite schema (`259c28a`)
- **Stats command** — `stats` CLI and `conversation_stats` MCP tool; comprehensive usage statistics: 10,861 prompts, 21K messages, 115K content blocks, monthly bar chart, top tools/conversations (`0ad3ce9`)
- **Edge CDP cookie extraction** — `scripts/extract-edge-cookies.cjs` uses `chrome-remote-interface` to connect via Chrome DevTools Protocol and extract all cookies including HttpOnly; bypasses v20 App Bound encryption (`1fa65b8`)
- **Conversation deletion** — 151 empty conversations deleted from Claude.ai + local SQLite via `delete-empty --yes`

### Fixed
- **Tree flattener** — conversations with all root-level messages (no parent links) now fall back to chronological order instead of returning only 1 message
- **Pre-push hook** catches MCP tool count mismatches between docs and code
- **Prepare-commit-msg hook** blocks sensitive patterns in commit messages

## [1.0.0] — 2026-04-15

First stable release. 28 CLI commands, 25 MCP tools, knowledge graph with interactive visualization.

### Added
- **Knowledge graph** — 8 modules in `src/graph/` with 3 node types (entity, conversation, tool), 3 edge types (co-occurrence, mentioned-in, uses-tool), label propagation + k-means clustering, and interactive HTML visualization with vis-network.js (`1232d64`, `8d993d7`, `6bc4b30`, `e347698`)
- **Conversation sidebar** in graph export — searchable list of all 1,795 conversations with Claude.ai deep-links, context menu, hash navigation (`8d993d7`)
- **Tool enrichment** — 217 tool nodes, 4,761 uses-tool edges, tool co-occurrence, conversation tool metadata, `--tools` flag on `graph-god-nodes` (`6bc4b30`)
- **K-means clustering** — k-means++ with 7D feature vectors, silhouette-based auto-k selection, `--method kmeans` and `--k N` flags (`e347698`)
- **Branch/thread navigation** — `branches` and `thread` CLI commands to enumerate and view all conversation branches from the DAG tree structure (`dfcfee0`)
- **Conversation audit** — `audit` command with `--untitled` and `--empty` flags; `audit_conversations` MCP tool (`3bf9f4a`)
- **Conversation deletion** — `delete` and `delete-empty` CLI commands with `--dry-run`, `--yes`, `--local-only` flags; `delete_conversation` MCP tool (`c7d3696`)
- **Cookie login mode** — `login --cookie <string>` for manual cookie paste from browser DevTools (`88b5d4e`)
- **Edge cookie extraction** — `scripts/extract-edge-cookies.cjs` for automated cookie capture via Playwright CDP (`88b5d4e`)
- **Markdown versioning protocol** — YAML front matter on all `.md` files, MCP time server (`.mcp.json`), `.claude/rules/markdown-frontmatter.md` (`30f5fdf`)
- **File version headers** — JSDoc `@version`/`@created`/`@lastUpdated` on all 23 `.ts` files, `.js`, `.cjs`, `.sh` scripts (`02bcae9`)
- **Git hooks** — pre-commit (typecheck, lint, sensitive file guard), pre-push (build, count audit), prepare-commit-msg (sensitive pattern filter), stop (uncommitted/unpushed check) (`02bcae9`, `30f5fdf`)
- **8 graph MCP tools** — `graph_build`, `graph_query`, `graph_god_nodes`, `graph_neighbors`, `graph_shortest_path`, `graph_community`, `graph_surprising_connections`, `graph_export`
- **3 branch/audit MCP tools** — `get_conversation_branches`, `get_conversation_thread`, `audit_conversations`
- **`vis-network`** and **`zod`** added as explicit dependencies

### Changed
- Package version bumped from `0.1.0` to `1.0.0`
- `entityOnly` default flipped to `false` in graph export (conversations visible by default)
- API client now supports DELETE method for conversation deletion
- `ClaudeApiClient` interface extended with `deleteConversation()`
- SQLite schema adds `idx_conv_name` index on `conversations.name`
- Graph schema adds `tool_count` and `tool_names` columns to `graph_nodes`
- Playwright login improved with `bringToFront()` and fixed viewport for better visibility

## [0.2.0] — 2026-04-13

Schema v2 with content blocks and full-text search across all block types.

### Added
- **Schema v2** — `content_blocks` table with FTS5 content-sync virtual tables and 6 auto-sync triggers (`2719368`)
- **Content block search** — `search-thinking`, `search-tools`, `search-content` CLI commands (`2719368`)
- **6 SQLite MCP tools** — `search_sqlite`, `search_entity`, `get_conversation_messages`, `search_thinking`, `search_tool_calls`, `search_content` (`2719368`)
- **Entity extraction** — regex-based extraction of topics, URLs, UUIDs from messages and content blocks (`eab4168`)
- **Advanced queries** — `edit-history`, `search-attachments`, `main-branch` CLI commands (`eab4168`)
- **5 specialist agents** — api, auth, importer, mcp, rag-kg (`9afd8b6`, `eab4168`)

### Fixed
- Commands registered before `program.parse()` to prevent Commander.js errors (`1b96fb5`)
- 17 issues across types, error handling, security, and tooling (`678fb04`)

## [0.1.0] — 2026-04-11

Initial release. CLI + MCP server for reading Claude.ai conversations.

### Added
- **Project scaffold** — TypeScript strict mode, ES2022, NodeNext modules, Commander.js CLI, MCP SDK (`33b2aed`)
- **Playwright authentication** — browser-based login with Cloudflare bypass, session cookie persistence (`789896b`)
- **Live API client** — `getOrganizations`, `listConversations`, `getConversation` against Claude.ai internal REST API (`33b2aed`)
- **Conversation tree flattener** — DAG-to-linear extraction following last child at each node (`33b2aed`)
- **3 output formats** — markdown, JSON, compact XML (`33b2aed`)
- **5 live API MCP tools** — `claude_login`, `list_conversations`, `get_conversation`, `search_conversations`, `get_conversation_as_context` (`33b2aed`)
- **SQLite FTS5 import** — `import-sqlite` and `extract-entities` CLI commands (`eab4168`)
- **VS Code integration** — Copilot instructions, `@claude-reader` agent (`9afd8b6`)
- **README** with CLI reference, MCP tool table, architecture diagram (`789896b`)
