---
title: Conversation Semantic Profiler — Full Audit
description: Feature mapping between Generic Transcript Semantic Profiler and CCR codebase
version: 1.0.0
created: 2026-04-17T03:20:46Z
last_updated: 2026-04-17T03:20:46Z
---

# Conversation Semantic Profiler — Full Audit

## 1. Feature-by-Feature Breakdown of the Transcript Profiler

### 1.1 FIELD_MAP — Record Normalization

The profiler normalizes heterogeneous input records via `FIELD_MAP`:

| Field | Purpose | Transcript Fields Tried |
|-------|---------|------------------------|
| `recordId` | Unique ID for each transcript | `id`, `videoSlug`, `slug`, `episode` |
| `groupId` | Grouping key (course, series) | `group`, `courseSlug`, `category`, `series` |
| `title` | Display name | `title`, `videoTitle`, `name`, `episode_title` |
| `lines` | Array of timed text segments | `lines`, `transcript`, `segments`, `captions` |
| `lineText` | Text content of each line | `text`, `caption`, `content`, `words` |
| `lineStartMs` | Timestamp in milliseconds | `startMs`, `transcriptStartAt`, `start`, `time` |

### 1.2 CATEGORIES — 22 Regex Pattern Categories

Each category extracts occurrences of a semantic class from raw text:

| # | Category Key | Label | What It Detects |
|---|-------------|-------|-----------------|
| 1 | `filePaths` | File Paths & Extensions | `.py`, `.ts`, `.json`, etc. — any word ending in a known extension |
| 2 | `cliCommands` | CLI Commands | `docker`, `git`, `npm`, `kubectl`, `aws`, etc. |
| 3 | `codeKeywords` | Code Keywords | `function`, `class`, `async`, `import`, `return`, etc. |
| 4 | `codeIdentifiers` | Code Identifiers | camelCase and snake_case tokens |
| 5 | `urls` | URLs & Domains | `https://...`, `localhost:port`, `*.com/.io/.dev` |
| 6 | `portNumbers` | Port Numbers | `port 8080`, `:3000` |
| 7 | `apiEndpoints` | API Endpoints & HTTP Methods | `GET /api/...`, `POST`, `/v1/...` |
| 8 | `sqlStatements` | SQL / Database Keywords | `SELECT`, `JOIN`, `CREATE TABLE`, etc. |
| 9 | `envVars` | Environment Variables | `ALLCAPS_WORDS` with a stopword filter |
| 10 | `versionNumbers` | Version Numbers | `v1.2.3`, `python 3`, `node 18` |
| 11 | `crossReferences` | Cross-References | "as we saw", "in the last", "coming up" |
| 12 | `docReferences` | Documentation References | "the docs", "MDN", "Stack Overflow", "RFC" |
| 13 | `toolMentions` | External Tools & Software | VS Code, GitHub, Docker Desktop, Jupyter, etc. |
| 14 | `uiNavigation` | UI Navigation Instructions | "click on", "navigate to", "in the sidebar" |
| 15 | `exerciseFiles` | Downloadable Resources | "exercise files", "starter code", "clone the repo" |
| 16 | `definitions` | Definitions & Explanations | "is called", "defined as", "stands for" |
| 17 | `analogies` | Analogies & Examples | "for example", "think of it like", "similar to" |
| 18 | `bestPractices` | Best Practices | "you should always", "pro tip", "rule of thumb" |
| 19 | `warnings` | Warnings & Gotchas | "be careful", "common mistake", "pitfall" |
| 20 | `prerequisites` | Prerequisites & Setup | "you'll need", "install", "getting started" |
| 21 | `speakerTags` | Speaker Indicators | `- [Speaker]:` patterns |
| 22 | `nonSpeech` | Non-Speech Content | `(music)`, `(applause)`, `(laughter)` |

### 1.3 Core Analysis Pipeline (Implied from Structure)

1. **Text analysis** (`analyzeText`) — Run all 22 category regexes against concatenated text, count and collect matches
2. **Structure analysis** (`analyzeStructure`) — Word count, line count, duration, pacing metrics
3. **Per-record profiling** — Each transcript gets a semantic fingerprint (counts per category)
4. **Group aggregation** — Records grouped by `groupId`, stats aggregated across groups
5. **Cross-group comparison** — Compare category distributions between groups (courses)
6. **Top extractable content** — Surface the most "content-rich" records by category density
7. **JSON report output** — Write structured report to `--out <path>`

---

## 2. Concept Mapping Table: Transcript to Claude Conversation

| Transcript Concept | Claude Conversation Equivalent | CCR Location |
|--------------------|-------------------------------|--------------|
| Record (transcript) | Conversation | `conversations` table |
| `recordId` | `conversations.uuid` | `import-sqlite.ts` |
| `groupId` (course/series) | `conversations.project_uuid` | `import-sqlite.ts` |
| `title` | `conversations.name` | `import-sqlite.ts` |
| `lines` (timed segments) | Messages (chronological) | `messages` table |
| `lineText` | `messages.text` + `content_blocks.text_content` | `import-sqlite.ts` |
| `lineStartMs` (timestamp) | `messages.created_at` (ISO 8601) | `import-sqlite.ts` |
| Group (course) | Project | `conversations.project_uuid` |
| Cross-group comparison | Cross-project comparison | **Does not exist** |
| Speaker tags | `messages.sender` (`human` / `assistant`) | `import-sqlite.ts` |
| Non-speech content | Thinking blocks, tool calls | `content_blocks` where `block_type` = `thinking` / `tool_use` |
| Category regex matches | Entity extraction | `entity-extract.ts` |
| Semantic fingerprint | Per-conversation profile | **Does not exist** |
| JSON report | `getFullStats()` (partial) | `advanced-queries.ts` |

---

## 3. CCR Overlap Analysis

### 3.1 What CCR Already Does (Full or Partial Coverage)

| Profiler Feature | CCR Status | CCR Implementation | Gap |
|-----------------|------------|-------------------|-----|
| URL extraction | **Full** | `entity-extract.ts` regex for `https?://` URLs | None |
| UUID extraction | **Full** | `entity-extract.ts` regex for UUIDs | None |
| Topic extraction | **Partial** | `entity-extract.ts` hardcoded topic list (30 keywords) | Not extensible; no category-level semantic regex |
| Tool name extraction | **Full** | `entity-extract.ts` extracts from `tool_use` blocks | None — better than profiler (structured, not regex) |
| Full-text search | **Full** | `sqlite-search.ts` with FTS5 Porter stemming | None |
| Thinking block search | **Full** | `sqlite-search.ts` `searchThinking()` | None |
| Content block type filtering | **Full** | `sqlite-search.ts` `searchContent()` | None |
| Per-conversation stats | **Partial** | `getFullStats()` in `advanced-queries.ts` | No per-conversation semantic profile; only aggregate |
| Conversation grouping | **Partial** | `project_uuid` column exists; `list_projects` MCP tool | No cross-project aggregation/comparison |
| Temporal analysis | **Partial** | Monthly activity in `getFullStats()`; temporal bursts in `analyze.ts` | No per-conversation pacing/density metrics |
| Graph clustering | **Full** | `cluster.ts` (label-propagation), `kmeans.ts` (7D), `categorize.ts` (TF-IDF/embeddings) | None |
| Interactive visualization | **Full** | `export.ts` with vis-network.js | None |
| TF-IDF vectorization | **Full** | `categorize.ts` (500-term vocabulary, L2-normed) | None |
| LLM embeddings | **Full** | `categorize.ts` + `embeddings.ts` (Gemini) | None |

### 3.2 What the Profiler Adds That CCR Lacks

| New Capability | Value for Claude Conversations | Priority |
|---------------|-------------------------------|----------|
| **Multi-category semantic regex scanning** | Detect code keywords, CLI commands, file paths, API endpoints, SQL, env vars, version numbers in conversations | **High** — extends the 3-pattern entity extraction to 20+ semantic categories |
| **Per-conversation semantic fingerprint** | A vector of category counts per conversation — enables content-type detection (is this a coding conversation? a DevOps session? a SQL debugging thread?) | **High** — feeds into categorization and the graph |
| **Category density scoring** | Rank conversations by technical density per category (code-heavy vs. conceptual) | **Medium** — enables "find all SQL conversations" type queries |
| **Cross-group (cross-project) comparison** | Compare semantic profiles across projects to find thematic overlap or drift | **Medium** — useful for project portfolio analysis |
| **Structural analysis** | Word count, message count, avg message length, conversation pacing (messages per hour) | **Medium** — some data is in `getFullStats()` but not per-conversation |
| **Definitions/analogies/best-practices/warnings detection** | Detect pedagogical patterns in Claude's responses (when Claude explains, warns, gives examples) | **Low-Medium** — interesting for understanding Claude's teaching style |
| **File path / extension detection** | Detect which file types are discussed (`.ts`, `.py`, `.sql`) — richer than topic extraction | **Medium** — useful for code conversation profiling |
| **Environment variable detection** | Surface configuration-related discussions | **Low** |

---

## 4. Recommended CATEGORIES for Claude Conversations

### 4.1 Categories to Keep (Recontextualized from Transcripts)

| Category Key | Label | Regex (adapted) | Rationale |
|-------------|-------|-----------------|-----------|
| `filePaths` | File Paths & Extensions | Same regex | Claude conversations frequently reference files |
| `cliCommands` | CLI Commands | Same regex | Highly relevant — Claude helps with CLI tasks |
| `codeKeywords` | Code Keywords | Same regex | Core signal for code conversations |
| `codeIdentifiers` | Code Identifiers | Same regex | Detect specific variables/functions discussed |
| `urls` | URLs & Domains | **Already extracted** by `entity-extract.ts` — reuse, don't duplicate | Map to existing entity type |
| `portNumbers` | Port Numbers | Same regex | Relevant for web dev / DevOps conversations |
| `apiEndpoints` | API Endpoints | Same regex | REST API design conversations |
| `sqlStatements` | SQL Keywords | Same regex | Database-related conversations |
| `envVars` | Environment Variables | Same regex + stopword filter | Configuration discussions |
| `versionNumbers` | Version Numbers | Same regex | Dependency/upgrade conversations |
| `docReferences` | Documentation References | Same regex | When Claude references docs |
| `definitions` | Definitions & Explanations | Same regex | Claude's explanatory patterns |
| `bestPractices` | Best Practices & Advice | Same regex | Claude's recommendation patterns |
| `warnings` | Warnings & Gotchas | Same regex | Claude's cautionary patterns |

### 4.2 Categories to Drop

| Category Key | Reason |
|-------------|--------|
| `speakerTags` | Not applicable — Claude conversations have structured `sender` field |
| `nonSpeech` | Not applicable — no audio artifacts |
| `exerciseFiles` | Transcript-specific (video course resources) |
| `uiNavigation` | Partially relevant but low signal in chat context |
| `crossReferences` | Transcript-specific ("previous video") |
| `analogies` | Low signal — too many false positives in general text |

### 4.3 New Categories for Claude Conversations

| Category Key | Label | Detection Method | Rationale |
|-------------|-------|-----------------|-----------|
| `promptPatterns` | Prompt Engineering Patterns | Regex: `/\b(system prompt|few-shot|chain of thought|step by step|think carefully|let's think|role play|you are a|act as|pretend)\b/gi` | Detect meta-prompting patterns |
| `toolInvocations` | Tool Use Patterns | **Structural**: `content_blocks.block_type = 'tool_use'` — count per conversation | Already extracted; just aggregate into profile |
| `thinkingBlocks` | Reasoning Density | **Structural**: count of `block_type = 'thinking'` per conversation | Already in DB; surface as profile metric |
| `artifactTypes` | Artifact Generation | Regex on tool_use where `tool_name = 'artifacts'` + parse `input.type` | Detect what Claude generates (HTML, Python, etc.) |
| `errorPatterns` | Error Discussion | Regex: `/\b(error|exception|traceback|stack trace|bug|crash|undefined|null pointer|segfault|ENOENT|EACCES|404|500|403|timeout)\b/gi` | Debugging conversations |
| `packageNames` | Package/Library References | Regex: `/\b(npm|pip|cargo|gem|brew)\s+install\s+[\w@/-]+/gi` + known packages | Dependency-focused conversations |
| `gitOperations` | Git Workflow | Regex: `/\b(git\s+(commit|push|pull|merge|rebase|cherry-pick|stash|bisect|log|diff|branch|checkout|reset))\b/gi` | Version control conversations |
| `dockerOps` | Container Operations | Regex: `/\b(docker\s+(build|run|compose|push|pull|exec|logs)|Dockerfile|docker-compose|kubernetes|k8s|helm)\b/gi` | DevOps conversations |
| `codeBlocks` | Code Block Density | Count markdown triple-backtick blocks in message text | Quantify code-heaviness |
| `questionPatterns` | Question Types | Regex on human messages: `/^(how|what|why|when|where|can|could|should|is|are|do|does|will)\b/gi` | Classify conversation intent (question vs. instruction vs. request) |
| `editHistory` | Conversation Edits | **Structural**: count of messages with siblings (branch points) | Detect iteration-heavy conversations |
| `attachmentTypes` | Uploaded File Types | Parse `messages.attachments` JSON for `file_type` | What users upload (images, PDFs, code) |

---

## 5. Architecture Recommendation

### 5.1 File Location

**New file: `src/importers/conversation-profiler.ts`**

Rationale:
- It reads from the SQLite database (like all `src/importers/` modules)
- It produces derived data that feeds into both `getFullStats()` and graph analysis
- It does NOT belong in `src/graph/` because profiling is upstream of graph construction — the profile data should be extractable independently

### 5.2 Schema Addition

Add a new table to the SQLite schema (in `import-sqlite.ts` or as a separate migration):

```sql
CREATE TABLE IF NOT EXISTS conversation_profiles (
  conversation_uuid TEXT PRIMARY KEY REFERENCES conversations(uuid),
  total_words INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  human_messages INTEGER DEFAULT 0,
  assistant_messages INTEGER DEFAULT 0,
  avg_message_length REAL DEFAULT 0,
  thinking_blocks INTEGER DEFAULT 0,
  tool_use_count INTEGER DEFAULT 0,
  code_block_count INTEGER DEFAULT 0,
  branch_points INTEGER DEFAULT 0,
  duration_minutes REAL DEFAULT 0,
  -- Category counts (one column per category)
  cat_file_paths INTEGER DEFAULT 0,
  cat_cli_commands INTEGER DEFAULT 0,
  cat_code_keywords INTEGER DEFAULT 0,
  cat_code_identifiers INTEGER DEFAULT 0,
  cat_urls INTEGER DEFAULT 0,
  cat_port_numbers INTEGER DEFAULT 0,
  cat_api_endpoints INTEGER DEFAULT 0,
  cat_sql_statements INTEGER DEFAULT 0,
  cat_env_vars INTEGER DEFAULT 0,
  cat_version_numbers INTEGER DEFAULT 0,
  cat_doc_references INTEGER DEFAULT 0,
  cat_definitions INTEGER DEFAULT 0,
  cat_best_practices INTEGER DEFAULT 0,
  cat_warnings INTEGER DEFAULT 0,
  cat_prompt_patterns INTEGER DEFAULT 0,
  cat_error_patterns INTEGER DEFAULT 0,
  cat_package_names INTEGER DEFAULT 0,
  cat_git_operations INTEGER DEFAULT 0,
  cat_docker_ops INTEGER DEFAULT 0,
  cat_question_patterns INTEGER DEFAULT 0,
  -- JSON blob for top matches per category (top 5 unique values)
  category_details TEXT,
  -- Computed classification
  primary_type TEXT,       -- e.g., 'coding', 'devops', 'conceptual', 'debugging'
  technical_density REAL   -- 0.0 to 1.0
);
```

### 5.3 CLI Command

**Command name: `ccr profile <dbPath>`**

```
ccr profile <dbPath>                    # Profile all conversations
ccr profile <dbPath> --conversation <uuid>  # Profile one conversation
ccr profile <dbPath> --project <uuid>   # Profile conversations in a project
ccr profile <dbPath> --compare          # Cross-project comparison
ccr profile <dbPath> --top <N>          # Show top N most technically dense
ccr profile <dbPath> --category <name>  # Filter by dominant category
ccr profile <dbPath> --json             # Output as JSON
```

### 5.4 MCP Tool

Add one MCP tool: `profile_conversations` with parameters:
- `conversation_uuid` (optional) — profile a single conversation
- `project_uuid` (optional) — profile a project
- `category` (optional) — filter by semantic category
- `limit` (optional) — number of results

### 5.5 Integration Points

1. **Entity extraction** (`entity-extract.ts`): The profiler's category regexes should extend (not replace) the existing entity extraction. The 3 current patterns (`uuid`, `url`, `topic`) stay; the 20 new categories add new entity types or populate the `conversation_profiles` table directly.

2. **Graph build** (`graph/build.ts`): After profiling, `primary_type` and `technical_density` from `conversation_profiles` can enrich conversation nodes in the graph (add to `graph_nodes.meta` or as new columns).

3. **Categorization** (`graph/categorize.ts`): The semantic profile vector (20 category counts + structural metrics) can serve as an additional feature set alongside TF-IDF/embeddings for k-means clustering. This is a **direct upgrade** to the existing categorization pipeline.

4. **Stats** (`advanced-queries.ts`): `getFullStats()` can include aggregate profile data (most common primary_type, avg technical_density, category distribution across all conversations).

5. **HTML export** (`graph/export.ts`): Conversation nodes in the graph visualization can be colored by `primary_type` — a new color mode option alongside community/time/type/category.

### 5.6 Execution Order in Pipeline

```
import-sqlite → extract-entities → profile → graph-build → categorize → graph-export
                                    ^^^^^
                                    NEW STEP
```

The `profile` command runs AFTER entity extraction (so it can reference entities) and BEFORE graph-build (so graph nodes can use profile data). Alternatively, `graph-build` can call `profile` automatically, like it already calls `extractEntities`.

---

## 6. Data Source Mapping: FIELD_MAP Equivalent for CCR

The transcript profiler's `FIELD_MAP` maps heterogeneous input fields to a canonical schema. CCR's equivalent maps SQLite tables to profiler inputs:

### 6.1 Record-Level Mapping (One Row per Conversation)

| FIELD_MAP Key | Transcript Source | CCR SQLite Equivalent | SQL |
|--------------|-------------------|----------------------|-----|
| `recordId` | `r.id \|\| r.videoSlug` | `conversations.uuid` | `SELECT uuid FROM conversations` |
| `groupId` | `r.group \|\| r.courseSlug` | `conversations.project_uuid` | `SELECT project_uuid FROM conversations` |
| `title` | `r.title \|\| r.videoTitle` | `conversations.name` | `SELECT name FROM conversations` |
| `lines` | `r.lines \|\| r.transcript` | Messages + content blocks | See below |
| `lineText` | `l.text \|\| l.caption` | Combined text from messages and content blocks | See below |
| `lineStartMs` | `l.startMs \|\| l.start` | `messages.created_at` (convert to epoch ms) | `strftime('%s', created_at) * 1000` |

### 6.2 Line-Level Mapping (Text Segments)

The transcript profiler processes `lines[]` — individual timed text segments. In CCR, the equivalent text segments come from **two sources** that must be combined:

**Source A: Message text** (human prompts + assistant responses)
```sql
SELECT uuid, sender, text, created_at
FROM messages
WHERE conversation_uuid = ?
ORDER BY created_at ASC
```

**Source B: Content blocks** (thinking, text, tool inputs/outputs)
```sql
SELECT message_uuid, block_type, text_content, tool_name, tool_input
FROM content_blocks
WHERE conversation_uuid = ?
  AND text_content IS NOT NULL
ORDER BY message_uuid, block_index
```

### 6.3 Profiling Query — Full Text for One Conversation

```sql
SELECT
  c.uuid AS record_id,
  c.project_uuid AS group_id,
  c.name AS title,
  GROUP_CONCAT(
    COALESCE(m.text, '') || ' ' ||
    COALESCE(
      (SELECT GROUP_CONCAT(cb.text_content, ' ')
       FROM content_blocks cb
       WHERE cb.message_uuid = m.uuid AND cb.text_content IS NOT NULL),
      ''
    ),
    ' '
  ) AS full_text,
  COUNT(m.uuid) AS message_count,
  SUM(CASE WHEN m.sender = 'human' THEN 1 ELSE 0 END) AS human_count,
  SUM(CASE WHEN m.sender = 'assistant' THEN 1 ELSE 0 END) AS assistant_count,
  MIN(m.created_at) AS first_message_at,
  MAX(m.created_at) AS last_message_at
FROM conversations c
LEFT JOIN messages m ON m.conversation_uuid = c.uuid
WHERE c.uuid = ?
GROUP BY c.uuid
```

### 6.4 Profiling by Sender (Human vs. Assistant Profiles)

A key advantage CCR has over the transcript profiler: conversations have **structured sender roles**. The profiler should generate separate category profiles for human messages and assistant messages:

- **Human profile**: What the user asks about (their domain, their stack, their problems)
- **Assistant profile**: What Claude discusses (its recommendations, code it writes, tools it uses)

This enables queries like "find all conversations where I asked about Docker but Claude responded with Kubernetes."

---

## 7. Summary of Recommendations

### Build (in order of priority)

1. **`src/importers/conversation-profiler.ts`** — Core profiling engine with 20 category regexes, per-conversation fingerprinting, and `conversation_profiles` table
2. **CLI `profile` command** in `src/index.ts` — Run profiling, display results, filter by category
3. **MCP `profile_conversations` tool** in `src/mcp/tools.ts` — Expose profiling to Copilot
4. **Integration into `categorize.ts`** — Use profile vectors as additional features for k-means
5. **Cross-project comparison** — Aggregate profiles by `project_uuid`, compute deltas

### Skip

- Speaker tags, non-speech, exercise files, UI navigation categories (transcript-specific)
- JSONL streaming (CCR uses SQLite, not JSONL)
- `FIELD_MAP` polymorphism (CCR has a fixed schema)

### Reuse

- Entity extraction pipeline (`entity-extract.ts`) — extend with new entity types, don't duplicate
- TF-IDF and embedding infrastructure (`categorize.ts`) — profile vectors feed into the same k-means
- `getFullStats()` — extend to include profile aggregates
- Graph visualization (`export.ts`) — add `primary_type` color mode
