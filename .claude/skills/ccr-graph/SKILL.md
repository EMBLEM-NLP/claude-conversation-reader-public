---
name: ccr-graph
description: This skill should be used to build, query, or explore the knowledge graph derived from claude-conversation-reader's imported conversations — entities, conversations, and tool nodes linked by co-occurrence/mentioned-in/uses-tool edges. Use when the user asks to find "god nodes"/most-connected topics, the shortest path between two concepts, surprising cross-topic connections, or wants an interactive HTML graph visualization of their conversation history.
compatibility: Requires a populated .ccr-import.sqlite (built by /ccr's offline import path — see Step 0). Node.js 18+.
metadata:
  version: "1.0.0"
  created: "2026-07-15T20:05:23Z"
  last_updated: "2026-07-15T20:05:23Z"
---

# CCR Knowledge Graph

Build and explore a knowledge graph over imported Claude.ai conversations: three node types (entity, conversation, tool) connected by co-occurrence, mentioned-in, and uses-tool edges, with two clustering methods (label propagation or k-means). All commands run from `${CLAUDE_PROJECT_DIR}` via `npm run dev -- <command>`.

This is a distinct subsystem from basic conversation fetching/context-injection — see `/ccr` for that.

## Step 0 — Prerequisite: a populated database

Graph commands read from a SQLite db built by the offline import path, not the live API:

```bash
npm run dev -- import-sqlite <export.json> .ccr-import.sqlite   # from claude.ai's official data export
npm run dev -- extract-entities .ccr-import.sqlite               # topics, URLs, UUIDs
```

If `.ccr-import.sqlite` doesn't exist yet in the project directory, run these first — graph commands will error otherwise. `conversation_profiles` (semantic categorization) auto-runs before graph-build if not already present. `.ccr-import.sqlite` is gitignored — never commit it, it contains real conversation content.

## Step 1 — Build the graph

```bash
npm run dev -- graph-build .ccr-import.sqlite
```

Options:
- `--method kmeans` — k-means clustering (feature-based, 7D vectors, silhouette auto-k) instead of the default label propagation (topology-based)
- `--k <n>` — force a specific cluster count (only with `--method kmeans`)

Writes/overwrites `graph_nodes`, `graph_edges`, `graph_communities` tables — these are derived artifacts, safe to rebuild any time.

## Step 2 — Explore

```bash
npm run dev -- graph-query .ccr-import.sqlite "<keyword>" [--depth N]     # BFS subgraph search
npm run dev -- graph-god-nodes .ccr-import.sqlite                        # most-connected entities
npm run dev -- graph-god-nodes .ccr-import.sqlite --tools                # tool usage stats instead
npm run dev -- graph-god-nodes .ccr-import.sqlite --bridges               # entities connecting communities
npm run dev -- graph-god-nodes .ccr-import.sqlite --bursts                # temporal burst patterns
npm run dev -- graph-path .ccr-import.sqlite "<concept A>" "<concept B>"  # shortest path between two concepts
```

## Step 3 — Visualize

```bash
npm run dev -- graph-export .ccr-import.sqlite graph.html
```

Options:
- `--max-nodes <n>` — limit graph size (default 50)
- `--seed <entity>` — ego graph centered on one entity
- `--entity-only` — exclude conversation/tool nodes, entities only

Produces an interactive HTML file (vis-network.js) with a searchable conversation sidebar, context menu, hash navigation, and Claude.ai deep-links per conversation — open directly in a browser, no server needed. `graph.html` is gitignored — it embeds real conversation titles/links, never commit it.

## Reference: equivalent MCP tools (when connected)

`graph_build`, `graph_query`, `graph_god_nodes`, `graph_neighbors`, `graph_shortest_path`, `graph_community`, `graph_surprising_connections`, `graph_export`.

## Gotchas

- Graph tables are **derived**, not created by `import-sqlite` — always run `graph-build` at least once after importing/re-importing before querying.
- `graph-build` is offline/local-only — it never touches the live claude.ai API, so it works regardless of session expiry.
- Re-running `graph-build` after new imports fully rebuilds clustering; there's no incremental graph update — for that, re-import then re-build.
