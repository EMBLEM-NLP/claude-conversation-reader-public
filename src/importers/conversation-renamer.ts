/**
 * @file conversation-renamer.ts
 * @description Auto-generate titles for untitled conversations from assistant answers, entities, or human messages
 * @version 1.0.0
 * @created 2026-04-17T21:37:44Z
 * @lastUpdated 2026-04-17T21:37:44Z
 */
import Database from 'better-sqlite3';

// ── Types ──

export interface RenameResult {
  total: number;
  renamed: number;
  skipped: number;
  titles: { uuid: string; title: string; source: 'assistant' | 'entities' | 'human' }[];
}

interface TitleCandidate {
  title: string;
  source: 'assistant' | 'entities' | 'human';
}

// ── Boilerplate patterns to skip in assistant messages ──

const BOILERPLATE_RE =
  /^(I'll|I can|I will|I would|I'd be|Sure|Of course|Let me|Here'?s?|Certainly|Absolutely|Great|OK|Okay|Yes|No problem|Happy to|Glad to|Thank you|Thanks|The user (is|has|wants|said|asked|sent|provided|uploaded|shared)|The human (is|has|wants|said)|They'?re (asking|looking|want)|This (is a|is small|appears|seems|looks|code)|First,? let'?s?|Now,? let'?s?|I need to (carefully|politely|analyze|search)|I found several|I should|However,? I|Looking at (the|this)|Based on (the|my)|From (your|the|my)|Let's (go|take|navigate|create)|Tool"|Txt and paste)/i;

// ── extractTitle: text → clean title string ──

export function extractTitle(text: string, opts?: { skipBoilerplate?: boolean }): string | null {
  const skipBoilerplate = opts?.skipBoilerplate ?? false;

  let cleaned = text;

  // 1. Remove fenced code blocks
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');

  // 2. Remove inline code
  cleaned = cleaned.replace(/`[^`]+`/g, ' ');

  // 3. Remove markdown links — keep link text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 4. Remove headers
  cleaned = cleaned.replace(/^#+\s*/gm, '');

  // 5. Remove bold/italic markers
  cleaned = cleaned.replace(/[*_]{1,3}/g, '');

  // 6. Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // 7. Remove bullet/list markers
  cleaned = cleaned.replace(/^[\s]*[-*•]\s+/gm, '');
  cleaned = cleaned.replace(/^\s*\d+[.)]\s+/gm, '');

  // 8. Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned) return null;

  // 9. Split into sentences
  const sentences = cleaned
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) return null;

  // 10. Find first qualifying sentence
  let chosen: string | null = null;
  for (const sentence of sentences) {
    if (skipBoilerplate && BOILERPLATE_RE.test(sentence)) continue;
    if (sentence.length < 5) continue;
    chosen = sentence;
    break;
  }

  // If all were boilerplate, fall back to longest sentence
  if (!chosen && sentences.length > 0) {
    chosen = sentences.reduce((a, b) => (a.length >= b.length ? a : b));
  }

  if (!chosen || chosen.length < 5) return null;

  // 11. Truncate to 80 chars at word boundary
  if (chosen.length > 80) {
    const truncated = chosen.slice(0, 80);
    const lastSpace = truncated.lastIndexOf(' ');
    chosen = (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated) + '\u2026';
  }

  // 12. Capitalize first letter
  chosen = chosen.charAt(0).toUpperCase() + chosen.slice(1);

  return chosen;
}

// ── generateTitle: multi-signal title generation for a conversation ──

export function generateTitle(
  db: Database.Database,
  convUuid: string,
): TitleCandidate | null {
  // Strategy 1: First assistant message
  const assistantRow = db
    .prepare(
      `SELECT m.text FROM messages m
       WHERE m.conversation_uuid = ? AND m.sender = 'assistant'
       ORDER BY m.created_at ASC LIMIT 1`,
    )
    .get(convUuid) as { text: string | null } | undefined;

  if (assistantRow?.text) {
    const title = extractTitle(assistantRow.text, { skipBoilerplate: true });
    if (title && title.length >= 10) {
      return { title, source: 'assistant' };
    }
  }

  // Strategy 2: Topic entities
  const entityRows = db
    .prepare(
      `SELECT e.entity, COUNT(*) as freq FROM entities e
       WHERE e.conversation_uuid = ? AND e.type = 'topic'
       GROUP BY e.entity ORDER BY freq DESC LIMIT 3`,
    )
    .all(convUuid) as { entity: string; freq: number }[];

  if (entityRows.length > 0) {
    const title = entityRows
      .map((r) => titleCase(r.entity))
      .join(', ');
    if (title.length >= 3) {
      return { title, source: 'entities' };
    }
  }

  // Strategy 3: First human message
  const humanRow = db
    .prepare(
      `SELECT m.text FROM messages m
       WHERE m.conversation_uuid = ? AND m.sender = 'human'
       ORDER BY m.created_at ASC LIMIT 1`,
    )
    .get(convUuid) as { text: string | null } | undefined;

  if (humanRow?.text) {
    const title = extractTitle(humanRow.text, { skipBoilerplate: false });
    if (title && title.length >= 5) {
      return { title, source: 'human' };
    }
  }

  return null;
}

// ── renameUntitled: batch rename all untitled conversations ──

export function renameUntitled(
  dbPath: string,
  opts?: { dryRun?: boolean; limit?: number },
): RenameResult {
  const dryRun = opts?.dryRun ?? false;
  const limit = opts?.limit ?? 0;

  const db = new Database(dbPath);
  try {
    // Get untitled conversations
    const untitled = db
      .prepare(
        `SELECT c.uuid FROM conversations c
         WHERE c.name IS NULL OR c.name = ''
         ORDER BY c.updated_at DESC
         ${limit > 0 ? 'LIMIT ?' : ''}`,
      )
      .all(...(limit > 0 ? [limit] : [])) as { uuid: string }[];

    const result: RenameResult = {
      total: untitled.length,
      renamed: 0,
      skipped: 0,
      titles: [],
    };

    if (untitled.length === 0) return result;

    const updateStmt = dryRun
      ? null
      : db.prepare('UPDATE conversations SET name = ? WHERE uuid = ?');

    const doRename = db.transaction(() => {
      for (const { uuid } of untitled) {
        const candidate = generateTitle(db, uuid);
        if (candidate) {
          result.titles.push({ uuid, title: candidate.title, source: candidate.source });
          result.renamed++;
          if (updateStmt) {
            updateStmt.run(candidate.title, uuid);
          }
        } else {
          result.skipped++;
        }
      }
    });

    doRename();
    return result;
  } finally {
    db.close();
  }
}

// ── Helpers ──

function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
