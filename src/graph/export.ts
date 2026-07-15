/**
 * @file export.ts
 * @description Interactive HTML visualization with sidebar, context menu, vis-network.js
 * @version 1.3.0
 * @created 2026-04-14T00:00:00Z
 * @lastUpdated 2026-04-26T15:14:56Z
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { CLAUDE_BASE } from '../utils/links.js';

const _require = createRequire(import.meta.url);
const visJsSrc = _require.resolve('vis-network/standalone/umd/vis-network.min.js');

interface NodeRow {
  id: string;
  label: string;
  node_type: string;
  entity_type: string | null;
  degree: number;
  community_id: number | null;
  first_seen: string | null;
  last_seen: string | null;
  summary?: string | null;
  category?: string | null;
  conv_count?: number;
}

interface ConvMeta {
  uuid: string;
  name: string;
  updated_at: string;
  created_at: string;
}

// Map entity_type -> vis.js shape
function nodeShape(nodeType: string, entityType: string | null): string {
  if (nodeType === 'conversation') return 'square';
  if (nodeType === 'tool') return 'star';
  switch (entityType) {
    case 'url': return 'diamond';
    case 'uuid': return 'triangleDown';
    default: return 'dot';
  }
}

// Map timestamp -> color on a blue (old) -> red (recent) scale
function temporalColor(timestamp: string | null, minTs: number, maxTs: number): string {
  if (!timestamp) return '#aaaaaa';
  const t = new Date(timestamp).getTime();
  const range = maxTs - minTs || 1;
  const ratio = Math.max(0, Math.min(1, (t - minTs) / range));
  const r = Math.round(ratio < 0.5 ? ratio * 2 * 255 : 255);
  const g = Math.round(ratio < 0.5 ? 128 + ratio * 255 : 255 * (1 - (ratio - 0.5) * 2));
  const b = Math.round(ratio < 0.5 ? 255 * (1 - ratio * 2) : 0);
  return `rgb(${r},${g},${b})`;
}

// Map entity_type or node_type -> border color
function borderColor(entityType: string | null, nodeType?: string): string {
  if (nodeType === 'tool') return '#ff6b35';
  switch (entityType) {
    case 'topic': return '#e94560';
    case 'url': return '#59a14f';
    case 'uuid': return '#b07aa1';
    default: return '#ffffff';
  }
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
  confidence: string;
}

export interface ExportOptions {
  maxNodes?: number;
  entityOnly?: boolean;
  seedEntity?: string;
  seedDepth?: number;
  entityTypes?: string[];
  minDegree?: number;
  communityId?: number;
}

// Generate a deterministic color for each community_id
function communityColor(id: number | null): string {
  if (id == null) return '#aaaaaa';
  const palette = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  ];
  return palette[((id - 1) % palette.length + palette.length) % palette.length];
}

/**
 * Fruchterman-Reingold force-directed layout, seeded by community centroids.
 */
function forceDirectedLayout(
  nodes: NodeRow[],
  edges: EdgeRow[],
): Map<string, { x: number; y: number }> {
  const n = nodes.length;
  if (n === 0) return new Map();

  const area = n * 2000 * (1 + (edges.length / Math.max(1, n)) * 0.2);
  const k = Math.sqrt(area / n) * 1.5;

  const communityGroups = new Map<number, NodeRow[]>();
  for (const node of nodes) {
    const cid = node.community_id ?? 0;
    const group = communityGroups.get(cid) ?? [];
    group.push(node);
    communityGroups.set(cid, group);
  }

  const communities = [...communityGroups.entries()].sort((a, b) => b[1].length - a[1].length);
  const cRadius = Math.max(300, communities.length * 60);

  const pos = new Map<string, { x: number; y: number }>();
  communities.forEach(([, members], ci) => {
    const angle = (2 * Math.PI * ci) / communities.length;
    const cx = cRadius * Math.cos(angle);
    const cy = cRadius * Math.sin(angle);
    const jitter = Math.max(80, members.length * 20);
    for (const m of members) {
      pos.set(m.id, {
        x: cx + (Math.random() - 0.5) * jitter,
        y: cy + (Math.random() - 0.5) * jitter,
      });
    }
  });

  const edgeList = edges
    .filter((e) => pos.has(e.source_id) && pos.has(e.target_id))
    .map((e) => ({ from: e.source_id, to: e.target_id, weight: e.weight }));

  const edgeDensity = edges.length / Math.max(1, n);
  const attractionScale = Math.min(1, 5 / edgeDensity);

  const nodeList = nodes.map((nd) => nd.id);
  const iterations = 200;
  let temperature = k * 2;
  const cooling = temperature / iterations;

  for (let iter = 0; iter < iterations; iter++) {
    const disp = new Map<string, { dx: number; dy: number }>();
    for (const id of nodeList) disp.set(id, { dx: 0, dy: 0 });

    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const pi = pos.get(nodeList[i])!;
        const pj = pos.get(nodeList[j])!;
        let dx = pi.x - pj.x;
        let dy = pi.y - pj.y;
        const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
        const force = (k * k) / dist;
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        const di = disp.get(nodeList[i])!;
        const dj = disp.get(nodeList[j])!;
        di.dx += dx; di.dy += dy;
        dj.dx -= dx; dj.dy -= dy;
      }
    }

    for (const { from, to, weight } of edgeList) {
      const pi = pos.get(from)!;
      const pj = pos.get(to)!;
      let dx = pi.x - pj.x;
      let dy = pi.y - pj.y;
      const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
      const force = (dist * dist) / k * Math.min(Math.sqrt(weight), 3) * attractionScale * 0.1;
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      const di = disp.get(from)!;
      const dj = disp.get(to)!;
      di.dx -= dx; di.dy -= dy;
      dj.dx += dx; dj.dy += dy;
    }

    for (const id of nodeList) {
      const d = disp.get(id)!;
      const dist = Math.max(0.1, Math.sqrt(d.dx * d.dx + d.dy * d.dy));
      const capped = Math.min(dist, temperature);
      const p = pos.get(id)!;
      p.x += (d.dx / dist) * capped;
      p.y += (d.dy / dist) * capped;
    }

    temperature -= cooling;
  }

  return pos;
}

export function toHtml(dbPath: string, outputPath: string, options: ExportOptions = {}): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    const maxNodes = options.maxNodes ?? 200;

    // ── Query ALL conversations for the sidebar (independent of maxNodes) ──
    const allConversations = db.prepare(
      'SELECT uuid, name, updated_at, created_at FROM conversations ORDER BY updated_at DESC',
    ).all() as ConvMeta[];

    // ── Query graph nodes for the visualization ──
    let nodes: NodeRow[];

    if (options.seedEntity) {
      const depth = options.seedDepth ?? 2;
      const kw = `%${options.seedEntity.toLowerCase()}%`;
      const seeds = db
        .prepare('SELECT id FROM graph_nodes WHERE lower(label) LIKE ? OR lower(id) LIKE ? LIMIT 10')
        .all(kw, kw) as { id: string }[];

      if (seeds.length === 0) throw new Error(`No nodes match seed "${options.seedEntity}"`);

      const visited = new Set<string>(seeds.map((s) => s.id));
      let frontier = [...visited];
      for (let d = 0; d < depth && frontier.length > 0; d++) {
        const ph = frontier.map(() => '?').join(',');
        const neighbors = db
          .prepare(`SELECT DISTINCT CASE WHEN source_id IN (${ph}) THEN target_id ELSE source_id END as id FROM graph_edges WHERE source_id IN (${ph}) OR target_id IN (${ph})`)
          .all(...frontier, ...frontier, ...frontier) as { id: string }[];
        frontier = [];
        for (const { id } of neighbors) {
          if (!visited.has(id) && visited.size < maxNodes) {
            visited.add(id);
            frontier.push(id);
          }
        }
      }

      const ph = [...visited].map(() => '?').join(',');
      nodes = db
        .prepare(
          `SELECT gn.id, gn.label, gn.node_type, gn.entity_type, gn.degree, gn.community_id,
                  gn.first_seen, gn.last_seen, c.summary, gn.category
           FROM graph_nodes gn
           LEFT JOIN conversations c ON gn.node_type = 'conversation' AND gn.id = 'conv:' || c.uuid
           WHERE gn.id IN (${ph})
           ORDER BY gn.degree DESC`,
        )
        .all(...visited) as NodeRow[];
    } else {
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (options.entityOnly) conditions.push("gn.node_type = 'entity'");
      if (options.communityId != null) {
        conditions.push('gn.community_id = ?');
        params.push(options.communityId);
      }
      if (options.entityTypes && options.entityTypes.length > 0) {
        const ph = options.entityTypes.map(() => '?').join(',');
        conditions.push(`gn.entity_type IN (${ph})`);
        params.push(...options.entityTypes);
      }
      if (options.minDegree != null) {
        conditions.push('gn.degree >= ?');
        params.push(options.minDegree);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Balanced selection: allocate quota per node category to avoid tool/URL nodes
      // dominating the top-N by degree. Each category gets a proportional share.
      const hasFilters = conditions.length > 0;
      if (hasFilters) {
        nodes = db
          .prepare(
            `SELECT gn.id, gn.label, gn.node_type, gn.entity_type, gn.degree, gn.community_id,
                    gn.first_seen, gn.last_seen, c.summary, gn.category
             FROM graph_nodes gn
             LEFT JOIN conversations c ON gn.node_type = 'conversation' AND gn.id = 'conv:' || c.uuid
             ${whereClause}
             ORDER BY gn.degree DESC LIMIT ?`,
          )
          .all(...params, maxNodes) as NodeRow[];
      } else {
        // No filters: balanced selection across categories
        const categories = [
          { where: "gn.entity_type = 'topic'", share: 0.30 },
          { where: "gn.entity_type = 'tool'", share: 0.25 },
          { where: "gn.node_type = 'conversation'", share: 0.25 },
          { where: "gn.entity_type = 'url'", share: 0.15 },
          { where: "gn.entity_type = 'uuid'", share: 0.05 },
        ];
        nodes = [];
        for (const cat of categories) {
          const limit = Math.max(1, Math.floor(maxNodes * cat.share));
          const catNodes = db
            .prepare(
              `SELECT gn.id, gn.label, gn.node_type, gn.entity_type, gn.degree, gn.community_id,
                      gn.first_seen, gn.last_seen, c.summary, gn.category
               FROM graph_nodes gn
               LEFT JOIN conversations c ON gn.node_type = 'conversation' AND gn.id = 'conv:' || c.uuid
               WHERE ${cat.where}
               ORDER BY gn.degree DESC LIMIT ?`,
            )
            .all(limit) as NodeRow[];
          nodes.push(...catNodes);
        }
        // Deduplicate and trim to maxNodes
        const seen = new Set<string>();
        nodes = nodes.filter((n) => {
          if (seen.has(n.id)) return false;
          seen.add(n.id);
          return true;
        }).slice(0, maxNodes);
      }
    }

    if (nodes.length === 0) {
      throw new Error('No graph nodes found. Run graph-build first.');
    }

    // ── Count linked conversations per entity node ──
    for (const n of nodes) {
      if (n.node_type === 'entity') {
        const row = db.prepare(
          "SELECT COUNT(*) as cnt FROM graph_edges WHERE source_id = ? AND relation = 'mentioned_in'",
        ).get(n.id) as { cnt: number };
        n.conv_count = row.cnt;
      }
    }

    const nodeIds = new Set(nodes.map((n) => n.id));
    const placeholders = [...nodeIds].map(() => '?').join(',');

    const edges = db
      .prepare(
        `SELECT source_id, target_id, relation, weight, confidence
         FROM graph_edges
         WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})`,
      )
      .all(...nodeIds, ...nodeIds) as EdgeRow[];

    // ── For detail panel: get ALL conversation neighbors for entity + tool nodes ──
    // Store only UUIDs (names looked up client-side from allConversations)
    const entityConvMap = new Map<string, string[]>();
    for (const n of nodes) {
      if (n.node_type === 'entity') {
        const convRows = db.prepare(
          `SELECT ge.target_id
           FROM graph_edges ge
           JOIN conversations c ON 'conv:' || c.uuid = ge.target_id
           WHERE ge.source_id = ? AND ge.relation = 'mentioned_in'
           ORDER BY c.updated_at DESC`,
        ).all(n.id) as { target_id: string }[];
        entityConvMap.set(n.id, convRows.map((r) => r.target_id.slice(5)));
      } else if (n.node_type === 'tool') {
        const convRows = db.prepare(
          `SELECT ge.source_id
           FROM graph_edges ge
           JOIN conversations c ON 'conv:' || c.uuid = ge.source_id
           WHERE ge.target_id = ? AND ge.relation = 'uses_tool'
           ORDER BY c.updated_at DESC`,
        ).all(n.id) as { source_id: string }[];
        entityConvMap.set(n.id, convRows.map((r) => r.source_id.slice(5)));
      }
    }

    // Force-directed layout
    const positionMap = forceDirectedLayout(nodes, edges);

    // Temporal range for color scaling
    const timestamps = nodes
      .map((nd) => nd.first_seen)
      .filter((t): t is string => t != null)
      .map((t) => new Date(t).getTime());
    const minTs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
    const maxTs = timestamps.length > 0 ? Math.max(...timestamps) : 1;

    const visNodes = nodes.map((n) => {
      const summaryLine = n.summary ? `\n${n.summary}` : '';
      const firstSeen = n.first_seen ? new Date(n.first_seen).toLocaleDateString() : 'unknown';
      const lastSeen = n.last_seen ? new Date(n.last_seen).toLocaleDateString() : 'unknown';
      const p = positionMap.get(n.id) ?? { x: 0, y: 0 };
      // Entity labels include conversation count
      let label = n.label.length > 24 ? n.label.slice(0, 22) + '\u2026' : n.label;
      if (n.node_type === 'entity' && n.conv_count && n.conv_count > 0) {
        label += ` (${n.conv_count})`;
      }
      return {
        id: n.id,
        label,
        fullLabel: n.label,
        title: `${n.label}\nType: ${n.entity_type ?? n.node_type} | Degree: ${n.degree} | Community: ${n.community_id ?? 'none'}${n.conv_count ? ` | Conversations: ${n.conv_count}` : ''}\nFirst seen: ${firstSeen} | Last seen: ${lastSeen}${summaryLine}${n.node_type === 'conversation' ? '\nDouble-click to open in Claude.ai' : (n.node_type === 'entity' || n.node_type === 'tool') ? '\nDouble-click to filter sidebar' : ''}`,
        shape: nodeShape(n.node_type, n.entity_type),
        x: p.x,
        y: p.y,
        fixed: true,
        size: Math.max(10, Math.min(60, 8 + Math.sqrt(n.degree))),
        color: { background: communityColor(n.community_id), border: borderColor(n.entity_type, n.node_type), highlight: { background: '#e94560', border: '#ffffff' } },
        font: { color: '#ffffff', size: 14, strokeWidth: 2, strokeColor: '#000000' },
        _communityColor: communityColor(n.community_id),
        _temporalColor: temporalColor(n.first_seen, minTs, maxTs),
        _entityType: n.entity_type,
        _borderColor: borderColor(n.entity_type, n.node_type),
        _convUuid: n.node_type === 'conversation' ? n.id.slice(5) : null,
        _category: n.category ?? null,
        _nodeType: n.node_type,
        _degree: n.degree,
      };
    });

    const visEdges = edges.map((e, i) => ({
      id: i,
      from: e.source_id,
      to: e.target_id,
      title: `${e.source_id} \u2192 ${e.target_id} (${e.relation}, weight: ${e.weight.toFixed(1)})`,
      width: Math.max(0.5, Math.min(4, Math.sqrt(e.weight))),
      dashes: e.relation === 'mentioned_in' ? [5, 5] : false,
      arrows: e.relation === 'mentioned_in' ? { to: { enabled: true, scaleFactor: 0.5 } } : undefined,
      color: { color: '#333333', opacity: 0.15 },
    }));

    // Serialize data for JS — just UUID arrays (names looked up client-side)
    const entityConvJson: Record<string, string[]> = {};
    for (const [k, v] of entityConvMap) entityConvJson[k] = v;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CCR Knowledge Graph</title>
  <script src="vis-network.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; height: 100vh; overflow: hidden; }

    /* Toolbar */
    #toolbar { padding: 8px 16px; background: #16213e; display: flex; gap: 12px; align-items: center; border-bottom: 1px solid #0f3460; height: 44px; flex-shrink: 0; }
    #toolbar h1 { font-size: 14px; font-weight: 600; color: #e94560; margin-right: 8px; white-space: nowrap; }
    #search { background: #0f3460; border: 1px solid #e94560; color: #eee; padding: 5px 10px; border-radius: 4px; font-size: 13px; width: 200px; }
    #stats { font-size: 12px; color: #aaa; margin-left: auto; white-space: nowrap; }
    .tb-btn { background: #0f3460; border: 1px solid #4a6080; color: #aaa; padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; white-space: nowrap; }
    .tb-btn:hover { border-color: #e94560; color: #eee; }
    .tb-btn.active { border-color: #e94560; color: #e94560; }
    #legend { display: flex; gap: 10px; font-size: 11px; color: #aaa; align-items: center; }
    .legend-item { display: flex; align-items: center; gap: 3px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; border: 2px solid; display: inline-block; }
    .legend-diamond { width: 10px; height: 10px; transform: rotate(45deg); border: 2px solid; display: inline-block; }
    .legend-tri { width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 10px solid; display: inline-block; }
    .legend-sq { width: 10px; height: 10px; border: 2px solid; display: inline-block; }

    /* Main layout */
    #main { display: flex; height: calc(100vh - 44px); }
    #graph-wrap { flex: 1; position: relative; min-width: 0; }
    #graph { width: 100%; height: 100%; }

    /* Controls panel (top-right of graph) */
    #controls { position: absolute; top: 8px; right: 8px; background: rgba(22,33,62,0.92); border: 1px solid #0f3460; border-radius: 6px; padding: 10px 14px; font-size: 12px; z-index: 50; display: flex; flex-direction: column; gap: 8px; min-width: 180px; }
    #controls label { display: flex; align-items: center; gap: 6px; cursor: pointer; color: #aaa; }
    #controls label:hover { color: #eee; }
    #controls input[type="checkbox"] { accent-color: #e94560; }
    #controls input[type="range"] { width: 100%; accent-color: #e94560; }
    .ctrl-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

    /* Conversation sidebar */
    #conv-sidebar { width: 320px; background: #16213e; border-left: 1px solid #0f3460; display: flex; flex-direction: column; flex-shrink: 0; transition: width 0.2s, opacity 0.2s; overflow: hidden; }
    #conv-sidebar.collapsed { width: 0; opacity: 0; pointer-events: none; }
    #conv-sidebar-header { padding: 10px 14px; border-bottom: 1px solid #0f3460; }
    #conv-sidebar-header h2 { font-size: 13px; color: #e94560; margin-bottom: 8px; font-weight: 600; }
    #conv-search { width: 100%; background: #0f3460; border: 1px solid #4a6080; color: #eee; padding: 5px 10px; border-radius: 4px; font-size: 12px; }
    #conv-search:focus { border-color: #e94560; outline: none; }
    #conv-count { display: block; font-size: 11px; color: #666; margin-top: 6px; }
    #conv-list { flex: 1; overflow-y: auto; padding: 4px 0; }
    #conv-list::-webkit-scrollbar { width: 6px; }
    #conv-list::-webkit-scrollbar-track { background: #16213e; }
    #conv-list::-webkit-scrollbar-thumb { background: #0f3460; border-radius: 3px; }
    .conv-item { padding: 8px 14px; border-bottom: 1px solid rgba(15,52,96,0.5); cursor: pointer; transition: background 0.15s; }
    .conv-item:hover { background: rgba(15,52,96,0.8); }
    .conv-item.highlighted { background: rgba(233,69,96,0.15); border-left: 3px solid #e94560; }
    .conv-item .conv-name { font-size: 12px; color: #ddd; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conv-item .conv-date { font-size: 10px; color: #666; margin-top: 2px; }
    .conv-item .conv-open { color: #4fc3f7; text-decoration: none; font-size: 11px; float: right; margin-top: -14px; }
    .conv-item .conv-open:hover { text-decoration: underline; }

    /* Detail panel */
    #detail-panel { position: absolute; bottom: 12px; left: 12px; background: rgba(22,33,62,0.95); border: 1px solid #e94560; border-radius: 8px; padding: 14px 18px; font-size: 12px; z-index: 50; max-width: 380px; max-height: 60vh; overflow-y: auto; display: none; line-height: 1.6; }
    #detail-panel h3 { font-size: 14px; color: #e94560; margin-bottom: 6px; word-break: break-all; }
    #detail-panel .meta { color: #aaa; }
    #detail-panel .neighbors { margin-top: 8px; }
    #detail-panel .neighbors span { display: inline-block; background: #0f3460; padding: 2px 8px; border-radius: 3px; margin: 2px; font-size: 11px; }
    #detail-close { position: absolute; top: 6px; right: 10px; cursor: pointer; color: #666; font-size: 16px; }
    #detail-close:hover { color: #e94560; }
    .conv-link { color:#4fc3f7; text-decoration:none; display:inline-block; background:#0f3460; padding:3px 10px; border-radius:4px; margin:2px; font-size:11px; line-height: 1.5; }
    .conv-link:hover { text-decoration:underline; background:#1a4a80; }
    .conv-link-primary { display:inline-block; background:#e94560; color:#fff; padding:5px 14px; border-radius:4px; font-size:12px; text-decoration:none; font-weight:600; margin-bottom: 8px; }
    .conv-link-primary:hover { background:#c73650; }

    /* Context menu */
    #ctx-menu { position: fixed; background: #16213e; border: 1px solid #e94560; border-radius: 6px; padding: 4px 0; z-index: 200; display: none; min-width: 200px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
    #ctx-menu .ctx-item { padding: 6px 14px; font-size: 12px; cursor: pointer; color: #ddd; }
    #ctx-menu .ctx-item:hover { background: rgba(233,69,96,0.2); color: #fff; }

    /* Loading */
    #loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #1a1a2e; z-index: 10; gap: 12px; }
    #loading-bar-wrap { width: 240px; height: 4px; background: #0f3460; border-radius: 2px; }
    #loading-bar { height: 100%; width: 0%; background: #e94560; border-radius: 2px; transition: width 0.1s; }
    #loading-text { font-size: 13px; color: #aaa; }
  </style>
</head>
<body>
  <div id="toolbar">
    <h1>CCR Knowledge Graph</h1>
    <input id="search" type="text" placeholder="Search nodes\u2026" autocomplete="off">
    <button class="tb-btn" id="physics-btn">Physics: off</button>
    <select id="color-mode" style="background:#0f3460;border:1px solid #4a6080;color:#aaa;padding:4px 8px;border-radius:4px;font-size:12px;cursor:pointer">
      <option value="community">Color: Community</option>
      <option value="time">Color: Timeline</option>
      <option value="type">Color: Entity Type</option>
      <option value="category">Color: Category</option>
      <option value="profile">Color: Profile Type</option>
    </select>
    <div id="legend">
      <span class="legend-item"><span class="legend-dot" style="border-color:#e94560;background:#4e79a7"></span>Topic</span>
      <span class="legend-item"><span class="legend-diamond" style="border-color:#59a14f;background:#4e79a7"></span>URL</span>
      <span class="legend-item"><span class="legend-tri" style="border-top-color:#b07aa1"></span>UUID</span>
      <span class="legend-item"><span class="legend-sq" style="border-color:#fff;background:#4e79a7"></span>Conv</span>
      <span class="legend-item"><span class="legend-dot" style="border-color:#ff6b35;background:#ff6b35"></span>Tool</span>
      <span class="legend-item" style="margin-left:6px;color:#666">\u2014 co-occurs</span>
      <span class="legend-item" style="color:#666">\u2504 mentioned-in</span>
    </div>
    <button class="tb-btn active" id="sidebar-toggle">\u2630 Conversations</button>
    <span id="stats">${nodes.length} nodes \u00b7 ${edges.length} edges</span>
  </div>
  <div id="main">
    <div id="graph-wrap">
      <div id="graph">
        <div id="loading">
          <div id="loading-bar-wrap"><div id="loading-bar"></div></div>
          <div id="loading-text">Laying out graph\u2026</div>
        </div>
      </div>
      <div id="controls">
        <div class="ctrl-label">Show Types</div>
        <label><input type="checkbox" data-type="topic" checked> Topics</label>
        <label><input type="checkbox" data-type="url" checked> URLs</label>
        <label><input type="checkbox" data-type="uuid" checked> UUIDs</label>
        <label><input type="checkbox" data-type="conversation" checked> Conversations</label>
        <label><input type="checkbox" data-type="tool" checked> Tools</label>
        <div class="ctrl-label">Min Degree</div>
        <input type="range" id="degree-slider" min="0" max="100" value="0">
        <span id="degree-val" style="font-size:11px;color:#aaa">0</span>
        <div class="ctrl-label">Min Edge Weight</div>
        <input type="range" id="weight-slider" min="0" max="50" value="0" step="1">
        <span id="weight-val" style="font-size:11px;color:#aaa">0</span>
      </div>
    </div>
    <div id="conv-sidebar">
      <div id="conv-sidebar-header">
        <h2>All Conversations</h2>
        <input id="conv-search" type="text" placeholder="Filter by name\u2026" autocomplete="off">
        <span id="conv-count"></span>
      </div>
      <div id="conv-list"></div>
    </div>
  </div>
  <div id="detail-panel"><span id="detail-close">\u00d7</span><h3 id="detail-title"></h3><div id="detail-body"></div></div>
  <div id="ctx-menu"></div>

  <script>
    // ── Data ──
    const nodeData = ${JSON.stringify(visNodes)};
    const edgeData = ${JSON.stringify(visEdges)};
    const allConversations = ${JSON.stringify(allConversations)};
    const entityConvMap = ${JSON.stringify(entityConvJson)};
    const CLAUDE_BASE = '${CLAUDE_BASE}';

    // ── Lookup maps ──
    const convNameMap = {};
    allConversations.forEach(c => { convNameMap[c.uuid] = c.name; });
    const convUuidSet = new Set(nodeData.filter(n => n._convUuid).map(n => n._convUuid));

    // ── Graph ──
    const nodes = new vis.DataSet(nodeData);
    const edges = new vis.DataSet(edgeData);
    const container = document.getElementById('graph');
    let physicsOn = false;
    const network = window.network = new vis.Network(container, { nodes, edges }, {
      physics: { enabled: false },
      interaction: { hover: true, tooltipDelay: 100, hideEdgesOnDrag: true, zoomView: true },
      edges: { smooth: { enabled: false } },
      nodes: { borderWidth: 3, borderWidthSelected: 4 }
    });

    document.getElementById('loading').style.display = 'none';
    setTimeout(() => network.fit({ animation: false }), 200);
    setTimeout(() => network.fit({ animation: false }), 1000);

    // ── Conversation Sidebar ──
    const convListEl = document.getElementById('conv-list');
    const convCountEl = document.getElementById('conv-count');
    let sidebarFilter = '';
    let sidebarEntityFilter = null; // if set, only show conversations linked to this entity

    function renderConvSidebar() {
      const q = sidebarFilter.toLowerCase().trim();
      let convs = allConversations;

      // If filtering by entity/tool, only show linked conversations
      if (sidebarEntityFilter && entityConvMap[sidebarEntityFilter]) {
        const linkedUuids = new Set(entityConvMap[sidebarEntityFilter]);
        convs = convs.filter(c => linkedUuids.has(c.uuid));
      }

      if (q) {
        convs = convs.filter(c => (c.name || '').toLowerCase().includes(q));
      }

      convCountEl.textContent = convs.length + ' of ' + allConversations.length + ' conversations' +
        (sidebarEntityFilter ? ' (filtered by entity)' : '');

      // Render in batches for performance
      const html = convs.slice(0, 200).map(c => {
        const date = new Date(c.updated_at).toLocaleDateString();
        const name = c.name || c.uuid.slice(0, 12) + '\u2026';
        const hasGraphNode = convUuidSet.has(c.uuid);
        return '<div class="conv-item" data-uuid="' + c.uuid + '">' +
          '<span class="conv-name">' + escHtml(name) + '</span>' +
          '<span class="conv-date">' + date +
          (hasGraphNode ? ' \u00b7 <span style="color:#59a14f">in graph</span>' : '') +
          '</span>' +
          '<a href="' + CLAUDE_BASE + '/chat/' + c.uuid + '" target="_blank" class="conv-open" onclick="event.stopPropagation()">\u2197 Open</a>' +
          '</div>';
      }).join('');

      convListEl.innerHTML = html + (convs.length > 200 ? '<div style="padding:8px 14px;color:#666;font-size:11px">' + (convs.length - 200) + ' more\u2026 use filter to narrow</div>' : '');
    }

    function escHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    renderConvSidebar();

    let _sidebarTimer;
    document.getElementById('conv-search').addEventListener('input', (e) => {
      clearTimeout(_sidebarTimer);
      _sidebarTimer = setTimeout(() => { sidebarFilter = e.target.value; renderConvSidebar(); }, 150);
    });

    // Click conv item -> focus graph node if it exists, else just highlight
    convListEl.addEventListener('click', (e) => {
      const item = e.target.closest('.conv-item');
      if (!item) return;
      const uuid = item.dataset.uuid;
      const graphNodeId = 'conv:' + uuid;
      const graphNode = nodeData.find(n => n.id === graphNodeId);
      if (graphNode) {
        network.selectNodes([graphNodeId]);
        network.focus(graphNodeId, { scale: 1.5, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
        // Trigger detail panel
        showDetailPanel(graphNodeId);
      }
      // Highlight in sidebar
      convListEl.querySelectorAll('.conv-item').forEach(el => el.classList.remove('highlighted'));
      item.classList.add('highlighted');
    });

    // Sidebar toggle
    const sidebar = document.getElementById('conv-sidebar');
    const sidebarBtn = document.getElementById('sidebar-toggle');
    sidebarBtn.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      sidebarBtn.classList.toggle('active');
      setTimeout(() => network.fit({ animation: false }), 300);
    });

    // ── Physics ──
    document.getElementById('physics-btn').addEventListener('click', () => {
      physicsOn = !physicsOn;
      network.setOptions({ physics: { enabled: physicsOn } });
      document.getElementById('physics-btn').textContent = 'Physics: ' + (physicsOn ? 'on' : 'off');
      if (!physicsOn) network.fit();
    });

    // ── Node search ──
    document.getElementById('search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      if (!q) {
        nodes.update(nodeData.map(n => ({ id: n.id, opacity: 1 })));
        return;
      }
      nodes.update(nodeData.map(n => ({
        id: n.id,
        opacity: (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q) || (n.fullLabel || '').toLowerCase().includes(q)) ? 1 : 0.08
      })));
    });

    // ── Color mode ──
    const typeColorMap = { topic: '#e94560', url: '#59a14f', uuid: '#b07aa1', conversation: '#4fc3f7', tool: '#ff6b35' };
    const profileTypeColorMap = { coding: '#4fc3f7', devops: '#ff6b35', research: '#59a14f', qa: '#e94560', general: '#aaaaaa' };
    const categoryPalette = ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4','#42d4f4','#f032e6','#bfef45','#fabebe','#469990','#e6beff','#9a6324','#800000','#aaffc3'];
    const categorySet = [...new Set(nodeData.map(n => n._category).filter(Boolean))];
    const categoryColorMap = {};
    categorySet.forEach((c, i) => { categoryColorMap[c] = categoryPalette[i % categoryPalette.length]; });
    document.getElementById('color-mode').addEventListener('change', (e) => {
      const mode = e.target.value;
      nodes.update(nodeData.map(n => {
        let bg;
        if (mode === 'community') bg = n._communityColor;
        else if (mode === 'time') bg = n._temporalColor;
        else if (mode === 'category') bg = n._category ? categoryColorMap[n._category] : '#555555';
        else if (mode === 'profile') bg = (n._nodeType === 'conversation' && n._category) ? (profileTypeColorMap[n._category] || '#555555') : '#333333';
        else bg = typeColorMap[n._entityType || n._nodeType] || '#aaaaaa';
        return { id: n.id, color: { background: bg, border: n._borderColor, highlight: { background: '#e94560', border: '#ffffff' } } };
      }));
    });

    // ── Filters ──
    const hiddenTypes = new Set();
    let minDegree = 0;
    let minWeight = 0;

    function applyFilters() {
      const nodeBatch = [];
      let visibleNodes = 0;
      nodeData.forEach(n => {
        const nodeType = n._entityType || (n._nodeType === 'conversation' ? 'conversation' : (n._nodeType === 'tool' ? 'tool' : null));
        const hidden = hiddenTypes.has(nodeType) || n._degree < minDegree;
        nodeBatch.push({ id: n.id, hidden });
        if (!hidden) visibleNodes++;
      });
      nodes.update(nodeBatch);
      const edgeBatch = [];
      let visibleEdges = 0;
      edgeData.forEach(e => {
        const hidden = (e.width * e.width) < minWeight;
        edgeBatch.push({ id: e.id, hidden });
        if (!hidden) visibleEdges++;
      });
      edges.update(edgeBatch);
      document.getElementById('stats').textContent = visibleNodes + ' nodes \u00b7 ' + visibleEdges + ' edges';
    }

    document.querySelectorAll('#controls input[data-type]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) hiddenTypes.delete(cb.dataset.type);
        else hiddenTypes.add(cb.dataset.type);
        applyFilters();
      });
    });

    document.getElementById('degree-slider').addEventListener('input', (e) => {
      minDegree = parseInt(e.target.value);
      document.getElementById('degree-val').textContent = minDegree;
      applyFilters();
    });

    document.getElementById('weight-slider').addEventListener('input', (e) => {
      minWeight = parseInt(e.target.value);
      document.getElementById('weight-val').textContent = minWeight;
      applyFilters();
    });

    // ── Detail panel ──
    function showDetailPanel(nodeId) {
      const panel = document.getElementById('detail-panel');
      const n = nodeData.find(d => d.id === nodeId);
      if (!n) { panel.style.display = 'none'; return; }

      document.getElementById('detail-title').textContent = n.fullLabel || n.id;

      let html = '';

      // Conversation links — FIRST and PROMINENT
      if (n._convUuid) {
        // This IS a conversation node
        html += '<div style="margin-bottom:10px"><a href="' + CLAUDE_BASE + '/chat/' + n._convUuid + '" target="_blank" class="conv-link-primary">Open in Claude.ai \u2197</a></div>';
        if (n._category) html += '<div style="margin-bottom:6px;font-size:11px"><span style="background:' + (categoryColorMap[n._category] || '#555') + ';padding:2px 8px;border-radius:3px;color:#fff;font-weight:600">' + escHtml(n._category) + '</span></div>';
      } else if (entityConvMap[nodeId]) {
        // Entity or tool node — show ALL linked conversations
        const uuids = entityConvMap[nodeId];
        if (uuids.length > 0) {
          html += '<div style="margin-bottom:8px"><div class="ctrl-label" style="margin-bottom:4px">Conversations (' + uuids.length + ')</div>';
          html += '<div style="max-height:200px;overflow-y:auto">';
          uuids.forEach(uuid => {
            const label = (convNameMap[uuid] || uuid.slice(0, 12)).slice(0, 40);
            html += '<a href="' + CLAUDE_BASE + '/chat/' + uuid + '" target="_blank" class="conv-link">' + escHtml(label) + ' \u2197</a> ';
          });
          html += '</div></div>';
        }
      }

      // Metadata
      html += '<div class="meta">' + n.title.replace(/\\n/g, '<br>') + '</div>';

      // Connected nodes
      const connEdges = edgeData.filter(e => e.from === nodeId || e.to === nodeId);
      const neighborSet = new Set();
      connEdges.forEach(e => neighborSet.add(e.from === nodeId ? e.to : e.from));
      const neighborIds = [...neighborSet];
      const entityNeighbors = neighborIds.filter(id => !id.startsWith('conv:')).slice(0, 20);
      if (entityNeighbors.length > 0) {
        const labels = entityNeighbors.map(id => {
          const nd = nodeData.find(d => d.id === id);
          return nd ? nd.label : id.slice(0, 20);
        });
        html += '<div class="neighbors"><div class="ctrl-label">Connected entities (' + entityNeighbors.length + ')</div>';
        html += labels.map(l => '<span>' + escHtml(l) + '</span>').join('');
        html += '</div>';
      }

      document.getElementById('detail-body').innerHTML = html;
      panel.style.display = 'block';
    }

    network.on('click', (params) => {
      if (params.nodes.length === 0) {
        document.getElementById('detail-panel').style.display = 'none';
        return;
      }
      showDetailPanel(params.nodes[0]);
    });

    network.on('doubleClick', (params) => {
      if (params.nodes.length === 0) return;
      const n = nodeData.find(d => d.id === params.nodes[0]);
      if (n && n._convUuid) {
        window.open('${CLAUDE_BASE}/chat/' + n._convUuid, '_blank');
      } else if (n && (n._nodeType === 'entity' || n._nodeType === 'tool') && entityConvMap[n.id]) {
        sidebarEntityFilter = n.id;
        sidebarFilter = '';
        document.getElementById('conv-search').value = '';
        sidebar.classList.remove('collapsed');
        sidebarBtn.classList.add('active');
        renderConvSidebar();
      }
    });

    document.getElementById('detail-close').addEventListener('click', () => {
      document.getElementById('detail-panel').style.display = 'none';
    });

    // ── Right-click context menu ──
    const ctxMenu = document.getElementById('ctx-menu');
    let ctxNodeId = null;

    network.on('oncontext', (params) => {
      params.event.preventDefault();
      const nodeId = network.getNodeAt(params.pointer.DOM);
      if (!nodeId) { ctxMenu.style.display = 'none'; return; }
      ctxNodeId = nodeId;
      const n = nodeData.find(d => d.id === nodeId);
      if (!n) return;

      let items = '';
      if (n._convUuid) {
        items += '<div class="ctx-item" data-action="open">Open in Claude.ai \u2197</div>';
      }
      items += '<div class="ctx-item" data-action="detail">Show details</div>';
      if ((n._nodeType === 'entity' || n._nodeType === 'tool') && entityConvMap[n.id]) {
        items += '<div class="ctx-item" data-action="filter-sidebar">Show linked conversations in sidebar</div>';
      }
      items += '<div class="ctx-item" data-action="focus">Focus / zoom to node</div>';

      ctxMenu.innerHTML = items;
      ctxMenu.style.left = params.event.clientX + 'px';
      ctxMenu.style.top = params.event.clientY + 'px';
      ctxMenu.style.display = 'block';
    });

    ctxMenu.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (!action || !ctxNodeId) return;
      const n = nodeData.find(d => d.id === ctxNodeId);
      if (action === 'open' && n && n._convUuid) {
        window.open('${CLAUDE_BASE}/chat/' + n._convUuid, '_blank');
      } else if (action === 'detail') {
        showDetailPanel(ctxNodeId);
      } else if (action === 'filter-sidebar') {
        sidebarEntityFilter = ctxNodeId;
        document.getElementById('conv-search').value = '';
        sidebarFilter = '';
        sidebar.classList.remove('collapsed');
        sidebarBtn.classList.add('active');
        renderConvSidebar();
      } else if (action === 'focus') {
        network.focus(ctxNodeId, { scale: 1.5, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
      }
      ctxMenu.style.display = 'none';
    });

    // Clear entity filter with a reset link
    document.getElementById('conv-sidebar-header').addEventListener('click', (e) => {
      if (e.target.tagName === 'H2' && sidebarEntityFilter) {
        sidebarEntityFilter = null;
        renderConvSidebar();
      }
    });

    // Dismiss context menu on click elsewhere
    document.addEventListener('click', () => { ctxMenu.style.display = 'none'; });

    // ── Hash navigation ──
    function handleHash() {
      const hash = window.location.hash;
      if (!hash) return;
      const match = hash.match(/^#node=(.+)$/);
      if (match) {
        const nodeId = decodeURIComponent(match[1]);
        const exists = nodeData.find(n => n.id === nodeId);
        if (exists) {
          network.selectNodes([nodeId]);
          network.focus(nodeId, { scale: 1.5, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
          showDetailPanel(nodeId);
        }
      }
    }
    setTimeout(handleHash, 500);
    window.addEventListener('hashchange', handleHash);
  </script>
</body>
</html>`;

    fs.writeFileSync(outputPath, html, 'utf-8');
    const visJsDest = path.join(path.dirname(outputPath), 'vis-network.min.js');
    fs.copyFileSync(visJsSrc, visJsDest);
  } finally {
    db.close();
  }
}
