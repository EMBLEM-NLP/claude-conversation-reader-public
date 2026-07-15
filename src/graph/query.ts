/**
 * @file query.ts
 * @description BFS subgraph search, neighbor lookup, community retrieval, shortest path
 * @version 1.0.0
 * @created 2026-04-14T00:00:00Z
 * @lastUpdated 2026-04-15T17:15:45Z
 */
import Database from 'better-sqlite3';

export interface GraphNode {
  id: string;
  label: string;
  node_type: string;
  entity_type: string | null;
  degree: number;
  community_id: number | null;
}

export interface GraphEdge {
  source_id: string;
  source_label: string;
  target_id: string;
  target_label: string;
  relation: string;
  confidence: string;
  weight: number;
}

export interface QueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  seedNodes: string[];
}

export interface NeighborResult {
  id: string;
  label: string;
  node_type: string;
  entity_type: string | null;
  degree: number;
  relation: string;
  direction: 'outgoing' | 'incoming';
  weight: number;
}

export interface CommunityResult {
  communityId: number;
  label: string | null;
  cohesion_score: number | null;
  nodes: GraphNode[];
}

export interface PathResult {
  found: boolean;
  path: string[];
  labels: string[];
  length: number;
}

// BFS traversal starting from nodes matching keyword, up to `depth` hops
export function queryGraph(dbPath: string, keyword: string, depth = 2): QueryResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    const kw = `%${keyword.toLowerCase()}%`;
    const seeds = db
      .prepare('SELECT id FROM graph_nodes WHERE lower(label) LIKE ? OR lower(id) LIKE ? LIMIT 20')
      .all(kw, kw) as { id: string }[];

    const seedIds = seeds.map((s) => s.id);
    const visited = new Set<string>(seedIds);
    let frontier = new Set<string>(seedIds);

    for (let d = 0; d < depth; d++) {
      if (frontier.size === 0) break;
      const placeholders = [...frontier].map(() => '?').join(',');
      const neighbors = db
        .prepare(
          `SELECT source_id, target_id FROM graph_edges
           WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
        )
        .all(...frontier, ...frontier) as { source_id: string; target_id: string }[];

      frontier = new Set<string>();
      for (const { source_id, target_id } of neighbors) {
        if (!visited.has(source_id)) { visited.add(source_id); frontier.add(source_id); }
        if (!visited.has(target_id)) { visited.add(target_id); frontier.add(target_id); }
      }
    }

    const allIds = [...visited];
    if (allIds.length === 0) return { nodes: [], edges: [], seedNodes: seedIds };

    const placeholders = allIds.map(() => '?').join(',');
    const nodes = db
      .prepare(`SELECT id, label, node_type, entity_type, degree, community_id FROM graph_nodes WHERE id IN (${placeholders})`)
      .all(...allIds) as GraphNode[];

    const edges = db
      .prepare(
        `SELECT e.source_id, src.label AS source_label, e.target_id, tgt.label AS target_label,
                e.relation, e.confidence, e.weight
         FROM graph_edges e
         JOIN graph_nodes src ON src.id = e.source_id
         JOIN graph_nodes tgt ON tgt.id = e.target_id
         WHERE e.source_id IN (${placeholders}) AND e.target_id IN (${placeholders})`,
      )
      .all(...allIds, ...allIds) as GraphEdge[];

    return { nodes, edges, seedNodes: seedIds };
  } finally {
    db.close();
  }
}

export function getNeighbors(dbPath: string, nodeId: string, limit = 20): NeighborResult[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const outgoing = db
      .prepare(
        `SELECT n.id, n.label, n.node_type, n.entity_type, n.degree, e.relation, e.weight, 'outgoing' AS direction
         FROM graph_edges e JOIN graph_nodes n ON n.id = e.target_id
         WHERE e.source_id = ? ORDER BY e.weight DESC LIMIT ?`,
      )
      .all(nodeId, limit) as NeighborResult[];

    const incoming = db
      .prepare(
        `SELECT n.id, n.label, n.node_type, n.entity_type, n.degree, e.relation, e.weight, 'incoming' AS direction
         FROM graph_edges e JOIN graph_nodes n ON n.id = e.source_id
         WHERE e.target_id = ? ORDER BY e.weight DESC LIMIT ?`,
      )
      .all(nodeId, limit) as NeighborResult[];

    return [...outgoing, ...incoming].slice(0, limit);
  } finally {
    db.close();
  }
}

export function getCommunity(dbPath: string, communityId: number): CommunityResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    const meta = db
      .prepare('SELECT id, label, cohesion_score FROM graph_communities WHERE id = ?')
      .get(communityId) as { id: number; label: string; cohesion_score: number } | undefined;

    const nodes = db
      .prepare(
        'SELECT id, label, node_type, entity_type, degree, community_id FROM graph_nodes WHERE community_id = ? ORDER BY degree DESC',
      )
      .all(communityId) as GraphNode[];

    return {
      communityId,
      label: meta?.label ?? null,
      cohesion_score: meta?.cohesion_score ?? null,
      nodes,
    };
  } finally {
    db.close();
  }
}

// BFS shortest path between two node IDs
export function shortestPath(dbPath: string, fromId: string, toId: string): PathResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    if (fromId === toId) {
      const node = db.prepare('SELECT label FROM graph_nodes WHERE id = ?').get(fromId) as { label: string } | undefined;
      return { found: true, path: [fromId], labels: [node?.label ?? fromId], length: 0 };
    }

    // BFS with parent tracking
    const parent = new Map<string, string>();
    const visited = new Set<string>([fromId]);
    const queue: string[] = [fromId];

    let found = false;
    while (queue.length > 0 && !found) {
      const current = queue.shift()!;
      const neighbors = db
        .prepare('SELECT source_id, target_id FROM graph_edges WHERE source_id = ? OR target_id = ?')
        .all(current, current) as { source_id: string; target_id: string }[];

      for (const { source_id, target_id } of neighbors) {
        const neighbor = source_id === current ? target_id : source_id;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          parent.set(neighbor, current);
          if (neighbor === toId) { found = true; break; }
          queue.push(neighbor);
        }
      }
    }

    if (!found) return { found: false, path: [], labels: [], length: 0 };

    // Reconstruct path
    const path: string[] = [];
    let cur: string | undefined = toId;
    while (cur) {
      path.unshift(cur);
      cur = parent.get(cur);
    }

    const labelRows = db
      .prepare(`SELECT id, label FROM graph_nodes WHERE id IN (${path.map(() => '?').join(',')})`)
      .all(...path) as { id: string; label: string }[];
    const labelMap = new Map(labelRows.map((r) => [r.id, r.label]));
    const labels = path.map((id) => labelMap.get(id) ?? id);

    return { found: true, path, labels, length: path.length - 1 };
  } finally {
    db.close();
  }
}
