/**
 * @file import-sqlite.ts
 * @description Claude JSON export to SQLite v2 schema with FTS5 and triggers; includes projects cache
 * @version 1.2.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-27T05:59:11Z
 */
import fs from 'fs';
import Database from 'better-sqlite3';

export interface ImportOptions {
  exportPath: string;
  dbPath: string;
}

interface ExportConversation {
  uuid: string;
  name: string;
  summary?: string;
  created_at: string;
  updated_at: string;
  account?: { uuid: string };
  chat_messages: Array<Record<string, unknown>>;
}

interface ExportContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

const SCHEMA_SQL = `
  -- Drop existing objects for clean re-import
  DROP TABLE IF EXISTS content_blocks_fts;
  DROP TABLE IF EXISTS messages_fts;
  DROP TRIGGER IF EXISTS messages_ai;
  DROP TRIGGER IF EXISTS messages_ad;
  DROP TRIGGER IF EXISTS messages_au;
  DROP TRIGGER IF EXISTS content_blocks_ai;
  DROP TRIGGER IF EXISTS content_blocks_ad;
  DROP TRIGGER IF EXISTS content_blocks_au;
  DROP TABLE IF EXISTS content_blocks;
  DROP TABLE IF EXISTS entities;
  DROP TABLE IF EXISTS messages;
  DROP TABLE IF EXISTS conversations;

  -- Conversations
  CREATE TABLE conversations (
    uuid TEXT PRIMARY KEY,
    name TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    account_uuid TEXT,
    project_uuid TEXT
  );
  CREATE INDEX idx_conv_created ON conversations(created_at);
  CREATE INDEX idx_conv_updated ON conversations(updated_at);
  CREATE INDEX idx_conv_name ON conversations(name);
  CREATE INDEX idx_conv_project ON conversations(project_uuid);

  -- Messages (regular table)
  CREATE TABLE messages (
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
  CREATE INDEX idx_msg_conv ON messages(conversation_uuid);
  CREATE INDEX idx_msg_sender ON messages(sender);
  CREATE INDEX idx_msg_created ON messages(created_at);
  CREATE INDEX idx_msg_conv_created ON messages(conversation_uuid, created_at);
  CREATE INDEX idx_msg_parent ON messages(parent_message_uuid);

  -- Content blocks (one row per content[] element)
  CREATE TABLE content_blocks (
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
  CREATE INDEX idx_cb_message ON content_blocks(message_uuid);
  CREATE INDEX idx_cb_type ON content_blocks(block_type);
  CREATE INDEX idx_cb_tool ON content_blocks(tool_name) WHERE tool_name IS NOT NULL;
  CREATE INDEX idx_cb_conv ON content_blocks(conversation_uuid);

  -- FTS5 content-sync for message text
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    text,
    content='messages',
    content_rowid='rowid',
    tokenize='porter'
  );

  -- FTS5 content-sync for content block text (thinking, tool text, etc.)
  CREATE VIRTUAL TABLE content_blocks_fts USING fts5(
    text_content,
    content='content_blocks',
    content_rowid='id',
    tokenize='porter'
  );

  -- Triggers: messages_fts sync
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  -- Triggers: content_blocks_fts sync
  CREATE TRIGGER content_blocks_ai AFTER INSERT ON content_blocks BEGIN
    INSERT INTO content_blocks_fts(rowid, text_content) VALUES (new.id, new.text_content);
  END;
  CREATE TRIGGER content_blocks_ad AFTER DELETE ON content_blocks BEGIN
    INSERT INTO content_blocks_fts(content_blocks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
  END;
  CREATE TRIGGER content_blocks_au AFTER UPDATE ON content_blocks BEGIN
    INSERT INTO content_blocks_fts(content_blocks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
    INSERT INTO content_blocks_fts(rowid, text_content) VALUES (new.id, new.text_content);
  END;

  -- Entities (recreated empty, populated by extract-entities command)
  CREATE TABLE entities (
    entity TEXT,
    type TEXT,
    message_uuid TEXT,
    conversation_uuid TEXT,
    PRIMARY KEY (entity, type, message_uuid)
  );
  CREATE INDEX idx_entities_conv ON entities(conversation_uuid);
  CREATE INDEX idx_entities_type ON entities(type);
`;

// Applied after SCHEMA_SQL on every import, and standalone for existing DBs.
// Uses IF NOT EXISTS so it is idempotent and survives re-imports (the destructive DDL above never drops projects).
const PROJECTS_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
`;

export function importConversationsToSqlite({ exportPath, dbPath }: ImportOptions) {
  if (!fs.existsSync(exportPath)) throw new Error('Export file not found: ' + exportPath);
  const raw = fs.readFileSync(exportPath, 'utf8');

  let conversations: ExportConversation[];
  try {
    conversations = JSON.parse(raw);
  } catch {
    throw new Error('Export file is not valid JSON: ' + exportPath);
  }

  if (!Array.isArray(conversations)) {
    throw new Error('Export file must contain a JSON array of conversations.');
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  db.exec(PROJECTS_MIGRATION_SQL);

  const insertConv = db.prepare(
    `INSERT OR REPLACE INTO conversations (uuid, name, summary, created_at, updated_at, account_uuid) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMsg = db.prepare(
    `INSERT OR REPLACE INTO messages (uuid, conversation_uuid, sender, text, created_at, updated_at, parent_message_uuid, attachments, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBlock = db.prepare(
    `INSERT INTO content_blocks (message_uuid, conversation_uuid, block_index, block_type, text_content, tool_name, tool_use_id, tool_input, is_error, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let messageCount = 0;
  let blockCount = 0;

  db.transaction(() => {
    for (const conv of conversations) {
      insertConv.run(
        conv.uuid,
        conv.name,
        conv.summary || '',
        conv.created_at,
        conv.updated_at,
        conv.account?.uuid || null,
      );

      for (const msg of conv.chat_messages) {
        insertMsg.run(
          msg.uuid,
          conv.uuid,
          msg.sender,
          msg.text || '',
          msg.created_at,
          (msg.updated_at as string) || null,
          (msg.parent_message_uuid as string) || null,
          JSON.stringify(msg.attachments || []),
          JSON.stringify(msg.files || []),
        );
        messageCount++;

        const contentArr = (msg.content || []) as ExportContentBlock[];
        for (let i = 0; i < contentArr.length; i++) {
          const block = contentArr[i];
          insertBlock.run(
            msg.uuid,
            conv.uuid,
            i,
            block.type,
            block.text || block.thinking || null,
            block.name || null,
            block.id || block.tool_use_id || null,
            block.input ? JSON.stringify(block.input) : null,
            block.is_error != null ? (block.is_error ? 1 : 0) : null,
            JSON.stringify(block),
          );
          blockCount++;
        }
      }
    }
  })();

  db.close();
  console.log(`Import complete: ${conversations.length} conversations, ${messageCount} messages, ${blockCount} content blocks`);
}

export interface ProjectCacheEntry {
  uuid: string;
  name: string;
}

/** Upsert project names into the projects cache table. Creates the table if absent. */
export function cacheProjects(dbPath: string, projects: ProjectCacheEntry[]): number {
  const db = new Database(dbPath);
  db.exec(PROJECTS_MIGRATION_SQL);
  const upsert = db.prepare(
    `INSERT INTO projects (uuid, name, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, fetched_at=excluded.fetched_at`,
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const p of projects) {
      upsert.run(p.uuid, p.name, now);
    }
  })();
  db.close();
  return projects.length;
}
