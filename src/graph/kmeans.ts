/**
 * @file kmeans.ts
 * @description K-means++ clustering with 7D feature vectors and silhouette auto-k
 * @version 1.0.0
 * @created 2026-04-14T00:00:00Z
 * @lastUpdated 2026-04-15T17:15:45Z
 */
import Database from 'better-sqlite3';

export interface KmeansResult {
  communityCount: number;
  largestCommunity: number;
  avgSilhouette: number;
  k: number;
  iterations: number;
}

interface FeatureNode {
  id: string;
  features: number[];
}

interface NodeFeatureRow {
  id: string;
  degree: number;
  entity_type: string | null;
  node_type: string;
  first_seen: string | null;
  conv_reach: number;
  tool_assoc: number;
}

function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * K-means++ initialization: pick first centroid randomly, then each subsequent
 * centroid with probability proportional to squared distance from nearest existing centroid.
 */
function kmeansppInit(nodes: FeatureNode[], k: number): number[][] {
  const centroids: number[][] = [];
  // Pick first centroid randomly
  centroids.push([...nodes[Math.floor(Math.random() * nodes.length)].features]);

  for (let c = 1; c < k; c++) {
    // Compute squared distance to nearest centroid for each node
    const dists = nodes.map((n) => {
      let minDist = Infinity;
      for (const cent of centroids) {
        const d = euclidean(n.features, cent);
        if (d < minDist) minDist = d;
      }
      return minDist * minDist;
    });

    // Weighted random selection
    const totalDist = dists.reduce((a, b) => a + b, 0);
    if (totalDist === 0) {
      centroids.push([...nodes[Math.floor(Math.random() * nodes.length)].features]);
      continue;
    }
    let r = Math.random() * totalDist;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        centroids.push([...nodes[i].features]);
        break;
      }
    }
    // Fallback if floating point issues
    if (centroids.length < c + 1) {
      centroids.push([...nodes[nodes.length - 1].features]);
    }
  }

  return centroids;
}

/**
 * Standard Lloyd's k-means with k-means++ initialization.
 */
function kmeans(
  nodes: FeatureNode[],
  k: number,
  maxIter = 100,
): { assignments: number[]; centroids: number[][]; iterations: number } {
  const n = nodes.length;
  if (n === 0 || k <= 0) return { assignments: [], centroids: [], iterations: 0 };
  const actualK = Math.min(k, n);

  let centroids = kmeansppInit(nodes, actualK);
  const assignments = new Array<number>(n).fill(0);
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    let changed = 0;

    // Assign each node to nearest centroid
    for (let i = 0; i < n; i++) {
      let bestCluster = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = euclidean(nodes[i].features, centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          bestCluster = c;
        }
      }
      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed++;
      }
    }

    if (changed === 0) break;

    // Recompute centroids
    const dim = nodes[0].features.length;
    const sums = Array.from({ length: centroids.length }, () => new Array(dim).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) {
        sums[c][d] += nodes[i].features[d];
      }
    }
    centroids = sums.map((s, c) =>
      counts[c] > 0 ? s.map((v) => v / counts[c]) : centroids[c],
    );
  }

  return { assignments, centroids, iterations };
}

/**
 * Compute average silhouette score for a clustering.
 * For large datasets, samples a subset for performance.
 */
function silhouetteScore(nodes: FeatureNode[], assignments: number[], k: number): number {
  const n = nodes.length;
  if (n < 2 || k < 2) return 0;

  // Sample for performance
  const sampleSize = Math.min(n, 500);
  const indices = Array.from({ length: n }, (_, i) => i);
  // Fisher-Yates partial shuffle
  for (let i = 0; i < sampleSize; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const sample = indices.slice(0, sampleSize);

  // Group by cluster
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = assignments[i];
    const list = clusters.get(c) ?? [];
    list.push(i);
    clusters.set(c, list);
  }

  let totalSilhouette = 0;
  for (const idx of sample) {
    const myCluster = assignments[idx];
    const myMembers = clusters.get(myCluster) ?? [];

    // a(i) = average distance to own cluster
    let a = 0;
    if (myMembers.length > 1) {
      for (const j of myMembers) {
        if (j !== idx) a += euclidean(nodes[idx].features, nodes[j].features);
      }
      a /= myMembers.length - 1;
    }

    // b(i) = min average distance to any other cluster
    let b = Infinity;
    for (const [cid, members] of clusters) {
      if (cid === myCluster || members.length === 0) continue;
      let avg = 0;
      for (const j of members) {
        avg += euclidean(nodes[idx].features, nodes[j].features);
      }
      avg /= members.length;
      if (avg < b) b = avg;
    }

    if (b === Infinity) b = 0;
    const s = a === 0 && b === 0 ? 0 : (b - a) / Math.max(a, b);
    totalSilhouette += s;
  }

  return totalSilhouette / sampleSize;
}

/**
 * Build a 7D feature vector for each entity node:
 * [degree_norm, is_topic, is_url, is_uuid, tool_assoc_norm, temporal_norm, conv_reach_norm]
 */
function buildFeatureVectors(db: Database.Database): FeatureNode[] {
  // Get entity nodes with features
  const rows = db.prepare(`
    SELECT gn.id, gn.degree, gn.entity_type, gn.node_type, gn.first_seen,
           (SELECT COUNT(DISTINCT ge.conversation_uuid) FROM graph_edges ge
            WHERE ge.source_id = gn.id AND ge.relation = 'mentioned_in') as conv_reach,
           (SELECT COUNT(*) FROM graph_edges ge
            JOIN graph_nodes tn ON tn.id = ge.target_id AND tn.node_type = 'tool'
            JOIN graph_edges ge2 ON ge2.target_id = tn.id AND ge2.relation = 'uses_tool'
            WHERE ge.source_id = gn.id AND ge.relation = 'co_occurs') as tool_assoc
    FROM graph_nodes gn
    WHERE gn.node_type = 'entity'
  `).all() as NodeFeatureRow[];

  if (rows.length === 0) return [];

  // Compute normalization ranges
  const maxDegree = Math.max(...rows.map((r) => r.degree), 1);
  const maxConvReach = Math.max(...rows.map((r) => r.conv_reach), 1);
  const maxToolAssoc = Math.max(...rows.map((r) => r.tool_assoc), 1);

  const timestamps = rows
    .map((r) => r.first_seen)
    .filter((t): t is string => t != null)
    .map((t) => new Date(t).getTime());
  const minTs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxTs = timestamps.length > 0 ? Math.max(...timestamps) : 1;
  const tsRange = maxTs - minTs || 1;

  return rows.map((r) => ({
    id: r.id,
    features: [
      r.degree / maxDegree,
      r.entity_type === 'topic' ? 1 : 0,
      r.entity_type === 'url' ? 1 : 0,
      r.entity_type === 'uuid' ? 1 : 0,
      r.tool_assoc / maxToolAssoc,
      r.first_seen ? (new Date(r.first_seen).getTime() - minTs) / tsRange : 0.5,
      r.conv_reach / maxConvReach,
    ],
  }));
}

export function kmeansClusterGraph(dbPath: string, userK?: number): KmeansResult {
  const db = new Database(dbPath);
  try {
    const featureNodes = buildFeatureVectors(db);
    if (featureNodes.length === 0) {
      return { communityCount: 0, largestCommunity: 0, avgSilhouette: 0, k: 0, iterations: 0 };
    }

    let bestK = userK ?? 0;
    let bestAssignments: number[] = [];
    let bestSilhouette = -1;
    let bestIterations = 0;

    if (userK) {
      // User specified k
      const result = kmeans(featureNodes, userK);
      bestAssignments = result.assignments;
      bestSilhouette = silhouetteScore(featureNodes, result.assignments, userK);
      bestIterations = result.iterations;
    } else {
      // Auto-select k using silhouette score
      const maxK = Math.min(20, Math.floor(Math.sqrt(featureNodes.length)));
      for (let k = 2; k <= maxK; k++) {
        const result = kmeans(featureNodes, k);
        const score = silhouetteScore(featureNodes, result.assignments, k);
        if (score > bestSilhouette) {
          bestSilhouette = score;
          bestK = k;
          bestAssignments = result.assignments;
          bestIterations = result.iterations;
        }
      }
    }

    // Write results to DB in same format as label propagation
    // Group by cluster
    const groups = new Map<number, string[]>();
    for (let i = 0; i < featureNodes.length; i++) {
      const c = bestAssignments[i];
      const list = groups.get(c) ?? [];
      list.push(featureNodes[i].id);
      groups.set(c, list);
    }

    const sortedGroups = [...groups.values()].sort((a, b) => b.length - a.length);

    const insertCommunity = db.prepare(
      'INSERT OR REPLACE INTO graph_communities (id, node_count, cohesion_score, top_entities, label) VALUES (?, ?, ?, ?, ?)',
    );
    const updateNode = db.prepare('UPDATE graph_nodes SET community_id = ? WHERE id = ?');

    let largestCommunity = 0;
    db.exec('DELETE FROM graph_communities');

    db.transaction(() => {
      sortedGroups.forEach((members, idx) => {
        const communityId = idx + 1;
        if (members.length > largestCommunity) largestCommunity = members.length;

        const topEntities = db
          .prepare(
            `SELECT label FROM graph_nodes WHERE id IN (${members.map(() => '?').join(',')}) ORDER BY degree DESC LIMIT 5`,
          )
          .all(...members) as { label: string }[];

        const topLabels = topEntities.map((n) => n.label);
        const communityLabel = topLabels.slice(0, 3).join(', ');

        insertCommunity.run(communityId, members.length, bestSilhouette, JSON.stringify(topLabels), communityLabel);

        for (const nodeId of members) {
          updateNode.run(communityId, nodeId);
        }
      });
    })();

    return {
      communityCount: sortedGroups.length,
      largestCommunity,
      avgSilhouette: bestSilhouette,
      k: bestK,
      iterations: bestIterations,
    };
  } finally {
    db.close();
  }
}
