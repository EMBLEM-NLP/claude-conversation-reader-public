/**
 * @file sqlite-search.ts
 * @description FTS5 full-text search across messages and content blocks, with grouped-by-conversation results
 * @version 1.2.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-27T05:59:02Z
 */
import Database from 'better-sqlite3';


export interface MessageRow {
  uuid: string;
  conversation_uuid: string;
  sender: string;
  text: string;
  created_at: string;
  name: string;
}

export interface ContentBlockSearchRow {
  id: number;
  message_uuid: string;
  conversation_uuid: string;
  block_type: string;
  text_content: string;
  tool_name: string | null;
  sender: string;
  created_at: string;
  name: string;
}

export interface Snippet {
  sender: string;
  text: string;
  created_at: string;
}

export interface GroupedSearchResult {
  conversation_uuid: string;
  name: string;
  project_uuid: string | null;
  project_name: string | null;
  created_at: string;
  hit_count: number;
  top_snippets: Snippet[];
}

function handleFtsError(err: unknown, query: string): never {
  const msg = (err as Error).message;
  if (msg.includes('fts5') || msg.includes('syntax')) {
    throw new Error(`Invalid search query "${query}": ${msg}. Avoid special characters like unmatched quotes.`, { cause: err });
  }
  throw err;
}

interface DbCaps {
  hasProjectUuid: boolean;
  canJoinProjects: boolean;
}

function getDbCaps(db: Database.Database): DbCaps {
  const cols = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
  const hasProjectUuid = cols.some((c) => c.name === 'project_uuid');
  const hasProjectsTable = !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'`,
  ).get();
  return { hasProjectUuid, canJoinProjects: hasProjectUuid && hasProjectsTable };
}

function projectSelectCols({ hasProjectUuid, canJoinProjects }: DbCaps): string {
  return [
    hasProjectUuid ? 'c.project_uuid' : 'NULL as project_uuid',
    canJoinProjects ? 'p.name as project_name' : 'NULL as project_name',
  ].join(', ');
}

function projectJoin({ canJoinProjects }: DbCaps): string {
  return canJoinProjects ? `LEFT JOIN projects p ON c.project_uuid = p.uuid` : '';
}

export function searchMessages(dbPath: string, query: string, limit = 10): MessageRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.prepare(`
      SELECT m.uuid, m.conversation_uuid, m.sender, m.text, m.created_at, c.name
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      JOIN conversations c ON m.conversation_uuid = c.uuid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(query, limit) as MessageRow[];
  } catch (err) {
    handleFtsError(err, query);
  } finally {
    db.close();
  }
}

export function searchMessagesGrouped(dbPath: string, query: string, limit = 10): GroupedSearchResult[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const caps = getDbCaps(db);
    const groups = db.prepare(`
      SELECT c.uuid as conversation_uuid, c.name, ${projectSelectCols(caps)}, c.created_at, COUNT(*) as hit_count
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      JOIN conversations c ON m.conversation_uuid = c.uuid
      ${projectJoin(caps)}
      WHERE messages_fts MATCH ?
      GROUP BY c.uuid
      ORDER BY hit_count DESC
      LIMIT ?
    `).all(query, limit) as Omit<GroupedSearchResult, 'top_snippets'>[];

    const snippetStmt = db.prepare(`
      SELECT m.sender, substr(m.text, 1, 200) as text, m.created_at
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ? AND m.conversation_uuid = ?
      ORDER BY rank
      LIMIT 3
    `);

    return groups.map(g => ({
      ...g,
      top_snippets: snippetStmt.all(query, g.conversation_uuid) as Snippet[],
    }));
  } catch (err) {
    handleFtsError(err, query);
  } finally {
    db.close();
  }
}

export function searchThinking(dbPath: string, query: string, limit = 10): ContentBlockSearchRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.prepare(`
      SELECT cb.id, cb.message_uuid, cb.conversation_uuid, cb.block_type,
             cb.text_content, cb.tool_name, m.sender, m.created_at, c.name
      FROM content_blocks_fts fts
      JOIN content_blocks cb ON cb.id = fts.rowid
      JOIN messages m ON cb.message_uuid = m.uuid
      JOIN conversations c ON cb.conversation_uuid = c.uuid
      WHERE content_blocks_fts MATCH ?
        AND cb.block_type = 'thinking'
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(query, limit) as ContentBlockSearchRow[];
  } catch (err) {
    handleFtsError(err, query);
  } finally {
    db.close();
  }
}

export function searchThinkingGrouped(dbPath: string, query: string, limit = 10): GroupedSearchResult[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const caps = getDbCaps(db);
    const groups = db.prepare(`
      SELECT c.uuid as conversation_uuid, c.name, ${projectSelectCols(caps)}, c.created_at, COUNT(*) as hit_count
      FROM content_blocks_fts fts
      JOIN content_blocks cb ON cb.id = fts.rowid
      JOIN messages m ON cb.message_uuid = m.uuid
      JOIN conversations c ON cb.conversation_uuid = c.uuid
      ${projectJoin(caps)}
      WHERE content_blocks_fts MATCH ? AND cb.block_type = 'thinking'
      GROUP BY c.uuid
      ORDER BY hit_count DESC
      LIMIT ?
    `).all(query, limit) as Omit<GroupedSearchResult, 'top_snippets'>[];

    const snippetStmt = db.prepare(`
      SELECT m.sender, substr(cb.text_content, 1, 200) as text, m.created_at
      FROM content_blocks_fts fts
      JOIN content_blocks cb ON cb.id = fts.rowid
      JOIN messages m ON cb.message_uuid = m.uuid
      WHERE content_blocks_fts MATCH ? AND cb.block_type = 'thinking' AND cb.conversation_uuid = ?
      ORDER BY rank
      LIMIT 3
    `);

    return groups.map(g => ({
      ...g,
      top_snippets: snippetStmt.all(query, g.conversation_uuid) as Snippet[],
    }));
  } catch (err) {
    handleFtsError(err, query);
  } finally {
    db.close();
  }
}

export function searchByToolName(dbPath: string, toolName: string, limit = 10): ContentBlockSearchRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.prepare(`
      SELECT cb.id, cb.message_uuid, cb.conversation_uuid, cb.block_type,
             cb.text_content, cb.tool_name, m.sender, m.created_at, c.name
      FROM content_blocks cb
      JOIN messages m ON cb.message_uuid = m.uuid
      JOIN conversations c ON cb.conversation_uuid = c.uuid
      WHERE cb.tool_name = ?
        AND cb.block_type IN ('tool_use', 'tool_result')
      ORDER BY m.created_at DESC
      LIMIT ?
    `);
    return stmt.all(toolName, limit) as ContentBlockSearchRow[];
  } finally {
    db.close();
  }
}

export function searchByToolNameGrouped(dbPath: string, toolName: string, limit = 10): GroupedSearchResult[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const caps = getDbCaps(db);
    const groups = db.prepare(`
      SELECT c.uuid as conversation_uuid, c.name, ${projectSelectCols(caps)}, c.created_at, COUNT(*) as hit_count
      FROM content_blocks cb
      JOIN messages m ON cb.message_uuid = m.uuid
      JOIN conversations c ON cb.conversation_uuid = c.uuid
      ${projectJoin(caps)}
      WHERE cb.tool_name = ? AND cb.block_type IN ('tool_use', 'tool_result')
      GROUP BY c.uuid
      ORDER BY hit_count DESC
      LIMIT ?
    `).all(toolName, limit) as Omit<GroupedSearchResult, 'top_snippets'>[];

    const snippetStmt = db.prepare(`
      SELECT m.sender, substr(cb.text_content, 1, 200) as text, m.created_at
      FROM content_blocks cb
      JOIN messages m ON cb.message_uuid = m.uuid
      WHERE cb.tool_name = ? AND cb.block_type IN ('tool_use', 'tool_result') AND cb.conversation_uuid = ?
      ORDER BY m.created_at DESC
      LIMIT 3
    `);

    return groups.map(g => ({
      ...g,
      top_snippets: snippetStmt.all(toolName, g.conversation_uuid) as Snippet[],
    }));
  } finally {
    db.close();
  }
}

export function searchContent(dbPath: string, query: string, blockType?: string, limit = 10): ContentBlockSearchRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const params: (string | number)[] = [query];
    let typeFilter = '';
    if (blockType) {
      typeFilter = 'AND cb.block_type = ?';
      params.push(blockType);
    }
    params.push(limit);

    const stmt = db.prepare(`
      SELECT cb.id, cb.message_uuid, cb.conversation_uuid, cb.block_type,
             cb.text_content, cb.tool_name, m.sender, m.created_at, c.name
      FROM content_blocks_fts fts
      JOIN content_blocks cb ON cb.id = fts.rowid
      JOIN messages m ON cb.message_uuid = m.uuid
      JOIN conversations c ON cb.conversation_uuid = c.uuid
      WHERE content_blocks_fts MATCH ?
        ${typeFilter}
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(...params) as ContentBlockSearchRow[];
  } catch (err) {
    handleFtsError(err, query);
  } finally {
    db.close();
  }
}

export function searchContentGrouped(dbPath: string, query: string, blockType?: string, limit = 10): GroupedSearchResult[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const caps = getDbCaps(db);
    const typeFilter = blockType ? `AND cb.block_type = ?` : '';
    const countParams: (string | number)[] = [query];
    if (blockType) countParams.push(blockType);
    countParams.push(limit);

    const groups = db.prepare(`
      SELECT c.uuid as conversation_uuid, c.name, ${projectSelectCols(caps)}, c.created_at, COUNT(*) as hit_count
      FROM content_blocks_fts fts
      JOIN content_blocks cb ON cb.id = fts.rowid
      JOIN messages m ON cb.message_uuid = m.uuid
      JOIN conversations c ON cb.conversation_uuid = c.uuid
      ${projectJoin(caps)}
      WHERE content_blocks_fts MATCH ? ${typeFilter}
      GROUP BY c.uuid
      ORDER BY hit_count DESC
      LIMIT ?
    `).all(...countParams) as Omit<GroupedSearchResult, 'top_snippets'>[];

    const snippetSql = `
      SELECT m.sender, substr(cb.text_content, 1, 200) as text, m.created_at
      FROM content_blocks_fts fts
      JOIN content_blocks cb ON cb.id = fts.rowid
      JOIN messages m ON cb.message_uuid = m.uuid
      WHERE content_blocks_fts MATCH ? ${typeFilter} AND cb.conversation_uuid = ?
      ORDER BY rank
      LIMIT 3
    `;
    const snippetStmt = db.prepare(snippetSql);

    return groups.map(g => {
      const snipParams: (string | number)[] = [query];
      if (blockType) snipParams.push(blockType);
      snipParams.push(g.conversation_uuid);
      return { ...g, top_snippets: snippetStmt.all(...snipParams) as Snippet[] };
    });
  } catch (err) {
    handleFtsError(err, query);
  } finally {
    db.close();
  }
}
