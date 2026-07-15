/**
 * @file sqlite-search-grouped.test.ts
 * @description Smoke tests for grouped search helpers using an in-memory SQLite DB
 * @version 1.0.0
 * @created 2026-04-26T15:14:56Z
 * @lastUpdated 2026-04-26T15:14:56Z
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { searchMessagesGrouped, searchContentGrouped } from '../src/importers/sqlite-search.js';
import { searchByEntityGrouped } from '../src/importers/entity-search.js';

const DB_PATH = join(tmpdir(), `ccr-test-${Date.now()}.sqlite`);

beforeAll(() => {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE conversations (
      uuid TEXT PRIMARY KEY, name TEXT, summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      account_uuid TEXT, project_uuid TEXT
    );
    CREATE TABLE messages (
      uuid TEXT PRIMARY KEY, conversation_uuid TEXT NOT NULL,
      sender TEXT NOT NULL, text TEXT, created_at TEXT NOT NULL,
      updated_at TEXT, parent_message_uuid TEXT, attachments TEXT, files TEXT
    );
    CREATE TABLE content_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_uuid TEXT NOT NULL, conversation_uuid TEXT NOT NULL,
      block_index INTEGER NOT NULL, block_type TEXT NOT NULL,
      text_content TEXT, tool_name TEXT, tool_use_id TEXT,
      tool_input TEXT, is_error INTEGER, meta TEXT
    );
    CREATE TABLE entities (
      entity TEXT, type TEXT, message_uuid TEXT, conversation_uuid TEXT,
      PRIMARY KEY (entity, type, message_uuid)
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text, content='messages', content_rowid='rowid', tokenize='porter'
    );
    CREATE VIRTUAL TABLE content_blocks_fts USING fts5(
      text_content, content='content_blocks', content_rowid='id', tokenize='porter'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER content_blocks_ai AFTER INSERT ON content_blocks BEGIN
      INSERT INTO content_blocks_fts(rowid, text_content) VALUES (new.id, new.text_content);
    END;
  `);

  db.prepare(`INSERT INTO conversations VALUES (?,?,?,?,?,?,?)`).run(
    'conv-1', 'VOID Rack Build', '', '2026-02-18', '2026-02-18', null, null,
  );
  db.prepare(`INSERT INTO conversations VALUES (?,?,?,?,?,?,?)`).run(
    'conv-2', 'Other Topic', '', '2026-03-01', '2026-03-01', null, null,
  );

  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'msg-1', 'conv-1', 'human', 'Check the void sound system rack wiring', '2026-02-18', null, null, '[]', '[]',
  );
  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'msg-2', 'conv-1', 'assistant', 'The void rack has V3 and Q2 amplifiers', '2026-02-18', null, null, '[]', '[]',
  );
  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'msg-3', 'conv-2', 'human', 'Unrelated message about typescript', '2026-03-01', null, null, '[]', '[]',
  );

  db.prepare(`INSERT INTO content_blocks VALUES (null,?,?,?,?,?,?,?,?,?,?)`).run(
    'msg-1', 'conv-1', 0, 'thinking', 'thinking about the void rack system', null, null, null, null, null,
  );

  db.prepare(`INSERT INTO entities VALUES (?,?,?,?)`).run('void', 'topic', 'msg-1', 'conv-1');
  db.prepare(`INSERT INTO entities VALUES (?,?,?,?)`).run('void', 'topic', 'msg-2', 'conv-1');

  db.close();
});

describe('searchMessagesGrouped', () => {
  it('returns grouped results with hit_count and top_snippets', () => {
    const results = searchMessagesGrouped(DB_PATH, 'void', 10);
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.conversation_uuid).toBe('conv-1');
    expect(top.name).toBe('VOID Rack Build');
    expect(top.hit_count).toBeGreaterThanOrEqual(1);
    expect(top.top_snippets.length).toBeLessThanOrEqual(3);
    expect(top.top_snippets.length).toBeGreaterThan(0);
    expect(top.top_snippets[0]).toHaveProperty('sender');
    expect(top.top_snippets[0]).toHaveProperty('text');
    expect(top.top_snippets[0]).toHaveProperty('created_at');
  });

  it('returns no results for unknown query', () => {
    const results = searchMessagesGrouped(DB_PATH, 'xyznonexistentterm', 10);
    expect(results.length).toBe(0);
  });

  it('sorts by hit_count descending', () => {
    const results = searchMessagesGrouped(DB_PATH, 'void', 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].hit_count).toBeGreaterThanOrEqual(results[i].hit_count);
    }
  });
});

describe('searchByEntityGrouped', () => {
  it('groups entity hits by conversation', () => {
    const results = searchByEntityGrouped(DB_PATH, 'void', 'topic', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].conversation_uuid).toBe('conv-1');
    expect(results[0].hit_count).toBeGreaterThanOrEqual(2);
  });
});
