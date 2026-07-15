---
title: File Versioning Rules
description: Required version headers and conventions for all source files in this repo
version: 2.0.0
created: 2026-04-15T17:15:45Z
last_updated: 2026-04-15T17:15:45Z
---

# File Versioning Rules

All source files in this repository **must** include version metadata using the appropriate format for their file type.

## Markdown files (.md) — YAML front matter

```yaml
---
title: Document Title
description: Brief purpose of this document
version: 1.0.0
created: YYYY-MM-DDTHH:MM:SSZ
last_updated: YYYY-MM-DDTHH:MM:SSZ
---
```

## TypeScript / JavaScript files (.ts, .js, .cjs) — JSDoc header

```typescript
/**
 * @file filename.ts
 * @description Brief purpose of this file
 * @version 1.0.0
 * @created YYYY-MM-DDTHH:MM:SSZ
 * @lastUpdated YYYY-MM-DDTHH:MM:SSZ
 */
```

Place after shebang line (`#!/usr/bin/env node`) if present.

## Shell scripts (.sh) — comment header

```bash
# @file filename.sh
# @description Brief purpose of this script
# @version 1.0.0
# @created YYYY-MM-DDTHH:MM:SSZ
# @lastUpdated YYYY-MM-DDTHH:MM:SSZ
```

Place after shebang line.

## JSON config files — exempt

JSON does not support comments. Config files (`tsconfig.json`, `.mcp.json`, `.prettierrc`, `.vscode/*.json`, `.claude/settings*.json`) are versioned by git only. The project-wide version lives in `package.json`.

## Files exempt from versioning

- `node_modules/`, `dist/` — generated
- `package-lock.json` — auto-generated
- Third-party libraries (`vis-network.min.js`)
- Generated artifacts (`graph.html`, `*.sqlite`)
- `.gitignore` — too simple

## Required fields

| Field | Format | Description |
|-------|--------|-------------|
| `version` | semver | `MAJOR.MINOR.PATCH` |
| `created` | ISO 8601 | UTC timestamp, set once, never changed |
| `last_updated` / `lastUpdated` | ISO 8601 | UTC timestamp, update on every content change |

## Version discipline

1. **Every commit that touches a versioned file must bump its version** — no exceptions.
2. **PATCH** = fixing numbers, typos, broken links, count corrections.
3. **MINOR** = new sections, new functions, new content.
4. **MAJOR** = structural reorganization, breaking interface changes.
5. **Never skip version numbers** — increment by exactly 1.
6. **Never downgrade a version**.

## Timestamp sourcing

Use `get_current_time` from the MCP time server (`.mcp.json`) for all timestamps. Fallback:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
```
