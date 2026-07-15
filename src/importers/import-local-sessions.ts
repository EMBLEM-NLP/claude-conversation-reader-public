/**
 * @file import-local-sessions.ts
 * @description Import local Claude Code JSONL session files into the existing SQLite schema.
 *              Adds sessions alongside Claude export data; uses INSERT OR REPLACE for idempotency.
 *              Marks locally-imported sessions with account_uuid='local-claude-code' for filtering.
 * @version 1.0.0
 * @created 2026-05-26T22:22:52Z
 * @lastUpdated 2026-05-26T22:22:52Z
 */

import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { createInterface } from 'readline';
import Database from 'better-sqlite3';
import { listLocalSessions, findLocalSessionFile } from './session-reader.js';

// ── Public interface ─────────────────────────────────────────────

export interface ImportLocalSessionsOptions {
  /** SQLite database path (default: .ccr-import.sqlite in CWD) */
  dbPath: string;
  /** Source directory to scan (default: ~/.claude/projects/) */
  sessionsDir?: string;
  /** Only import specific session IDs or paths */
  filter?: string[];
  /** Overwrite sessions already in DB (default: skip) */
  force?: boolean;
  /** Progress callback */
  onProgress?: (msg: string) => void;
}

export interface ImportLocalSessionsResult {
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  messageCount: number;
  blockCount: number;
}

// Marker value stored in account_uuid to identify local sessions
export const LOCAL_SESSION_MARKER = 'local-claude-code';

// ── Raw JSONL types (mirrors session-reader.ts internals) ────────

interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string;
}

interface RawMessage {
  role?: 'user' | 'assistant';
  content?: string | RawContentBlock[];
  model?: string;
  id?: string;
  stop_reason?: string;
}

interface RawEntry {
  type: string;
  uuid: string;
  parentUuid?: string;
  timestamp: string;
  message: RawMessage;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
}

// ── Schema initializer (non-destructive — IF NOT EXISTS) ─────────

const SCHEMA_INIT_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    uuid TEXT PRIMARY KEY,
    name TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    account_uuid TEXT,
    project_uuid TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);
  CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at);
  CREATE INDEX IF NOT EXISTS idx_conv_name ON conversations(name);
  CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_uuid);

  CREATE TABLE IF NOT EXISTS messages (
    uuid TEXT PRIMARY KEY,
    conversation_uuid TEXT NOT NULL REFERENCES conversations(uuid),
    sender TEXT NOT NULL,
    text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    parent_message_uuid TEXT,
    attachments TEXT,
    files TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_uuid);
  CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender);
  CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_msg_conv_created ON messages(conversation_uuid, created_at);
  CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_message_uuid);

  CREATE TABLE IF NOT EXISTS content_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_uuid TEXT NOT NULL REFERENCES messages(uuid),
    conversation_uuid TEXT NOT NULL,
    block_index INTEGER NOT NULL,
    block_type TEXT NOT NULL,
    text_content TEXT,
    tool_name TEXT,
    tool_use_id TEXT,
    tool_input TEXT,
    is_error INTEGER,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cb_message ON content_blocks(message_uuid);
  CREATE INDEX IF NOT EXISTS idx_cb_type ON content_blocks(block_type);
  CREATE INDEX IF NOT EXISTS idx_cb_tool ON content_blocks(tool_name) WHERE tool_name IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_cb_conv ON content_blocks(conversation_uuid);

  CREATE TABLE IF NOT EXISTS entities (
    entity TEXT,
    type TEXT,
    message_uuid TEXT,
    conversation_uuid TEXT,
    PRIMARY KEY (entity, type, message_uuid)
  );
  CREATE INDEX IF NOT EXISTS idx_entities_conv ON entities(conversation_uuid);
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

  CREATE TABLE IF NOT EXISTS projects (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );

  -- FTS5 tables and triggers created only if absent
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text,
    content='messages',
    content_rowid='rowid',
    tokenize='porter'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS content_blocks_fts USING fts5(
    text_content,
    content='content_blocks',
    content_rowid='id',
    tokenize='porter'
  );
`;

// Triggers must be created via individual statements (SQLite doesn't allow IF NOT EXISTS on triggers).
// We check existence manually before creating.
function ensureTriggers(db: Database.Database): void {
  const existing = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const triggers: Array<[string, string]> = [
    [
      'messages_ai',
      `CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
       END`,
    ],
    [
      'messages_ad',
      `CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
       END`,
    ],
    [
      'messages_au',
      `CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
       END`,
    ],
    [
      'content_blocks_ai',
      `CREATE TRIGGER content_blocks_ai AFTER INSERT ON content_blocks BEGIN
        INSERT INTO content_blocks_fts(rowid, text_content) VALUES (new.id, new.text_content);
       END`,
    ],
    [
      'content_blocks_ad',
      `CREATE TRIGGER content_blocks_ad AFTER DELETE ON content_blocks BEGIN
        INSERT INTO content_blocks_fts(content_blocks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
       END`,
    ],
    [
      'content_blocks_au',
      `CREATE TRIGGER content_blocks_au AFTER UPDATE ON content_blocks BEGIN
        INSERT INTO content_blocks_fts(content_blocks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
        INSERT INTO content_blocks_fts(rowid, text_content) VALUES (new.id, new.text_content);
       END`,
    ],
  ];
  for (const [name, sql] of triggers) {
    if (!existing.has(name)) db.exec(sql);
  }
}

// ── Main import function ─────────────────────────────────────────

export async function importLocalSessions(
  opts: ImportLocalSessionsOptions,
): Promise<ImportLocalSessionsResult> {
  const { dbPath, force = false, onProgress } = opts;
  const log = onProgress ?? (() => {});

  // ── Resolve files list ────────────────────────────────────────
  let filePairs: Array<{ path: string; sessionId: string; cwd: string }>;

  if (opts.filter && opts.filter.length > 0) {
    // Import only specified IDs/paths
    filePairs = [];
    for (const f of opts.filter) {
      if (f.includes('/') || f.includes('\\') || f.endsWith('.jsonl')) {
        // Treat as a direct path
        try {
          await stat(f);
          const sessionId = f.split(/[\\/]/).pop()!.replace('.jsonl', '');
          filePairs.push({ path: f, sessionId, cwd: '' });
        } catch {
          log(`  skip (not found): ${f}`);
        }
      } else {
        // Search by session ID
        const found = await findLocalSessionFile(f);
        if (found) {
          filePairs.push({ path: found, sessionId: f, cwd: '' });
        } else {
          log(`  skip (not found): ${f}`);
        }
      }
    }
  } else {
    log('Scanning ~/.claude/projects/...');
    filePairs = await listLocalSessions();
    log(`  Found ${filePairs.length} session files`);
  }

  // ── Open DB, init schema ──────────────────────────────────────
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_INIT_SQL);
  ensureTriggers(db);

  const insertConv = db.prepare(
    `INSERT OR ${force ? 'REPLACE' : 'IGNORE'} INTO conversations
     (uuid, name, summary, created_at, updated_at, account_uuid)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMsg = db.prepare(
    `INSERT OR REPLACE INTO messages
     (uuid, conversation_uuid, sender, text, created_at, updated_at, parent_message_uuid, attachments, files)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBlock = db.prepare(
    `INSERT INTO content_blocks
     (message_uuid, conversation_uuid, block_index, block_type, text_content, tool_name, tool_use_id, tool_input, is_error, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const convExists = db.prepare(`SELECT 1 FROM conversations WHERE uuid = ?`);
  const deleteBlocks = db.prepare(`DELETE FROM content_blocks WHERE conversation_uuid = ?`);
  const deleteMsgs = db.prepare(`DELETE FROM messages WHERE conversation_uuid = ?`);

  const result: ImportLocalSessionsResult = {
    total: filePairs.length,
    imported: 0,
    skipped: 0,
    errors: 0,
    messageCount: 0,
    blockCount: 0,
  };

  // ── Process each session file ─────────────────────────────────
  for (const { path: filePath, sessionId, cwd } of filePairs) {
    // Skip check (unless --force)
    if (!force && convExists.get(sessionId)) {
      result.skipped++;
      continue;
    }

    try {
      const { entries, sessionMeta } = await parseJsonlFull(filePath);

      if (entries.length === 0) {
        result.skipped++;
        continue;
      }

      // ── Derive conversation metadata ──────────────────────────
      const firstUser = entries.find((e) => e.type === 'user');
      const rawTitle =
        typeof firstUser?.message.content === 'string'
          ? firstUser.message.content.trim()
          : '';
      const title =
        rawTitle.length === 0
          ? `Session ${sessionId.slice(0, 8)}`
          : rawTitle.split('\n')[0].slice(0, 80) + (rawTitle.length > 80 ? '…' : '');

      const createdAt = entries[0]?.timestamp ?? new Date().toISOString();
      const updatedAt = entries[entries.length - 1]?.timestamp ?? createdAt;
      // Store cwd in summary for discoverability
      const summary = cwd || sessionMeta.cwd || '';

      db.transaction(() => {
        if (force) {
          // Remove existing messages/blocks before re-inserting
          deleteBlocks.run(sessionId);
          deleteMsgs.run(sessionId);
        }

        const convResult = insertConv.run(sessionId, title, summary, createdAt, updatedAt, LOCAL_SESSION_MARKER);
        // With OR IGNORE: changes=0 means the row already existed — skip messages
        if (!force && convResult.changes === 0) return;

        for (const entry of entries) {
          if (entry.type !== 'user' && entry.type !== 'assistant') continue;

          const sender = entry.type === 'user' ? 'human' : 'assistant';
          const plainText = extractPlainText(entry);

          insertMsg.run(
            entry.uuid,
            sessionId,
            sender,
            plainText,
            entry.timestamp,
            null,
            entry.parentUuid || null,
            '[]',
            '[]',
          );
          result.messageCount++;

          // Insert content blocks
          const blocks = extractBlocks(entry);
          for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            insertBlock.run(
              entry.uuid,
              sessionId,
              i,
              b.type,
              b.textContent,
              b.toolName,
              b.toolUseId,
              b.toolInput,
              b.isError,
              b.meta,
            );
            result.blockCount++;
          }
        }
      })();

      result.imported++;
      log(`  ✓ ${sessionId.slice(0, 8)} — ${entries.length} entries, title: "${title.slice(0, 50)}"`);
    } catch (err) {
      result.errors++;
      log(`  ✗ ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
    }
  }

  db.close();
  return result;
}

// ── JSONL parser (returns all entries + session-level metadata) ──

interface SessionMeta {
  cwd: string;
  version: string;
}

async function parseJsonlFull(filePath: string): Promise<{ entries: RawEntry[]; sessionMeta: SessionMeta }> {
  const entries: RawEntry[] = [];
  const meta: SessionMeta = { cwd: '', version: '' };

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed) as RawEntry;
        if (obj.cwd && !meta.cwd) meta.cwd = obj.cwd;
        if (obj.version && !meta.version) meta.version = obj.version;
        if (obj.type === 'user' || obj.type === 'assistant') {
          entries.push(obj);
        }
      } catch {
        // skip malformed lines
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  return { entries, sessionMeta: meta };
}

// ── Text/block extraction ────────────────────────────────────────

function extractPlainText(entry: RawEntry): string {
  if (entry.type === 'user') {
    if (typeof entry.message.content === 'string') return entry.message.content.trim();
    if (Array.isArray(entry.message.content)) {
      return entry.message.content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('\n')
        .trim();
    }
  }
  if (Array.isArray(entry.message.content)) {
    return entry.message.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!.trim())
      .join('\n\n')
      .trim();
  }
  return '';
}

interface NormBlock {
  type: string;
  textContent: string | null;
  toolName: string | null;
  toolUseId: string | null;
  toolInput: string | null;
  isError: number | null;
  meta: string;
}

function extractBlocks(entry: RawEntry): NormBlock[] {
  if (entry.type === 'user') {
    if (typeof entry.message.content === 'string' && entry.message.content.trim()) {
      return [
        {
          type: 'text',
          textContent: entry.message.content.trim(),
          toolName: null,
          toolUseId: null,
          toolInput: null,
          isError: null,
          meta: '{}',
        },
      ];
    }
  }
  if (!Array.isArray(entry.message.content)) return [];

  return entry.message.content.map((b) => ({
    type: b.type,
    textContent: b.text?.trim() || b.thinking?.trim() || null,
    toolName: b.name || null,
    toolUseId: b.id || b.tool_use_id || null,
    toolInput: b.input ? JSON.stringify(b.input) : null,
    isError: b.is_error != null ? (b.is_error ? 1 : 0) : null,
    meta: JSON.stringify(b),
  }));
}
