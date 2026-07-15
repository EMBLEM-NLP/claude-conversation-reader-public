/**
 * @file schema.ts
 * @description Graph table DDL: graph_nodes, graph_edges, graph_communities
 * @version 1.1.0
 * @created 2026-04-14T00:00:00Z
 * @lastUpdated 2026-04-16T00:00:00Z
 */
import type Database from 'better-sqlite3';

export function createGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      node_type TEXT NOT NULL,
      entity_type TEXT,
      degree INTEGER DEFAULT 0,
      community_id INTEGER,
      first_seen TEXT,
      last_seen TEXT,
      meta TEXT,
      tool_count INTEGER DEFAULT 0,
      tool_names TEXT,
      category TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gn_type ON graph_nodes(node_type);
    CREATE INDEX IF NOT EXISTS idx_gn_community ON graph_nodes(community_id);
    CREATE INDEX IF NOT EXISTS idx_gn_degree ON graph_nodes(degree DESC);

    CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES graph_nodes(id),
      target_id TEXT NOT NULL REFERENCES graph_nodes(id),
      relation TEXT NOT NULL,
      confidence TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      conversation_uuid TEXT,
      message_uuid TEXT,
      UNIQUE(source_id, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_ge_source ON graph_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_ge_target ON graph_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_ge_relation ON graph_edges(relation);
    CREATE INDEX IF NOT EXISTS idx_ge_conv ON graph_edges(conversation_uuid);

    CREATE TABLE IF NOT EXISTS graph_communities (
      id INTEGER PRIMARY KEY,
      node_count INTEGER,
      cohesion_score REAL,
      top_entities TEXT,
      label TEXT
    );
  `);
}

export function dropGraphSchema(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS graph_edges;
    DROP TABLE IF EXISTS graph_communities;
    DROP TABLE IF EXISTS graph_nodes;
  `);
}
