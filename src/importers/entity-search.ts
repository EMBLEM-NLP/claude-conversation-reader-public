/**
 * @file entity-search.ts
 * @description Query messages by extracted entity value and type, with grouped-by-conversation results
 * @version 1.1.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-26T15:14:56Z
 */
import Database from 'better-sqlite3';
import type { Snippet } from './sqlite-search.js';

export interface EntityRow {
  entity: string;
  type: string;
  text: string;
  sender: string;
  created_at: string;
  name: string;
}

export interface GroupedEntityResult {
  conversation_uuid: string;
  name: string;
  project_uuid: string | null;
  project_name: string | null;
  created_at: string;
  hit_count: number;
  entity: string;
  entity_type: string;
  top_snippets: Snippet[];
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

export function searchByEntity(dbPath: string, entity: string, type?: string, limit = 10): EntityRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    let sql = `
      SELECT e.entity, e.type, m.text, m.sender, m.created_at, c.name
      FROM entities e
      JOIN messages m ON e.message_uuid = m.uuid
      JOIN conversations c ON e.conversation_uuid = c.uuid
      WHERE e.entity = ?`;
    const params: (string | number)[] = [entity.toLowerCase()];
    if (type) {
      sql += ' AND e.type = ?';
      params.push(type);
    }
    sql += ' LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params) as EntityRow[];
  } finally {
    db.close();
  }
}

export function searchByEntityGrouped(dbPath: string, entity: string, type?: string, limit = 10): GroupedEntityResult[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const caps = getDbCaps(db);
    const typeFilter = type ? `AND e.type = ?` : '';
    const projUuid = caps.hasProjectUuid ? 'c.project_uuid' : 'NULL as project_uuid';
    const projName = caps.canJoinProjects ? 'p.name as project_name' : 'NULL as project_name';
    const projectJoin = caps.canJoinProjects ? `LEFT JOIN projects p ON c.project_uuid = p.uuid` : '';

    const countParams: (string | number)[] = [entity.toLowerCase()];
    if (type) countParams.push(type);
    countParams.push(limit);

    const groups = db.prepare(`
      SELECT c.uuid as conversation_uuid, c.name, ${projUuid}, ${projName}, c.created_at,
             COUNT(*) as hit_count, e.entity, e.type as entity_type
      FROM entities e
      JOIN messages m ON e.message_uuid = m.uuid
      JOIN conversations c ON e.conversation_uuid = c.uuid
      ${projectJoin}
      WHERE e.entity = ? ${typeFilter}
      GROUP BY c.uuid
      ORDER BY hit_count DESC
      LIMIT ?
    `).all(...countParams) as Omit<GroupedEntityResult, 'top_snippets'>[];

    const snippetSql = `
      SELECT m.sender, substr(m.text, 1, 200) as text, m.created_at
      FROM entities e
      JOIN messages m ON e.message_uuid = m.uuid
      WHERE e.entity = ? ${typeFilter} AND e.conversation_uuid = ?
      ORDER BY m.created_at DESC
      LIMIT 3
    `;
    const snippetStmt = db.prepare(snippetSql);

    return groups.map(g => {
      const snipParams: (string | number)[] = [entity.toLowerCase()];
      if (type) snipParams.push(type);
      snipParams.push(g.conversation_uuid);
      return { ...g, top_snippets: snippetStmt.all(...snipParams) as Snippet[] };
    });
  } finally {
    db.close();
  }
}
