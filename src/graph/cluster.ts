/**
 * @file cluster.ts
 * @description Community detection dispatcher: label propagation or k-means
 * @version 1.1.0
 * @created 2026-04-14T00:00:00Z
 * @lastUpdated 2026-04-16T00:00:00Z
 */
import Database from 'better-sqlite3';
import { kmeansClusterGraph } from './kmeans.js';

export type ClusterMethod = 'label-propagation' | 'kmeans';

export interface ClusterResult {
  communityCount: number;
  largestCommunity: number;
  avgCohesion: number;
  iterations: number;
  method: string;
  silhouette?: number;
}

interface WeightedEdgeRow {
  source_id: string;
  target_id: string;
  weight: number;
}

/**
 * Label propagation clustering — each node adopts the label with the
 * highest sum of edge weights among its neighbors. Unlike Union-Find,
 * this can split a connected component into dense sub-communities.
 */
function labelPropagation(
  nodeIds: string[],
  edges: WeightedEdgeRow[],
  maxIterations = 25,
): { labels: Map<string, number>; iterations: number } {
  // Build weighted adjacency list
  const adj = new Map<string, { neighbor: string; weight: number }[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const { source_id, target_id, weight } of edges) {
    adj.get(source_id)?.push({ neighbor: target_id, weight });
    adj.get(target_id)?.push({ neighbor: source_id, weight });
  }

  // Initialize: each node gets its own label (index-based)
  const label = new Map<string, number>();
  nodeIds.forEach((id, i) => label.set(id, i));

  // Shuffled order for iteration (Fisher-Yates)
  const order = [...nodeIds];
  const shuffle = (arr: string[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };

  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    shuffle(order);
    let changed = 0;

    for (const nodeId of order) {
      const neighbors = adj.get(nodeId);
      if (!neighbors || neighbors.length === 0) continue;

      // Sum weights per neighbor label
      const weightByLabel = new Map<number, number>();
      for (const { neighbor, weight } of neighbors) {
        const nLabel = label.get(neighbor)!;
        weightByLabel.set(nLabel, (weightByLabel.get(nLabel) ?? 0) + weight);
      }

      // Find label with max weight
      let bestLabel = label.get(nodeId)!;
      let bestWeight = -1;
      for (const [lbl, w] of weightByLabel) {
        if (w > bestWeight) {
          bestWeight = w;
          bestLabel = lbl;
        }
      }

      if (bestLabel !== label.get(nodeId)!) {
        label.set(nodeId, bestLabel);
        changed++;
      }
    }

    iterations = iter + 1;
    const changeRate = changed / nodeIds.length;
    if (changeRate < 0.01) break; // Converged
  }

  return { labels: label, iterations };
}

export function clusterGraph(dbPath: string, method: ClusterMethod = 'label-propagation', k?: number): ClusterResult {
  if (method === 'kmeans') {
    const result = kmeansClusterGraph(dbPath, k);
    return {
      communityCount: result.communityCount,
      largestCommunity: result.largestCommunity,
      avgCohesion: result.avgSilhouette,
      iterations: result.iterations,
      method: 'kmeans',
      silhouette: result.avgSilhouette,
    };
  }
  return labelPropagationCluster(dbPath);
}

function labelPropagationCluster(dbPath: string): ClusterResult {
  const db = new Database(dbPath);
  try {
    const entityNodes = db
      .prepare("SELECT id FROM graph_nodes WHERE node_type = 'entity'")
      .all() as { id: string }[];

    const edges = db
      .prepare("SELECT source_id, target_id, weight FROM graph_edges WHERE relation = 'co_occurs'")
      .all() as WeightedEdgeRow[];

    const nodeIds = entityNodes.map((n) => n.id);
    const { labels, iterations } = labelPropagation(nodeIds, edges);

    // Group nodes by label
    const groups = new Map<number, string[]>();
    for (const [nodeId, lbl] of labels) {
      const members = groups.get(lbl) ?? [];
      members.push(nodeId);
      groups.set(lbl, members);
    }

    // Sort by size descending, assign sequential community IDs
    const sortedGroups = [...groups.values()].sort((a, b) => b.length - a.length);

    // Build edge set for cohesion scoring
    const edgeSet = new Set(edges.map((e) => `${e.source_id}|${e.target_id}`));
    const cohesionScore = (members: string[]): number => {
      if (members.length < 2) return 0;
      let intraEdges = 0;
      // For large communities, sample instead of computing all pairs
      if (members.length > 200) {
        const sampleSize = 500;
        let sampled = 0;
        for (let s = 0; s < sampleSize; s++) {
          const i = Math.floor(Math.random() * members.length);
          const j = Math.floor(Math.random() * members.length);
          if (i === j) continue;
          sampled++;
          const a = members[i];
          const b = members[j];
          if (edgeSet.has(`${a}|${b}`) || edgeSet.has(`${b}|${a}`)) intraEdges++;
        }
        return sampled > 0 ? intraEdges / sampled : 0;
      }
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i];
          const b = members[j];
          if (edgeSet.has(`${a}|${b}`) || edgeSet.has(`${b}|${a}`)) intraEdges++;
        }
      }
      const maxEdges = (members.length * (members.length - 1)) / 2;
      return maxEdges > 0 ? intraEdges / maxEdges : 0;
    };

    const insertCommunity = db.prepare(
      'INSERT OR REPLACE INTO graph_communities (id, node_count, cohesion_score, top_entities, label) VALUES (?, ?, ?, ?, ?)',
    );
    const updateNode = db.prepare('UPDATE graph_nodes SET community_id = ? WHERE id = ?');

    let totalCohesion = 0;
    let largestCommunity = 0;

    db.exec('DELETE FROM graph_communities');

    db.transaction(() => {
      sortedGroups.forEach((members, idx) => {
        const communityId = idx + 1;
        const cohesion = cohesionScore(members);
        totalCohesion += cohesion;
        if (members.length > largestCommunity) largestCommunity = members.length;

        const topEntities = db
          .prepare(
            `SELECT label FROM graph_nodes WHERE id IN (${members.map(() => '?').join(',')}) ORDER BY degree DESC LIMIT 5`,
          )
          .all(...members) as { label: string }[];

        const topLabels = topEntities.map((n) => n.label);
        const communityLabel = topLabels.slice(0, 3).join(', ');

        insertCommunity.run(communityId, members.length, cohesion, JSON.stringify(topLabels), communityLabel);

        for (const nodeId of members) {
          updateNode.run(communityId, nodeId);
        }
      });
    })();

    // Post-process: split oversized communities by removing god nodes and re-clustering
    const maxCommunitySize = 200;
    const oversized = db
      .prepare('SELECT id, node_count FROM graph_communities WHERE node_count > ?')
      .all(maxCommunitySize) as { id: number; node_count: number }[];

    for (const { id: commId } of oversized) {
      const members = db
        .prepare('SELECT id, degree FROM graph_nodes WHERE community_id = ?')
        .all(commId) as { id: string; degree: number }[];

      // Remove top 5% by degree (god nodes that bridge everything)
      const sorted = [...members].sort((a, b) => b.degree - a.degree);
      const cutoff = Math.max(1, Math.floor(members.length * 0.05));
      const godNodeIds = new Set(sorted.slice(0, cutoff).map((n) => n.id));
      const regularNodeIds = sorted.slice(cutoff).map((n) => n.id);

      if (regularNodeIds.length < 2) continue;

      // Get edges between regular nodes only
      const ph = regularNodeIds.map(() => '?').join(',');
      const subEdges = db
        .prepare(
          `SELECT source_id, target_id, weight FROM graph_edges
           WHERE source_id IN (${ph}) AND target_id IN (${ph})`,
        )
        .all(...regularNodeIds, ...regularNodeIds) as WeightedEdgeRow[];

      // Re-run label propagation on subgraph
      const { labels: subLabels } = labelPropagation(regularNodeIds, subEdges);

      // Remap to new community IDs starting after current max
      const maxComm = (
        db.prepare('SELECT COALESCE(MAX(id), 0) as m FROM graph_communities').get() as { m: number }
      ).m;
      const labelRemap = new Map<number, number>();
      let nextId = maxComm + 1;
      for (const [, lbl] of subLabels) {
        if (!labelRemap.has(lbl)) labelRemap.set(lbl, nextId++);
      }

      // Only split if we actually got multiple sub-communities
      const newCommunityCount = labelRemap.size;
      if (newCommunityCount <= 1) continue;

      console.log(`  Splitting community ${commId} (${members.length} nodes) into ${newCommunityCount} sub-communities`);

      db.transaction(() => {
        // Assign regular nodes to new communities
        for (const [nodeId, lbl] of subLabels) {
          const newCommId = labelRemap.get(lbl)!;
          updateNode.run(newCommId, nodeId);
        }

        // Assign god nodes to their most popular neighbor's community
        for (const godId of godNodeIds) {
          const neighborComm = db
            .prepare(
              `SELECT gn.community_id, SUM(ge.weight) as w
               FROM graph_edges ge
               JOIN graph_nodes gn ON gn.id = CASE WHEN ge.source_id = ? THEN ge.target_id ELSE ge.source_id END
               WHERE (ge.source_id = ? OR ge.target_id = ?) AND gn.community_id IS NOT NULL
               GROUP BY gn.community_id ORDER BY w DESC LIMIT 1`,
            )
            .get(godId, godId, godId) as { community_id: number } | undefined;
          if (neighborComm) {
            updateNode.run(neighborComm.community_id, godId);
          }
        }

        // Remove the old oversized community entry
        db.prepare('DELETE FROM graph_communities WHERE id = ?').run(commId);

        // Insert new sub-community entries
        for (const [, newCommId] of labelRemap) {
          const newMembers = db
            .prepare('SELECT id FROM graph_nodes WHERE community_id = ?')
            .all(newCommId) as { id: string }[];
          const cohesion = cohesionScore(newMembers.map((n) => n.id));
          const topEnts = db
            .prepare(
              `SELECT label FROM graph_nodes WHERE community_id = ? ORDER BY degree DESC LIMIT 5`,
            )
            .all(newCommId) as { label: string }[];
          const topLabelsNew = topEnts.map((n) => n.label);
          insertCommunity.run(
            newCommId,
            newMembers.length,
            cohesion,
            JSON.stringify(topLabelsNew),
            topLabelsNew.slice(0, 3).join(', '),
          );
        }
      })();
    }

    // Recount after splitting
    const finalCount = (
      db.prepare('SELECT COUNT(*) as c FROM graph_communities').get() as { c: number }
    ).c;
    const finalLargest = (
      db.prepare('SELECT MAX(node_count) as m FROM graph_communities').get() as { m: number }
    ).m;

    return { communityCount: finalCount, largestCommunity: finalLargest, avgCohesion: totalCohesion / Math.max(1, finalCount), iterations, method: 'label-propagation' };
  } finally {
    db.close();
  }
}
