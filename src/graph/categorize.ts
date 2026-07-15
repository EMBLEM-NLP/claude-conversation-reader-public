/**
 * @file categorize.ts
 * @description Conversation categorization via LLM embeddings (Gemini) or TF-IDF fallback
 * @version 2.0.0
 * @created 2026-04-16T00:00:00Z
 * @lastUpdated 2026-04-17T01:23:36Z
 */
import Database from 'better-sqlite3';
import { embedConversations, createEmbeddingsTable } from './embeddings.js';

// ── Types ──

export interface CategorizeResult {
  totalCategorized: number;
  k: number;
  method: 'embeddings' | 'tfidf';
  categories: { label: string; count: number; topTerms: string[] }[];
}

interface ConvRow {
  uuid: string;
  title: string | null;
  first_msg: string | null;
  topics: string | null;
  tools: string | null;
  msg_count: number;
}

// ── Stopwords (compact set for English) ──

const STOPWORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his',
  'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my',
  'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if',
  'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like',
  'time', 'no', 'just', 'him', 'know', 'take', 'people', 'into', 'year', 'your',
  'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'look',
  'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two',
  'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because',
  'any', 'these', 'give', 'day', 'most', 'us', 'is', 'are', 'was', 'were', 'been',
  'has', 'had', 'did', 'does', 'doing', 'am', 'being', 'should', 'shall', 'may',
  'might', 'must', 'need', 'here', 'very', 'much', 'more', 'too', 'still', 'own',
  'such', 'each', 'tell', 'set', 'put', 'made', 'said', 'let', 'using', 'please',
  'help', 'file', 'want', 'need', 'create', 'add', 'make', 'sure', 'right',
]);

// ── Tool category mapping ──

const TOOL_CATEGORIES: Record<string, string[]> = {
  search: ['web_search', 'brave_web_search', 'web_fetch', 'launch_extended_search_task', 'launch_extended_search'],
  code: ['execute_command', 'write_file', 'read_file', 'bash_tool', 'list_directory', 'view', 'repl', 'bash'],
  artifacts: ['artifacts'],
  crypto: ['get_crypto_quote', 'convert_crypto', 'check_api_usage'],
  reasoning: ['sequentialthinking'],
  memory: ['create_entities', 'create_relations', 'add_observations', 'read_graph', 'search_nodes'],
  filesystem: ['get_file_contents', 'navigate_to_url'],
};

// ── Tokenization ──

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// ── Tool metadata features (shared by both methods) ──

function buildToolMetadata(conv: ConvRow): number[] {
  const toolCatNames = Object.keys(TOOL_CATEGORIES);
  const convTools = (conv.tools ?? '').toLowerCase().split(',').filter(Boolean);

  const toolFlags = toolCatNames.map((cat) => {
    const catTools = TOOL_CATEGORIES[cat];
    return convTools.some((t) => catTools.some((ct) => t.includes(ct))) ? 1 : 0;
  });

  const msgBucket =
    conv.msg_count <= 2 ? 0 :
    conv.msg_count <= 5 ? 0.2 :
    conv.msg_count <= 10 ? 0.4 :
    conv.msg_count <= 20 ? 0.6 :
    conv.msg_count <= 50 ? 0.8 : 1.0;

  const hasTool = convTools.length > 0 ? 1 : 0;
  const toolDiversity = Math.min(1, convTools.length / 10);

  return [...toolFlags, msgBucket, hasTool, toolDiversity];
}

// ── TF-IDF (fallback) ──

interface TfidfVector {
  terms: Map<string, number>;
}

function buildTfidf(docs: string[][]): { vectors: TfidfVector[]; vocabulary: string[] } {
  const N = docs.length;
  const df = new Map<string, number>();
  for (const doc of docs) {
    const unique = new Set(doc);
    for (const term of unique) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const minDf = 2;
  const maxDf = Math.floor(N * 0.8);
  const vocabulary = [...df.entries()]
    .filter(([, count]) => count >= minDf && count <= maxDf)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 500)
    .map(([term]) => term);

  const vocabSet = new Set(vocabulary);

  const vectors: TfidfVector[] = docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const term of doc) {
      if (vocabSet.has(term)) {
        tf.set(term, (tf.get(term) ?? 0) + 1);
      }
    }

    const terms = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of tf) {
      const idf = Math.log(N / (df.get(term) ?? 1));
      const tfidf = count * idf;
      terms.set(term, tfidf);
      norm += tfidf * tfidf;
    }

    norm = Math.sqrt(norm) || 1;
    for (const [term, val] of terms) {
      terms.set(term, val / norm);
    }

    return { terms };
  });

  return { vectors, vocabulary };
}

function buildTfidfFeatureVectors(
  convs: ConvRow[],
  tfidfVectors: TfidfVector[],
  vocabulary: string[],
): number[][] {
  return convs.map((conv, i) => {
    const tfidf = tfidfVectors[i];
    const tfidfFeatures = vocabulary.map((term) => tfidf.terms.get(term) ?? 0);
    const metadata = buildToolMetadata(conv);
    return [...tfidfFeatures, ...metadata];
  });
}

// ── K-Means ──

function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function kmeansppInit(vecs: number[][], k: number): number[][] {
  const centroids: number[][] = [];
  centroids.push([...vecs[Math.floor(Math.random() * vecs.length)]]);

  for (let c = 1; c < k; c++) {
    const dists = vecs.map((v) => {
      let minDist = Infinity;
      for (const cent of centroids) {
        const d = euclidean(v, cent);
        if (d < minDist) minDist = d;
      }
      return minDist * minDist;
    });

    const totalDist = dists.reduce((a, b) => a + b, 0);
    if (totalDist === 0) {
      centroids.push([...vecs[Math.floor(Math.random() * vecs.length)]]);
      continue;
    }
    let r = Math.random() * totalDist;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        centroids.push([...vecs[i]]);
        break;
      }
    }
    if (centroids.length < c + 1) centroids.push([...vecs[vecs.length - 1]]);
  }

  return centroids;
}

function runKmeans(
  vecs: number[][],
  k: number,
  maxIter = 100,
): { assignments: number[]; centroids: number[][] } {
  const n = vecs.length;
  const actualK = Math.min(k, n);
  let centroids = kmeansppInit(vecs, actualK);
  const assignments = new Array<number>(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = euclidean(vecs[i], centroids[c]);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed++; }
    }
    if (changed === 0) break;

    const dim = vecs[0].length;
    const sums = Array.from({ length: centroids.length }, () => new Array(dim).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) sums[c][d] += vecs[i][d];
    }
    centroids = sums.map((s, c) =>
      counts[c] > 0 ? s.map((v) => v / counts[c]) : centroids[c],
    );
  }

  return { assignments, centroids };
}

function silhouette(vecs: number[][], assignments: number[], k: number): number {
  const n = vecs.length;
  if (n < 2 || k < 2) return 0;

  const sampleSize = Math.min(n, 300);
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < sampleSize; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const list = clusters.get(assignments[i]) ?? [];
    list.push(i);
    clusters.set(assignments[i], list);
  }

  let total = 0;
  for (let s = 0; s < sampleSize; s++) {
    const idx = indices[s];
    const myCluster = assignments[idx];
    const myMembers = clusters.get(myCluster) ?? [];

    let a = 0;
    if (myMembers.length > 1) {
      for (const j of myMembers) if (j !== idx) a += euclidean(vecs[idx], vecs[j]);
      a /= myMembers.length - 1;
    }

    let b = Infinity;
    for (const [cid, members] of clusters) {
      if (cid === myCluster || members.length === 0) continue;
      let avg = 0;
      for (const j of members) avg += euclidean(vecs[idx], vecs[j]);
      avg /= members.length;
      if (avg < b) b = avg;
    }

    if (b === Infinity) b = 0;
    total += a === 0 && b === 0 ? 0 : (b - a) / Math.max(a, b);
  }

  return total / sampleSize;
}

// ── Auto-label clusters ──

function labelClusterFromTitles(
  memberConvs: ConvRow[],
): { label: string; topTerms: string[] } {
  // Extract keywords from titles (works for both embedding and TF-IDF modes)
  const termCounts = new Map<string, number>();
  for (const conv of memberConvs) {
    const words = tokenize(conv.title ?? '');
    for (const w of words) {
      termCounts.set(w, (termCounts.get(w) ?? 0) + 1);
    }
  }

  const topTerms = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term);

  // Check dominant tool category
  const toolCounts = new Map<string, number>();
  for (const conv of memberConvs) {
    const tools = (conv.tools ?? '').toLowerCase().split(',').filter(Boolean);
    for (const [cat, catTools] of Object.entries(TOOL_CATEGORIES)) {
      if (tools.some((t) => catTools.some((ct) => t.includes(ct)))) {
        toolCounts.set(cat, (toolCounts.get(cat) ?? 0) + 1);
      }
    }
  }

  const dominantTool = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])[0];

  const termLabel = topTerms.slice(0, 3).join(', ');
  if (dominantTool && dominantTool[1] > memberConvs.length * 0.4) {
    return { label: `${dominantTool[0]}: ${termLabel}`, topTerms };
  }
  return { label: termLabel || 'uncategorized', topTerms };
}

// ── Build embedding feature vectors ──

function buildEmbeddingFeatureVectors(
  convs: ConvRow[],
  embeddings: number[][],
): number[][] {
  return convs.map((conv, i) => {
    const metadata = buildToolMetadata(conv);
    // Scale metadata to match embedding magnitude (~0.03 per dim for L2-normed 768d)
    // Tool flags are 0/1, metadata is 0-1 — scale by 0.1 to not overpower embeddings
    const scaledMeta = metadata.map((v) => v * 0.1);
    return [...embeddings[i], ...scaledMeta];
  });
}

// ── Conversation text for embedding ──

function buildConvText(conv: ConvRow): string {
  const parts = [
    conv.title ?? '',
    conv.first_msg ?? '',
    conv.topics ?? '',
  ].filter(Boolean);
  const text = parts.join(' | ');
  return text.substring(0, 2000);
}

// ── Main categorization function ──

export async function categorizeConversations(
  dbPath: string,
  userK?: number,
): Promise<CategorizeResult> {
  const db = new Database(dbPath);
  try {
    // Load conversation data
    const convs = db.prepare(`
      SELECT
        c.uuid,
        c.name as title,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_uuid = c.uuid) as msg_count,
        (SELECT SUBSTR(m.text, 1, 1000) FROM messages m
         WHERE m.conversation_uuid = c.uuid AND m.sender = 'human' AND m.text IS NOT NULL
         LIMIT 1) as first_msg,
        (SELECT GROUP_CONCAT(DISTINCT e.entity) FROM entities e
         WHERE e.conversation_uuid = c.uuid AND e.type = 'topic') as topics,
        (SELECT GROUP_CONCAT(DISTINCT e.entity) FROM entities e
         WHERE e.conversation_uuid = c.uuid AND e.type = 'tool') as tools
      FROM conversations c
    `).all() as ConvRow[];

    console.log(`  Loading ${convs.length} conversations...`);

    // Determine method: embeddings if API key available, else TF-IDF
    const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
    const useEmbeddings = apiKey.length > 0;
    let featureVecs: number[][];
    let method: 'embeddings' | 'tfidf';

    if (useEmbeddings) {
      console.log('  Method: Gemini gemini-embedding-001');
      method = 'embeddings';

      // Ensure embeddings table exists
      createEmbeddingsTable(db);

      // Build text for each conversation
      const texts = convs.map((c) => ({ uuid: c.uuid, text: buildConvText(c) }));

      // Get embeddings (with caching)
      const results = await embedConversations(db, texts, apiKey);
      const embeddingVecs = results.map((r) => r.embedding);

      // Build feature vectors: embedding + metadata
      featureVecs = buildEmbeddingFeatureVectors(convs, embeddingVecs);
      const dim = featureVecs[0]?.length ?? 0;
      console.log(`  Feature vectors: ${featureVecs.length} x ${dim}`);
    } else {
      console.log('  Method: TF-IDF (no GOOGLE_API_KEY set, using fallback)');
      method = 'tfidf';

      const docs = convs.map((c) => {
        const text = [c.title ?? '', c.first_msg ?? '', c.topics ?? ''].join(' ');
        return tokenize(text);
      });

      const { vectors: tfidfVectors, vocabulary } = buildTfidf(docs);
      console.log(`  TF-IDF vocabulary: ${vocabulary.length} terms`);

      featureVecs = buildTfidfFeatureVectors(convs, tfidfVectors, vocabulary);
      const dim = featureVecs[0]?.length ?? 0;
      console.log(`  Feature vectors: ${featureVecs.length} x ${dim}`);
    }

    // Auto-select k or use provided
    let bestK = userK ?? 0;
    let bestAssignments: number[] = [];
    let bestSil = -1;

    if (userK) {
      const result = runKmeans(featureVecs, userK);
      bestAssignments = result.assignments;
      bestSil = silhouette(featureVecs, result.assignments, userK);
      bestK = userK;
    } else {
      for (let k = 5; k <= 15; k++) {
        const result = runKmeans(featureVecs, k);
        const sil = silhouette(featureVecs, result.assignments, k);
        if (sil > bestSil) {
          bestSil = sil;
          bestK = k;
          bestAssignments = result.assignments;
        }
      }
    }

    console.log(`  Best k=${bestK}, silhouette=${bestSil.toFixed(3)}`);

    // Group conversations by cluster
    const groups = new Map<number, number[]>();
    for (let i = 0; i < convs.length; i++) {
      const c = bestAssignments[i];
      const list = groups.get(c) ?? [];
      list.push(i);
      groups.set(c, list);
    }

    // Label each cluster and write to DB
    const categories: { label: string; count: number; topTerms: string[] }[] = [];
    const updateCategory = db.prepare(
      "UPDATE graph_nodes SET category = ? WHERE id = ? AND node_type = 'conversation'",
    );

    db.transaction(() => {
      for (const [, memberIndices] of groups) {
        const memberConvs = memberIndices.map((i) => convs[i]);
        const { label, topTerms } = labelClusterFromTitles(memberConvs);

        categories.push({ label, count: memberIndices.length, topTerms });

        for (const idx of memberIndices) {
          updateCategory.run(label, `conv:${convs[idx].uuid}`);
        }
      }
    })();

    categories.sort((a, b) => b.count - a.count);
    console.log(`  Categories:`);
    for (const cat of categories) {
      console.log(`    ${cat.label} (${cat.count} convs) — top: ${cat.topTerms.join(', ')}`);
    }

    return { totalCategorized: convs.length, k: bestK, method, categories };
  } finally {
    db.close();
  }
}
