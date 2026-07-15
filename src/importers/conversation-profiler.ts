/**
 * @file conversation-profiler.ts
 * @description Semantic profiler: 20 regex categories + structural metrics + per-sender profiling
 * @version 2.1.0
 * @created 2026-04-17T03:34:43Z
 * @lastUpdated 2026-05-28T22:30:00Z
 */
import Database from 'better-sqlite3';

// ── Types ──

export interface ProfileCategory {
  key: string;
  label: string;
  regex: RegExp;
}

export interface ConversationProfile {
  conversation_uuid: string;
  // 14 adapted regex categories
  file_paths: number;
  cli_commands: number;
  code_keywords: number;
  code_identifiers: number;
  urls: number;
  port_numbers: number;
  api_endpoints: number;
  sql_statements: number;
  env_vars: number;
  version_numbers: number;
  doc_references: number;
  definitions: number;
  best_practices: number;
  warnings: number;
  // 6 Claude-specific regex categories
  prompt_patterns: number;
  error_patterns: number;
  package_names: number;
  git_operations: number;
  docker_ops: number;
  question_patterns: number;
  // Structural metrics
  tool_invocations: number;
  tool_errors: number;
  thinking_blocks: number;
  code_blocks: number;
  code_block_langs: string; // JSON array
  branch_points: number;
  attachment_count: number;
  message_count: number;
  human_messages: number;
  assistant_messages: number;
  total_words: number;
  avg_message_length: number;
  duration_minutes: number;
  // Per-sender profiles (JSON)
  human_profile: string; // JSON Record<string, number>
  assistant_profile: string; // JSON Record<string, number>
  // Category details (top 5 unique matches per category)
  category_details: string; // JSON Record<string, string[]>
  // Computed summary
  primary_type: string;
  technical_density: number;
  // Extra
  conversation_name?: string;
}

export interface ProfileResult {
  totalProfiled: number;
  avgDensity: number;
  typeDistribution: Record<string, number>;
}

export interface ProfileOptions {
  conversationUuids?: string[];
  verbose?: boolean;
  /**
   * If true: wipe all existing profile rows and re-profile every conversation.
   * If false (default): incremental — only profile conversations that don't
   * already have a profile row. Cuts re-run time on a 600-conv DB from
   * ~10 minutes to ~instant.
   */
  rebuild?: boolean;
  /**
   * Wall-clock per-conversation threshold (ms) above which we log a warning
   * with the UUID. Used to surface conversations whose text triggers
   * catastrophic regex backtracking. Default 5000ms.
   */
  slowThresholdMs?: number;
}

export interface ProfileQueryOptions {
  primaryType?: string;
  minDensity?: number;
  limit?: number;
  orderBy?: 'technical_density' | 'code_blocks' | 'tool_invocations' | 'total_words' | 'duration_minutes';
}

// ── Categories ──

export const CATEGORIES: ProfileCategory[] = [
  // 14 adapted transcript categories
  {
    key: 'file_paths',
    label: 'File Paths',
    regex: /(?:\/[\w.-]+){2,}|[A-Z]:\\[\w\\.-]+|\b[\w-]+\.(?:ts|js|py|rs|go|java|tsx|jsx|css|html|json|yaml|yml|toml|md|sql|sh|bash|zsh|dockerfile|xml|csv|env|vue|svelte|rb|php|c|cpp|h|hpp|cs|swift|kt|scala|zig|wasm|prisma|graphql|proto)\b/gi,
  },
  {
    key: 'cli_commands',
    label: 'CLI Commands',
    regex: /\b(?:npm|npx|yarn|pnpm|pip|cargo|go|docker|kubectl|git|curl|wget|chmod|chown|mkdir|rm|cp|mv|ls|cat|grep|sed|awk|find|ssh|scp|tar|brew|apt|yum|dnf|pacman|make|cmake|gcc|rustc|javac|python|node|deno|bun)\s+[\w/.@-]+/gi,
  },
  {
    key: 'code_keywords',
    label: 'Code Keywords',
    regex: /\b(?:function|const|let|var|class|interface|type|enum|import|export|async|await|return|throw|try|catch|finally|if|else|for|while|switch|case|default|break|continue|new|this|super|extends|implements|abstract|static|public|private|protected|readonly|override|yield|def|fn|impl|struct|trait|match|pub|mod|use|from|as|with|lambda|self|None|True|False)\b/g,
  },
  {
    key: 'code_identifiers',
    label: 'Code Identifiers',
    regex: /\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g,
  },
  {
    key: 'urls',
    label: 'URLs',
    regex: /https?:\/\/[\w.-]+[\w/\-?&=.%#@:]+/gi,
  },
  {
    key: 'port_numbers',
    label: 'Port Numbers',
    regex: /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b|\bport\s+(\d{2,5})\b/gi,
  },
  {
    key: 'api_endpoints',
    label: 'API Endpoints',
    regex: /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[\w/{}:.-]+|\b\/api\/[\w/{}:.-]+/gi,
  },
  {
    key: 'sql_statements',
    label: 'SQL Statements',
    regex: /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|INDEX|TABLE|VIEW|TRIGGER|PRAGMA)\b/gi,
  },
  {
    key: 'env_vars',
    label: 'Environment Variables',
    regex: /\$\{?[A-Z][A-Z0-9_]+\}?|process\.env\.\w+|import\.meta\.env\.\w+/g,
  },
  {
    key: 'version_numbers',
    label: 'Version Numbers',
    regex: /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?(?:\+[\w.]+)?\b/g,
  },
  {
    key: 'doc_references',
    label: 'Documentation References',
    regex: /\b(?:README|CHANGELOG|LICENSE|CONTRIBUTING|TODO|FIXME|HACK|NOTE|IMPORTANT|DEPRECATED|@param|@returns?|@throws|@see|@example|@since|@deprecated|@author|@file|@description|@version)\b/gi,
  },
  {
    key: 'definitions',
    label: 'Definitions & Explanations',
    regex: /\b(?:means?|refers?\s+to|is\s+(?:a|an|the)|defined\s+as|stands?\s+for|i\.e\.|e\.g\.|in\s+other\s+words|specifically|essentially|basically)\b/gi,
  },
  {
    key: 'best_practices',
    label: 'Best Practices',
    regex: /\b(?:best\s+practice|recommend|should\s+(?:always|never|avoid)|anti[- ]?pattern|code\s+smell|convention|idiomatic|prefer|instead\s+of|avoid|trade[- ]?off|principle|pattern)\b/gi,
  },
  {
    key: 'warnings',
    label: 'Warnings & Caveats',
    regex: /\b(?:warning|caution|careful|danger|risk|caveat|gotcha|pitfall|breaking\s+change|security\s+risk|vulnerability|deprecated|unsafe|do\s+not|don't|never|important\s+note)\b/gi,
  },
  // 6 Claude-specific categories
  {
    key: 'prompt_patterns',
    label: 'Prompt Engineering',
    regex: /\b(?:system\s+prompt|user\s+prompt|few[- ]?shot|zero[- ]?shot|chain[- ]?of[- ]?thought|CoT|in[- ]?context\s+learning|prompt\s+(?:injection|template|engineering)|role[- ]?play|persona|instruction[- ]?(?:tuning|following)|delimiters?|XML\s+tags?)\b/gi,
  },
  {
    key: 'error_patterns',
    label: 'Error Messages',
    regex: /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|RuntimeError|ValueError|KeyError|ImportError|ModuleNotFoundError|AttributeError|FileNotFoundError|PermissionError|ConnectionError|TimeoutError|ENOENT|EACCES|ECONNREFUSED|EPERM|ERR_\w+|stack\s+trace|traceback|segfault|panic|unhandled\s+(?:rejection|exception))\b/g,
  },
  {
    key: 'package_names',
    label: 'Package Names',
    regex: /\b@[\w-]+\/[\w.-]+\b|(?:npm\s+(?:install|i)|yarn\s+add|pip\s+install|cargo\s+add)\s+[\w@/.-]+/g,
  },
  {
    key: 'git_operations',
    label: 'Git Operations',
    regex: /\bgit\s+(?:clone|init|add|commit|push|pull|fetch|merge|rebase|cherry[- ]?pick|stash|branch|checkout|switch|log|diff|status|reset|revert|tag|remote|submodule|worktree|bisect)\b/gi,
  },
  {
    key: 'docker_ops',
    label: 'Docker/Container Ops',
    regex: /\b(?:dockerfile|docker[- ]?compose|podman|kubernetes|k8s|helm|FROM\s+\w+|WORKDIR|ENTRYPOINT|docker\s+(?:build|run|push|pull|exec|stop|rm|ps|images|volume|network|compose))\b/gi,
  },
  {
    key: 'question_patterns',
    label: 'Question Patterns',
    regex: /\b(?:how\s+(?:do|can|should|would|to)|what\s+(?:is|are|does|would)|why\s+(?:does|is|are|do|would|can't)|is\s+(?:it|there|this)|can\s+(?:you|I|we)|could\s+you|would\s+you|where\s+(?:is|are|do|does)|when\s+(?:should|do|does|is))\b/gi,
  },
];

// ── Code block detection ──

const CODE_BLOCK_REGEX = /```(\w*)\s*\n/g;

function countCodeBlocks(texts: string[]): { count: number; langs: string[] } {
  let count = 0;
  const langSet = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    CODE_BLOCK_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CODE_BLOCK_REGEX.exec(text)) !== null) {
      count++;
      if (m[1]) langSet.add(m[1].toLowerCase());
    }
  }
  return { count, langs: [...langSet].sort() };
}

// ── Regex scanning (returns counts + top matches) ──

function runRegexCategories(text: string): { counts: Record<string, number>; details: Record<string, string[]> } {
  const counts: Record<string, number> = {};
  const details: Record<string, string[]> = {};
  for (const cat of CATEGORIES) {
    cat.regex.lastIndex = 0;
    const matches = text.match(cat.regex);
    counts[cat.key] = matches ? matches.length : 0;
    if (matches) {
      // Collect top 5 unique matches (case-insensitive dedup)
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const m of matches) {
        const key = m.toLowerCase();
        if (!seen.has(key) && unique.length < 5) {
          seen.add(key);
          unique.push(m);
        }
      }
      details[cat.key] = unique;
    }
  }
  return { counts, details };
}

// ── Primary type heuristic ──

function computePrimaryType(
  counts: Record<string, number>,
  structural: { codeBlocks: number },
): string {
  const coding = (counts.code_keywords ?? 0) + (counts.code_identifiers ?? 0) + structural.codeBlocks * 3;
  const devops = (counts.docker_ops ?? 0) + (counts.cli_commands ?? 0) + (counts.git_operations ?? 0);
  const research = (counts.definitions ?? 0) + (counts.doc_references ?? 0) + (counts.urls ?? 0);
  const qa = (counts.question_patterns ?? 0) + (counts.error_patterns ?? 0);

  const scores: Record<string, number> = { coding, devops, research, qa };
  const max = Math.max(...Object.values(scores));
  if (max === 0) return 'general';

  const winner = Object.entries(scores).find(([, v]) => v === max)![0];
  return winner;
}

// ── Technical density ──

function computeTechnicalDensity(counts: Record<string, number>, textLength: number): number {
  if (textLength === 0) return 0;
  const totalMatches = Object.values(counts).reduce((a, b) => a + b, 0);
  const raw = totalMatches / (textLength / 100);
  return Math.min(1.0, Math.max(0.0, raw));
}

// ── Word count helper ──

function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Schema ──

function ensureProfileTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_profiles (
      conversation_uuid TEXT PRIMARY KEY REFERENCES conversations(uuid),
      file_paths INTEGER DEFAULT 0,
      cli_commands INTEGER DEFAULT 0,
      code_keywords INTEGER DEFAULT 0,
      code_identifiers INTEGER DEFAULT 0,
      urls INTEGER DEFAULT 0,
      port_numbers INTEGER DEFAULT 0,
      api_endpoints INTEGER DEFAULT 0,
      sql_statements INTEGER DEFAULT 0,
      env_vars INTEGER DEFAULT 0,
      version_numbers INTEGER DEFAULT 0,
      doc_references INTEGER DEFAULT 0,
      definitions INTEGER DEFAULT 0,
      best_practices INTEGER DEFAULT 0,
      warnings INTEGER DEFAULT 0,
      prompt_patterns INTEGER DEFAULT 0,
      error_patterns INTEGER DEFAULT 0,
      package_names INTEGER DEFAULT 0,
      git_operations INTEGER DEFAULT 0,
      docker_ops INTEGER DEFAULT 0,
      question_patterns INTEGER DEFAULT 0,
      tool_invocations INTEGER DEFAULT 0,
      tool_errors INTEGER DEFAULT 0,
      thinking_blocks INTEGER DEFAULT 0,
      code_blocks INTEGER DEFAULT 0,
      code_block_langs TEXT,
      branch_points INTEGER DEFAULT 0,
      attachment_count INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      human_messages INTEGER DEFAULT 0,
      assistant_messages INTEGER DEFAULT 0,
      total_words INTEGER DEFAULT 0,
      avg_message_length REAL DEFAULT 0.0,
      duration_minutes REAL DEFAULT 0.0,
      human_profile TEXT,
      assistant_profile TEXT,
      category_details TEXT,
      primary_type TEXT,
      technical_density REAL DEFAULT 0.0
    );
    CREATE INDEX IF NOT EXISTS idx_cp_primary ON conversation_profiles(primary_type);
    CREATE INDEX IF NOT EXISTS idx_cp_density ON conversation_profiles(technical_density DESC);
  `);

  // Migrate v1 tables missing new columns
  const cols = db.pragma('table_info(conversation_profiles)') as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));
  const migrations: [string, string][] = [
    ['total_words', 'INTEGER DEFAULT 0'],
    ['avg_message_length', 'REAL DEFAULT 0.0'],
    ['duration_minutes', 'REAL DEFAULT 0.0'],
    ['human_profile', 'TEXT'],
    ['assistant_profile', 'TEXT'],
    ['category_details', 'TEXT'],
  ];
  for (const [col, typedef] of migrations) {
    if (!colNames.has(col)) {
      db.exec(`ALTER TABLE conversation_profiles ADD COLUMN ${col} ${typedef}`);
    }
  }
}

// ── SQL row interfaces ──

interface ConvRow { uuid: string }
interface SenderTextRow { sender: string; text: string }
interface BlockTextRow { text_content: string }
interface MsgCountRow { total: number; human: number; assistant: number }
interface CountRow { n: number }
interface TimestampRow { first_at: string | null; last_at: string | null }

// ── Prepared statements (created once, reused per conversation) ──

interface PreparedStmts {
  toolInv: Database.Statement;
  toolErr: Database.Statement;
  thinking: Database.Statement;
  branches: Database.Statement;
  attachments: Database.Statement;
  msgCounts: Database.Statement;
  msgTextsWithSender: Database.Statement;
  blockTexts: Database.Statement;
  timestamps: Database.Statement;
}

function prepareStatements(db: Database.Database): PreparedStmts {
  return {
    toolInv: db.prepare(
      "SELECT COUNT(*) as n FROM content_blocks WHERE conversation_uuid = ? AND block_type = 'tool_use'",
    ),
    toolErr: db.prepare(
      "SELECT COUNT(*) as n FROM content_blocks WHERE conversation_uuid = ? AND block_type = 'tool_result' AND is_error = 1",
    ),
    thinking: db.prepare(
      "SELECT COUNT(*) as n FROM content_blocks WHERE conversation_uuid = ? AND block_type = 'thinking'",
    ),
    branches: db.prepare(
      `SELECT COUNT(*) as n FROM (
         SELECT parent_message_uuid FROM messages
         WHERE conversation_uuid = ? AND parent_message_uuid IS NOT NULL
         GROUP BY parent_message_uuid HAVING COUNT(*) > 1
       )`,
    ),
    attachments: db.prepare(
      "SELECT COUNT(*) as n FROM messages WHERE conversation_uuid = ? AND attachments != '[]' AND attachments IS NOT NULL AND attachments != ''",
    ),
    msgCounts: db.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN sender = 'human' THEN 1 ELSE 0 END) as human,
         SUM(CASE WHEN sender = 'assistant' THEN 1 ELSE 0 END) as assistant
       FROM messages WHERE conversation_uuid = ?`,
    ),
    msgTextsWithSender: db.prepare(
      'SELECT sender, text FROM messages WHERE conversation_uuid = ? AND text IS NOT NULL',
    ),
    blockTexts: db.prepare(
      "SELECT text_content FROM content_blocks WHERE conversation_uuid = ? AND block_type IN ('text', 'thinking', 'voice_note') AND text_content IS NOT NULL",
    ),
    timestamps: db.prepare(
      'SELECT MIN(created_at) as first_at, MAX(created_at) as last_at FROM messages WHERE conversation_uuid = ?',
    ),
  };
}

// ── Structural metrics ──

function countStructuralMetrics(stmts: PreparedStmts, uuid: string) {
  const toolInv = stmts.toolInv.get(uuid) as CountRow;
  const toolErr = stmts.toolErr.get(uuid) as CountRow;
  const thinking = stmts.thinking.get(uuid) as CountRow;
  const branches = stmts.branches.get(uuid) as CountRow;
  const attachments = stmts.attachments.get(uuid) as CountRow;
  const msgCounts = stmts.msgCounts.get(uuid) as MsgCountRow;
  const ts = stmts.timestamps.get(uuid) as TimestampRow;

  let durationMinutes = 0;
  if (ts.first_at && ts.last_at) {
    const diff = new Date(ts.last_at).getTime() - new Date(ts.first_at).getTime();
    durationMinutes = Math.max(0, diff / 60000);
  }

  return {
    toolInvocations: toolInv.n,
    toolErrors: toolErr.n,
    thinkingBlocks: thinking.n,
    branchPoints: branches.n,
    attachmentCount: attachments.n,
    messageCount: msgCounts.total,
    humanMessages: msgCounts.human,
    assistantMessages: msgCounts.assistant,
    durationMinutes,
  };
}

// ── Gather text (with sender separation) ──

function gatherConversationText(stmts: PreparedStmts, uuid: string): {
  allTexts: string[];
  humanText: string;
  assistantText: string;
  totalWords: number;
  avgMessageLength: number;
} {
  const msgRows = stmts.msgTextsWithSender.all(uuid) as SenderTextRow[];
  const blockTexts = stmts.blockTexts.all(uuid) as BlockTextRow[];

  const humanTexts: string[] = [];
  const assistantTexts: string[] = [];
  const allTexts: string[] = [];
  let totalWords = 0;
  let totalLength = 0;

  for (const row of msgRows) {
    allTexts.push(row.text);
    totalWords += countWords(row.text);
    totalLength += row.text.length;
    if (row.sender === 'human') humanTexts.push(row.text);
    else assistantTexts.push(row.text);
  }
  for (const row of blockTexts) {
    allTexts.push(row.text_content);
    totalWords += countWords(row.text_content);
    totalLength += row.text_content.length;
    // Content blocks are always assistant
    assistantTexts.push(row.text_content);
  }

  const msgCount = msgRows.length || 1;
  return {
    allTexts,
    humanText: humanTexts.join(' '),
    assistantText: assistantTexts.join(' '),
    totalWords,
    avgMessageLength: totalLength / msgCount,
  };
}

// ── Insert columns (must match table order) ──

const INSERT_COLS = [
  'conversation_uuid',
  ...CATEGORIES.map((c) => c.key),
  'tool_invocations', 'tool_errors', 'thinking_blocks',
  'code_blocks', 'code_block_langs',
  'branch_points', 'attachment_count',
  'message_count', 'human_messages', 'assistant_messages',
  'total_words', 'avg_message_length', 'duration_minutes',
  'human_profile', 'assistant_profile', 'category_details',
  'primary_type', 'technical_density',
] as const;

const INSERT_SQL = `INSERT OR REPLACE INTO conversation_profiles (${INSERT_COLS.join(', ')}) VALUES (${INSERT_COLS.map(() => '?').join(', ')})`;

// ── Main profiler ──

export function profileConversations(dbPath: string, opts?: ProfileOptions): ProfileResult {
  const db = new Database(dbPath, { timeout: 10000 });
  try {
    ensureProfileTable(db);

    // Determine which conversations to profile.
    //
    // Three modes:
    //   1. Explicit UUID list           → profile only those, wipe their rows first.
    //   2. rebuild: true                → wipe everything and re-profile all (legacy v1 behavior).
    //   3. Default (incremental)        → profile only convs that lack a profile row.
    //      Cuts re-run time from ~10 min to ~instant on a 600-conv DB.
    let convUuids: string[];
    if (opts?.conversationUuids && opts.conversationUuids.length > 0) {
      convUuids = opts.conversationUuids;
      const delStmt = db.prepare('DELETE FROM conversation_profiles WHERE conversation_uuid = ?');
      for (const u of convUuids) delStmt.run(u);
    } else if (opts?.rebuild) {
      db.exec('DELETE FROM conversation_profiles');
      convUuids = (db.prepare('SELECT uuid FROM conversations').all() as ConvRow[]).map((r) => r.uuid);
    } else {
      // Incremental: LEFT JOIN finds convs without a profile row.
      convUuids = (db.prepare(`
        SELECT c.uuid
          FROM conversations c
          LEFT JOIN conversation_profiles p ON p.conversation_uuid = c.uuid
         WHERE p.conversation_uuid IS NULL
      `).all() as ConvRow[]).map((r) => r.uuid);

      const totalConvs = (db.prepare('SELECT COUNT(*) as n FROM conversations').get() as CountRow).n;
      const alreadyProfiled = totalConvs - convUuids.length;
      if (alreadyProfiled > 0) {
        console.log(`Skipping ${alreadyProfiled} already-profiled conversation(s) (use --rebuild to redo).`);
      }
    }

    if (convUuids.length === 0) {
      console.log('Nothing to profile.');
      return { totalProfiled: 0, avgDensity: 0, typeDistribution: {} };
    }

    console.log(`Profiling ${convUuids.length} conversations...`);

    const slowThresholdMs = opts?.slowThresholdMs ?? 5000;
    const slowConvs: Array<{ uuid: string; ms: number; words: number }> = [];

    const stmts = prepareStatements(db);
    const insertStmt = db.prepare(INSERT_SQL);
    const typeDistribution: Record<string, number> = {};
    let densitySum = 0;
    let processed = 0;

    const runInsert = db.transaction((batch: string[]) => {
      for (const uuid of batch) {
        const t0 = Date.now();

        // 1. Gather all text segments (with sender separation)
        const textData = gatherConversationText(stmts, uuid);
        const allText = textData.allTexts.join(' ');

        // 2. Run 20 regex categories on combined text
        const { counts, details } = runRegexCategories(allText);

        // 3. Per-sender profiling
        const humanCounts = runRegexCategories(textData.humanText).counts;
        const assistantCounts = runRegexCategories(textData.assistantText).counts;

        // 4. Detect markdown code blocks + language tags
        const codeInfo = countCodeBlocks(textData.allTexts);

        // 5. Count structural metrics from DB
        const structural = countStructuralMetrics(stmts, uuid);

        // 6. Compute classification
        const primaryType = computePrimaryType(counts, { codeBlocks: codeInfo.count });
        const density = computeTechnicalDensity(counts, allText.length);

        // 7. Insert row
        insertStmt.run(
          uuid,
          ...CATEGORIES.map((c) => counts[c.key] ?? 0),
          structural.toolInvocations,
          structural.toolErrors,
          structural.thinkingBlocks,
          codeInfo.count,
          JSON.stringify(codeInfo.langs),
          structural.branchPoints,
          structural.attachmentCount,
          structural.messageCount,
          structural.humanMessages,
          structural.assistantMessages,
          textData.totalWords,
          Math.round(textData.avgMessageLength * 10) / 10,
          Math.round(structural.durationMinutes * 10) / 10,
          JSON.stringify(humanCounts),
          JSON.stringify(assistantCounts),
          JSON.stringify(details),
          primaryType,
          density,
        );

        typeDistribution[primaryType] = (typeDistribution[primaryType] ?? 0) + 1;
        densitySum += density;

        const ms = Date.now() - t0;
        if (ms > slowThresholdMs) {
          slowConvs.push({ uuid, ms, words: textData.totalWords });
        }

        if (opts?.verbose) {
          console.log(`  ${uuid.slice(0, 8)}… type=${primaryType} density=${density.toFixed(3)} words=${textData.totalWords} code_blocks=${codeInfo.count} tools=${structural.toolInvocations} duration=${structural.durationMinutes.toFixed(0)}m took=${ms}ms`);
        }
      }
    });

    // Smaller batches → shorter write-lock holds + more frequent progress flush.
    // (Was 100 before; profile_all on a 600-conv DB held the lock ~10 min.)
    const BATCH = 25;
    for (let i = 0; i < convUuids.length; i += BATCH) {
      const batch = convUuids.slice(i, i + BATCH);
      runInsert(batch);
      processed += batch.length;
      if (convUuids.length > BATCH) {
        process.stdout.write(`\r  ${processed}/${convUuids.length} conversations profiled...`);
      }
    }
    if (convUuids.length > BATCH) process.stdout.write('\n');

    if (slowConvs.length > 0) {
      console.warn(`\n⚠  ${slowConvs.length} slow conversation(s) (>${slowThresholdMs}ms):`);
      slowConvs.sort((a, b) => b.ms - a.ms);
      for (const { uuid, ms, words } of slowConvs.slice(0, 10)) {
        console.warn(`   ${uuid.slice(0, 12)}…  ${ms}ms  (${words.toLocaleString()} words)`);
      }
    }

    return {
      totalProfiled: convUuids.length,
      avgDensity: convUuids.length > 0 ? densitySum / convUuids.length : 0,
      typeDistribution,
    };
  } finally {
    db.close();
  }
}

// ── Query helpers ──

export function getProfile(dbPath: string, conversationUuid: string): ConversationProfile | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT * FROM conversation_profiles WHERE conversation_uuid = ?').get(conversationUuid);
    return (row as ConversationProfile) ?? null;
  } finally {
    db.close();
  }
}

export function getProfiles(dbPath: string, opts?: ProfileQueryOptions): ConversationProfile[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.primaryType) {
      conditions.push('primary_type = ?');
      params.push(opts.primaryType);
    }
    if (opts?.minDensity != null) {
      conditions.push('technical_density >= ?');
      params.push(opts.minDensity);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const validOrders = ['technical_density', 'code_blocks', 'tool_invocations', 'total_words', 'duration_minutes'] as const;
    const orderCol = opts?.orderBy && validOrders.includes(opts.orderBy) ? opts.orderBy : 'technical_density';
    const limit = opts?.limit ?? 20;

    const sql = `SELECT cp.*, c.name AS conversation_name
      FROM conversation_profiles cp
      LEFT JOIN conversations c ON c.uuid = cp.conversation_uuid
      ${where}
      ORDER BY ${orderCol} DESC
      LIMIT ?`;

    return db.prepare(sql).all(...params, limit) as ConversationProfile[];
  } finally {
    db.close();
  }
}

// ── Profile aggregates (for getFullStats integration) ──

export interface ProfileAggregates {
  totalProfiled: number;
  avgDensity: number;
  avgWords: number;
  avgDuration: number;
  typeDistribution: Record<string, number>;
  topCategories: { category: string; totalMatches: number }[];
}

export function getProfileAggregates(dbPath: string): ProfileAggregates | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Check if table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_profiles'").get();
    if (!tableExists) return null;

    const row = db.prepare(`
      SELECT COUNT(*) as total,
             AVG(technical_density) as avg_density,
             AVG(total_words) as avg_words,
             AVG(duration_minutes) as avg_duration
      FROM conversation_profiles
    `).get() as { total: number; avg_density: number; avg_words: number; avg_duration: number };

    if (row.total === 0) return null;

    const typeRows = db.prepare(
      'SELECT primary_type, COUNT(*) as cnt FROM conversation_profiles GROUP BY primary_type ORDER BY cnt DESC',
    ).all() as { primary_type: string; cnt: number }[];

    const typeDistribution: Record<string, number> = {};
    for (const r of typeRows) typeDistribution[r.primary_type] = r.cnt;

    // Sum each regex category across all conversations to find top categories
    const catSums: { category: string; totalMatches: number }[] = [];
    for (const cat of CATEGORIES) {
      const sum = db.prepare(`SELECT SUM(${cat.key}) as s FROM conversation_profiles`).get() as { s: number };
      catSums.push({ category: cat.label, totalMatches: sum.s ?? 0 });
    }
    catSums.sort((a, b) => b.totalMatches - a.totalMatches);

    return {
      totalProfiled: row.total,
      avgDensity: Math.round(row.avg_density * 1000) / 1000,
      avgWords: Math.round(row.avg_words),
      avgDuration: Math.round(row.avg_duration * 10) / 10,
      typeDistribution,
      topCategories: catSums.slice(0, 5),
    };
  } finally {
    db.close();
  }
}
