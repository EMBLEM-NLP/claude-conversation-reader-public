/**
 * @file analyze.ts
 * @description Graph analysis: god nodes, bridges, bursts, tool stats, suggestions
 * @version 1.0.0
 * @created 2026-04-14T00:00:00Z
 * @lastUpdated 2026-04-15T17:15:45Z
 */
import Database from 'better-sqlite3';

export interface GodNode {
  id: string;
  label: string;
  entity_type: string | null;
  degree: number;
  community_id: number | null;
}

export interface Connection {
  source_label: string;
  target_label: string;
  weight: number;
  shared_conversations: number;
  confidence: string;
}

export function godNodes(dbPath: string, topN = 10): GodNode[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, label, entity_type, degree, community_id
         FROM graph_nodes
         WHERE node_type = 'entity'
         ORDER BY degree DESC
         LIMIT ?`,
      )
      .all(topN) as GodNode[];
  } finally {
    db.close();
  }
}

export function surprisingConnections(dbPath: string, limit = 10): Connection[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT
           src.label AS source_label,
           tgt.label AS target_label,
           e.weight,
           COUNT(DISTINCT e.conversation_uuid) AS shared_conversations,
           e.confidence
         FROM graph_edges e
         JOIN graph_nodes src ON src.id = e.source_id
         JOIN graph_nodes tgt ON tgt.id = e.target_id
         WHERE e.relation = 'co_occurs'
           AND src.node_type = 'entity'
           AND tgt.node_type = 'entity'
           AND src.community_id != tgt.community_id
         GROUP BY e.source_id, e.target_id
         ORDER BY shared_conversations DESC, e.weight DESC
         LIMIT ?`,
      )
      .all(limit) as Connection[];
  } finally {
    db.close();
  }
}

export interface TopicHub {
  entity: string;
  conversation_count: number;
  degree: number;
  community_id: number | null;
  first_seen: string | null;
}

export function topicHubs(dbPath: string, topN = 10): TopicHub[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT e.entity, COUNT(DISTINCT e.conversation_uuid) as conversation_count,
                gn.degree, gn.community_id, gn.first_seen
         FROM entities e
         JOIN graph_nodes gn ON gn.id = e.entity AND gn.node_type = 'entity'
         WHERE e.type = 'topic'
         GROUP BY e.entity
         ORDER BY conversation_count DESC
         LIMIT ?`,
      )
      .all(topN) as TopicHub[];
  } finally {
    db.close();
  }
}

export interface TemporalBurst {
  entity: string;
  entity_type: string;
  week: string;
  mentions: number;
}

export function temporalBursts(dbPath: string, limit = 20): TemporalBurst[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT e.entity, e.type as entity_type,
                strftime('%Y-W%W', m.created_at) as week,
                COUNT(*) as mentions
         FROM entities e
         JOIN messages m ON m.uuid = e.message_uuid
         GROUP BY e.entity, week
         HAVING mentions >= 5
         ORDER BY mentions DESC
         LIMIT ?`,
      )
      .all(limit) as TemporalBurst[];
  } finally {
    db.close();
  }
}

export interface BridgeEntity {
  entity: string;
  entity_type: string | null;
  degree: number;
  communities_connected: number;
  community_ids: string;
}

export function bridgeEntities(dbPath: string, topN = 10): BridgeEntity[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT gn.label as entity, gn.entity_type, gn.degree,
                COUNT(DISTINCT neighbor.community_id) as communities_connected,
                GROUP_CONCAT(DISTINCT neighbor.community_id) as community_ids
         FROM graph_nodes gn
         JOIN graph_edges ge ON ge.source_id = gn.id OR ge.target_id = gn.id
         JOIN graph_nodes neighbor ON neighbor.id = CASE
           WHEN ge.source_id = gn.id THEN ge.target_id
           ELSE ge.source_id
         END
         WHERE gn.node_type = 'entity'
           AND ge.relation = 'co_occurs'
           AND neighbor.community_id IS NOT NULL
           AND neighbor.community_id != gn.community_id
         GROUP BY gn.id
         HAVING communities_connected >= 3
         ORDER BY communities_connected DESC, gn.degree DESC
         LIMIT ?`,
      )
      .all(topN) as BridgeEntity[];
  } finally {
    db.close();
  }
}

export interface ToolStat {
  tool_name: string;
  conversation_count: number;
  total_calls: number;
  degree: number;
}

export interface ToolDiversityRow {
  conversation_name: string;
  conversation_uuid: string;
  tool_count: number;
  tool_names: string;
}

export function toolUsageStats(dbPath: string, limit = 10): { topTools: ToolStat[]; mostDiverse: ToolDiversityRow[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const topTools = db.prepare(
      `SELECT gn.label as tool_name,
              COUNT(DISTINCT ge.conversation_uuid) as conversation_count,
              CAST(SUM(ge.weight) AS INTEGER) as total_calls,
              gn.degree
       FROM graph_nodes gn
       JOIN graph_edges ge ON ge.target_id = gn.id AND ge.relation = 'uses_tool'
       WHERE gn.node_type = 'tool'
       GROUP BY gn.id
       ORDER BY total_calls DESC
       LIMIT ?`,
    ).all(limit) as ToolStat[];

    const mostDiverse = db.prepare(
      `SELECT c.name as conversation_name, c.uuid as conversation_uuid,
              gn.tool_count, gn.tool_names
       FROM graph_nodes gn
       JOIN conversations c ON 'conv:' || c.uuid = gn.id
       WHERE gn.node_type = 'conversation' AND gn.tool_count > 0
       ORDER BY gn.tool_count DESC
       LIMIT ?`,
    ).all(limit) as ToolDiversityRow[];

    return { topTools, mostDiverse };
  } finally {
    db.close();
  }
}

export function suggestQuestions(dbPath: string, limit = 5): string[] {
  const top = godNodes(dbPath, limit * 2);
  if (top.length === 0) return [];

  const questions: string[] = [];

  // Suggest FTS queries combining high-degree entities
  for (let i = 0; i < Math.min(top.length - 1, limit); i++) {
    const a = top[i].label;
    const b = top[i + 1].label;
    questions.push(`Search conversations where '${a}' and '${b}' both appear`);
  }

  // Add a god-node standalone suggestion
  if (top[0]) {
    questions.unshift(`Find all conversations about '${top[0].label}' (most connected entity)`);
  }

  return questions.slice(0, limit);
}
