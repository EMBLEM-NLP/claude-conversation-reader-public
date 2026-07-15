/**
 * @file import-code-session.ts
 * @description Import a /v1/sessions/<id>/events payload into CCR's v2 SQLite
 * schema, mapping each event to a message + content_blocks row. Additive — does
 * not drop existing tables. After importing, every CCR brain feature
 * (search-sqlite, profile, graph-build, categorize) works on the new data.
 * @version 1.0.1
 * @created 2026-05-27T18:00:00Z
 * @lastUpdated 2026-05-28T14:32:33Z
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

export interface ImportCodeSessionInput {
  jsonPath: string;
  dbPath: string;
}

export interface ImportCodeSessionResult {
  sessionId: string;
  title: string;
  messagesInserted: number;
  contentBlocksInserted: number;
  eventsSkipped: number;
  skippedTypes: Record<string, number>;
}

// Fields seen in fetched JSON: { meta: SessionMeta, share: ShareStatus, events: { data?: Event[] } | Event[] }
interface FetchedDump {
  meta: SessionMeta;
  share?: unknown;
  events: EventsPayload;
}

interface SessionMeta {
  id: string;
  title?: string;
  session_status?: string;
  created_at: string;
  updated_at: string;
  session_context?: { model?: string; cwd?: string };
}

type EventsPayload = SessionEvent[] | { data?: SessionEvent[]; events?: SessionEvent[]; items?: SessionEvent[] };

interface SessionEvent {
  uuid: string;
  type: string;
  created_at: string;
  timestamp?: string;
  isSynthetic?: boolean;
  historical?: boolean;
  parent_tool_use_id?: string | null;
  session_id?: string;
  message?: SessionMessage;
}

interface SessionMessage {
  role?: 'user' | 'assistant';
  content?: string | ContentBlock[];
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

// Idempotent schema (only creates if missing — never drops). Matches the v2
// shape produced by import-sqlite.ts so the two importers coexist in one DB.
const ENSURE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    uuid TEXT PRIMARY KEY,
    name TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    account_uuid TEXT,
    project_uuid TEXT
  );

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

function normalizeEvents(payload: EventsPayload): SessionEvent[] {
  if (Array.isArray(payload)) return payload;
  return payload.data ?? payload.events ?? payload.items ?? [];
}

// Flatten content blocks to a plain-text representation for the messages.text
// column — preserves human-readable signal for FTS without losing the original
// structured form (which we still persist in content_blocks).
function flattenContentToText(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (b.type === 'text' && b.text) return b.text;
      if (b.type === 'thinking' && b.thinking) return b.thinking;
      if (b.type === 'tool_use' && b.name) return `[tool_use:${b.name}]`;
      if (b.type === 'tool_result') {
        const inner = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? (b.content as ContentBlock[]).map((c) => c.text ?? '').join(' ')
            : '';
        return `[tool_result] ${inner}`.trim();
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function blockTextContent(block: ContentBlock): string | null {
  if (block.type === 'text') return block.text ?? null;
  if (block.type === 'thinking') return block.thinking ?? null;
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return block.content;
    if (Array.isArray(block.content)) {
      return (block.content as ContentBlock[]).map((c) => c.text ?? '').filter(Boolean).join('\n');
    }
  }
  return null;
}

export function importCodeSession(input: ImportCodeSessionInput): ImportCodeSessionResult {
  if (!fs.existsSync(input.jsonPath)) {
    throw new Error(`Fetched session file not found: ${input.jsonPath}`);
  }
  const raw = fs.readFileSync(input.jsonPath, 'utf-8');
  const dump = JSON.parse(raw) as FetchedDump;

  if (!dump.meta?.id) {
    throw new Error('Invalid dump: missing meta.id — expected output of scripts/fetch-code-session.ts');
  }

  const sessionId = dump.meta.id;
  const title = dump.meta.title || '(untitled code session)';
  const events = normalizeEvents(dump.events);

  const db = new Database(input.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(ENSURE_SCHEMA_SQL);

  const insertConv = db.prepare(
    `INSERT OR REPLACE INTO conversations (uuid, name, summary, created_at, updated_at, account_uuid) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMsg = db.prepare(
    `INSERT OR REPLACE INTO messages (uuid, conversation_uuid, sender, text, created_at, updated_at, parent_message_uuid, attachments, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBlock = db.prepare(
    `INSERT INTO content_blocks (message_uuid, conversation_uuid, block_index, block_type, text_content, tool_name, tool_use_id, tool_input, is_error, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteOldBlocks = db.prepare(
    `DELETE FROM content_blocks WHERE conversation_uuid = ?`,
  );

  let messagesInserted = 0;
  let contentBlocksInserted = 0;
  let eventsSkipped = 0;
  const skippedTypes: Record<string, number> = {};

  db.transaction(() => {
    insertConv.run(
      sessionId,
      title,
      dump.meta.session_status ?? '',
      dump.meta.created_at,
      dump.meta.updated_at,
      null, // account_uuid not present on code-session metadata
    );
    // Re-import friendliness: wipe previous content blocks for this conv
    // before re-inserting (messages use INSERT OR REPLACE, blocks use plain INSERT)
    deleteOldBlocks.run(sessionId);

    // Code-session events are linear (chronological in the events array). The
    // `parent_message_uuid` column models *thread* topology — used by
    // `main-branch` to walk a conversation as a linked list. The Claude Code
    // event stream's `parent_tool_use_id` is the tool-call↔tool-result linker,
    // a different concept entirely. Threading through `parent_tool_use_id`
    // produces a broken chain where `main-branch` only finds the latest leaf.
    // We instead point each new message at the previous user/assistant event.
    let previousMessageUuid: string | null = null;

    for (const ev of events) {
      const role = ev.message?.role;
      if (ev.type !== 'user' && ev.type !== 'assistant') {
        eventsSkipped++;
        skippedTypes[ev.type] = (skippedTypes[ev.type] ?? 0) + 1;
        continue;
      }
      if (!role) {
        eventsSkipped++;
        skippedTypes['no-role'] = (skippedTypes['no-role'] ?? 0) + 1;
        continue;
      }

      const flatText = flattenContentToText(ev.message?.content);
      insertMsg.run(
        ev.uuid,
        sessionId,
        role,
        flatText,
        ev.created_at,
        null,
        previousMessageUuid,
        '[]',
        '[]',
      );
      previousMessageUuid = ev.uuid;
      messagesInserted++;

      const content = ev.message?.content;
      if (typeof content === 'string') {
        // Treat string content as a single text block
        insertBlock.run(ev.uuid, sessionId, 0, 'text', content, null, null, null, null, null);
        contentBlocksInserted++;
      } else if (Array.isArray(content)) {
        for (let i = 0; i < content.length; i++) {
          const b = content[i];
          insertBlock.run(
            ev.uuid,
            sessionId,
            i,
            b.type,
            blockTextContent(b),
            b.name ?? null,
            b.id ?? b.tool_use_id ?? null,
            b.input != null ? JSON.stringify(b.input) : null,
            b.is_error != null ? (b.is_error ? 1 : 0) : null,
            JSON.stringify(b),
          );
          contentBlocksInserted++;
        }
      }
    }
  })();

  db.close();

  return {
    sessionId,
    title,
    messagesInserted,
    contentBlocksInserted,
    eventsSkipped,
    skippedTypes,
  };
}
