/**
 * @file embeddings.ts
 * @description Gemini embedding provider with SQLite caching and batch support
 * @version 1.0.0
 * @created 2026-04-17T01:23:36Z
 * @lastUpdated 2026-04-17T01:23:36Z
 */
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import type Database from 'better-sqlite3';

// ── Types ──

export interface EmbeddingResult {
  uuid: string;
  embedding: number[]; // 768d by default
}

export interface EmbedOptions {
  batchSize?: number; // texts per API call (max 100)
  dimensionality?: number; // output dimensions (default 768)
  delayMs?: number; // inter-batch delay
}

const DEFAULT_MODEL = 'gemini-embedding-001';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_DIMENSIONALITY = 768;

// ── Schema ──

export function createEmbeddingsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_embeddings (
      uuid TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL DEFAULT '${DEFAULT_MODEL}',
      created_at TEXT NOT NULL
    )
  `);
}

// ── Cache ──

export function getCachedEmbeddings(
  db: Database.Database,
  uuids: string[],
): Map<string, number[]> {
  const cache = new Map<string, number[]>();
  if (uuids.length === 0) return cache;

  const stmt = db.prepare(
    'SELECT uuid, embedding FROM conversation_embeddings WHERE uuid = ?',
  );

  for (const uuid of uuids) {
    const row = stmt.get(uuid) as { uuid: string; embedding: Buffer } | undefined;
    if (row) {
      cache.set(row.uuid, Array.from(new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8)));
    }
  }

  return cache;
}

export function cacheEmbeddings(
  db: Database.Database,
  results: EmbeddingResult[],
): void {
  if (results.length === 0) return;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO conversation_embeddings (uuid, embedding, model, created_at)
    VALUES (?, ?, ?, ?)
  `);

  const now = new Date().toISOString();

  db.transaction(() => {
    for (const { uuid, embedding } of results) {
      const buf = Buffer.from(new Float64Array(embedding).buffer);
      insert.run(uuid, buf, DEFAULT_MODEL, now);
    }
  })();
}

// ── API ──

async function batchEmbed(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  texts: string[],
  maxRetries = 3,
): Promise<number[][]> {
  const requests = texts.map((text) => ({
    content: { role: 'user' as const, parts: [{ text }] },
    taskType: TaskType.CLUSTERING,
  }));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await model.batchEmbedContents({ requests });
      return response.embeddings.map((e) => e.values);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('429') && attempt < maxRetries) {
        // Extract retry delay from error or use exponential backoff
        const match = msg.match(/retry in ([\d.]+)s/i);
        const waitSec = match ? parseFloat(match[1]) + 1 : Math.pow(2, attempt + 1) * 15;
        console.log(`  Rate limited, waiting ${waitSec.toFixed(0)}s before retry ${attempt + 1}/${maxRetries}...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded for embedding batch');
}

/**
 * Embed conversation texts via Gemini API with caching.
 * Checks SQLite cache first, only calls API for uncached conversations.
 */
export async function embedConversations(
  db: Database.Database,
  texts: { uuid: string; text: string }[],
  apiKey: string,
  opts?: EmbedOptions,
): Promise<EmbeddingResult[]> {
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
  const delayMs = opts?.delayMs ?? DEFAULT_DELAY_MS;
  const dimensionality = opts?.dimensionality ?? DEFAULT_DIMENSIONALITY;

  // Ensure table exists
  createEmbeddingsTable(db);

  // Check cache
  const uuids = texts.map((t) => t.uuid);
  const cached = getCachedEmbeddings(db, uuids);
  const uncached = texts.filter((t) => !cached.has(t.uuid));

  console.log(`  Embeddings: ${cached.size} cached, ${uncached.length} to embed`);

  if (uncached.length === 0) {
    return texts.map((t) => ({ uuid: t.uuid, embedding: cached.get(t.uuid)! }));
  }

  // Initialize Gemini
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel(
    { model: DEFAULT_MODEL },
    { apiVersion: 'v1beta' },
  );

  // Override output dimensionality if supported via model params
  void dimensionality; // reserved for future dimensionality override

  // Batch API calls
  const newResults: EmbeddingResult[] = [];
  const totalBatches = Math.ceil(uncached.length / batchSize);

  for (let i = 0; i < uncached.length; i += batchSize) {
    const batch = uncached.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    console.log(`  Batch ${batchNum}/${totalBatches} (${batch.length} texts)...`);

    const batchTexts = batch.map((t) => t.text);
    const embeddings = await batchEmbed(model, batchTexts);

    const batchResults: EmbeddingResult[] = [];
    for (let j = 0; j < batch.length; j++) {
      batchResults.push({ uuid: batch[j].uuid, embedding: embeddings[j] });
    }

    // Cache each batch immediately so progress isn't lost on later failures
    cacheEmbeddings(db, batchResults);
    newResults.push(...batchResults);

    // Rate limit delay between batches
    if (i + batchSize < uncached.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log(`  Embedded and cached ${newResults.length} conversations`);

  // Merge cached + new
  for (const r of newResults) {
    cached.set(r.uuid, r.embedding);
  }

  return texts.map((t) => ({ uuid: t.uuid, embedding: cached.get(t.uuid)! }));
}
