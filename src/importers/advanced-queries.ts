/**
 * @file advanced-queries.ts
 * @description Edit history, attachments, branches, threads, audit, local delete
 * @version 1.2.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-27T05:59:21Z
 */
import Database from 'better-sqlite3';
import type { ProfileAggregates } from './conversation-profiler.js';
import { getProfileAggregates } from './conversation-profiler.js';

const MSG_COLUMNS = 'uuid, conversation_uuid, sender, text, created_at, updated_at, attachments, files, parent_message_uuid';

export interface MessageRow {
  uuid: string;
  conversation_uuid: string;
  sender: string;
  text: string;
  created_at: string;
  updated_at: string | null;
  attachments: string;
  files: string;
  parent_message_uuid: string | null;
  name?: string;
}

export interface ConversationSummaryRow {
  uuid: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/**
 * Find conversations with no title (name IS NULL or empty).
 */
export function getUntitledConversations(dbPath: string, limit = 50): ConversationSummaryRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT c.uuid, c.name, c.created_at, c.updated_at,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_uuid = c.uuid) as message_count
      FROM conversations c
      WHERE c.name IS NULL OR c.name = ''
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit) as ConversationSummaryRow[];
  } finally {
    db.close();
  }
}

/**
 * Find conversations with zero messages.
 */
export function getEmptyConversations(dbPath: string, limit = 50): ConversationSummaryRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT c.uuid, c.name, c.created_at, c.updated_at, 0 as message_count
      FROM conversations c
      WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_uuid = c.uuid)
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit) as ConversationSummaryRow[];
  } finally {
    db.close();
  }
}

/**
 * Summary stats: total conversations, untitled, empty.
 */
export function getConversationStats(dbPath: string): { total: number; untitled: number; empty: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const total = (db.prepare('SELECT COUNT(*) as n FROM conversations').get() as { n: number }).n;
    const untitled = (db.prepare("SELECT COUNT(*) as n FROM conversations WHERE name IS NULL OR name = ''").get() as { n: number }).n;
    const empty = (db.prepare('SELECT COUNT(*) as n FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_uuid = c.uuid)').get() as { n: number }).n;
    return { total, untitled, empty };
  } finally {
    db.close();
  }
}

export interface FullStats {
  conversations: { total: number; untitled: number; empty: number; withProject: number };
  messages: { total: number; human: number; assistant: number; avgPerConversation: number };
  contentBlocks: { total: number; byType: { type: string; count: number }[] };
  dateRange: { first: string; last: string };
  monthlyActivity: { month: string; count: number }[];
  topConversations: { name: string; uuid: string; messageCount: number }[];
  topTools: { name: string; count: number }[];
  entities: { total: number; byType: { type: string; count: number }[] };
  thinking: { total: number; avgPerAssistantMessage: number };
  profiles: ProfileAggregates | null;
}

export function getFullStats(dbPath: string): FullStats {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = (sql: string) => db.prepare(sql).get() as Record<string, number>;
    const rows = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

    const totalConvs = row('SELECT COUNT(*) as n FROM conversations').n;
    const untitled = row("SELECT COUNT(*) as n FROM conversations WHERE name IS NULL OR name = ''").n;
    const empty = row('SELECT COUNT(*) as n FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_uuid = c.uuid)').n;
    // project_uuid column may not exist in older databases
    let withProject = 0;
    try { withProject = row("SELECT COUNT(*) as n FROM conversations WHERE project_uuid IS NOT NULL AND project_uuid != ''").n; } catch { /* column doesn't exist */ }

    const totalMsgs = row('SELECT COUNT(*) as n FROM messages').n;
    const human = row("SELECT COUNT(*) as n FROM messages WHERE sender = 'human'").n;
    const assistant = row("SELECT COUNT(*) as n FROM messages WHERE sender = 'assistant'").n;
    const avgMsgs = totalConvs > 0 ? Math.round((totalMsgs / totalConvs) * 10) / 10 : 0;

    const totalBlocks = row('SELECT COUNT(*) as n FROM content_blocks').n;
    const byType = rows('SELECT block_type as type, COUNT(*) as count FROM content_blocks GROUP BY block_type ORDER BY count DESC') as { type: string; count: number }[];

    const first = (db.prepare('SELECT MIN(created_at) as d FROM messages').get() as { d: string }).d;
    const last = (db.prepare('SELECT MAX(created_at) as d FROM messages').get() as { d: string }).d;

    const monthly = rows("SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count FROM messages GROUP BY month ORDER BY month DESC LIMIT 12") as { month: string; count: number }[];

    const topConvs = rows('SELECT c.name, c.uuid, COUNT(*) as messageCount FROM messages m JOIN conversations c ON c.uuid = m.conversation_uuid GROUP BY m.conversation_uuid ORDER BY messageCount DESC LIMIT 10') as { name: string; uuid: string; messageCount: number }[];

    const topTools = rows("SELECT tool_name as name, COUNT(*) as count FROM content_blocks WHERE block_type = 'tool_use' AND tool_name IS NOT NULL AND tool_name != '' GROUP BY tool_name ORDER BY count DESC LIMIT 10") as { name: string; count: number }[];

    const totalThinking = row("SELECT COUNT(*) as n FROM content_blocks WHERE block_type = 'thinking'").n;
    const avgThinking = assistant > 0 ? Math.round((totalThinking / assistant) * 100) / 100 : 0;

    const totalEntities = row('SELECT COUNT(*) as n FROM entities').n;
    const entityByType = rows('SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC') as { type: string; count: number }[];

    // Profile aggregates (may not exist if profiler hasn't run)
    let profiles: ProfileAggregates | null = null;
    try { profiles = getProfileAggregates(dbPath); } catch { /* table may not exist */ }

    return {
      conversations: { total: totalConvs, untitled, empty, withProject },
      messages: { total: totalMsgs, human, assistant, avgPerConversation: avgMsgs },
      contentBlocks: { total: totalBlocks, byType },
      dateRange: { first, last },
      monthlyActivity: monthly,
      topConversations: topConvs,
      topTools,
      entities: { total: totalEntities, byType: entityByType },
      thinking: { total: totalThinking, avgPerAssistantMessage: avgThinking },
      profiles,
    };
  } finally {
    db.close();
  }
}

/**
 * Delete a conversation and all related data from the local SQLite database.
 */
export function deleteConversationLocal(dbPath: string, conversationUuid: string): void {
  const db = new Database(dbPath);
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM entities WHERE conversation_uuid = ?').run(conversationUuid);
      db.prepare('DELETE FROM content_blocks WHERE conversation_uuid = ?').run(conversationUuid);
      db.prepare('DELETE FROM messages WHERE conversation_uuid = ?').run(conversationUuid);
      db.prepare('DELETE FROM conversations WHERE uuid = ?').run(conversationUuid);
      // Clean up graph tables if they exist
      const hasGraphNodes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_nodes'").get();
      if (hasGraphNodes) {
        db.prepare("DELETE FROM graph_edges WHERE conversation_uuid = ?").run(conversationUuid);
        db.prepare("DELETE FROM graph_nodes WHERE id = 'conv:' || ?").run(conversationUuid);
      }
    })();
  } finally {
    db.close();
  }
}

export function getEditHistory(dbPath: string, messageUuid: string): MessageRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.prepare(`
      SELECT ${MSG_COLUMNS} FROM messages WHERE uuid = ? OR parent_message_uuid = ? ORDER BY created_at ASC
    `);
    return stmt.all(messageUuid, messageUuid) as MessageRow[];
  } finally {
    db.close();
  }
}

export function searchAttachments(dbPath: string, query: string, limit = 10) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.prepare(`
      SELECT m.uuid, m.conversation_uuid, m.sender, m.text, m.created_at, m.attachments, m.files, c.name
      FROM messages m
      JOIN conversations c ON m.conversation_uuid = c.uuid
      WHERE m.attachments != '[]' AND m.attachments != ''
    `);
    const allRows = stmt.all() as Array<Record<string, unknown>>;

    const q = query.toLowerCase();
    const matched = allRows.filter((row) => {
      try {
        const parsed = JSON.parse(row.attachments as string);
        return JSON.stringify(parsed).toLowerCase().includes(q);
      } catch {
        return String(row.attachments).toLowerCase().includes(q);
      }
    });

    return matched.slice(0, limit);
  } finally {
    db.close();
  }
}

// Returns all messages in a conversation ordered chronologically (flat list).
export function getConversationMessages(dbPath: string, conversationUuid: string): MessageRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.prepare(`
      SELECT ${MSG_COLUMNS} FROM messages WHERE conversation_uuid = ? ORDER BY created_at ASC
    `);
    return stmt.all(conversationUuid) as MessageRow[];
  } finally {
    db.close();
  }
}

// Reconstruct the main branch by following parent_message_uuid links.
// Picks the last child (by created_at) at each branch point — same logic as the live API tree traversal.
export function getConversationTree(dbPath: string, conversationUuid: string): MessageRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.prepare(`
      SELECT ${MSG_COLUMNS} FROM messages WHERE conversation_uuid = ? ORDER BY created_at ASC
    `);
    const allMsgs = stmt.all(conversationUuid) as MessageRow[];

    if (allMsgs.length === 0) return [];

    // Build lookup: uuid -> message, and parent -> children
    const byId = new Map<string, MessageRow>();
    const childrenOf = new Map<string, MessageRow[]>();

    for (const msg of allMsgs) {
      byId.set(msg.uuid, msg);
      const parentId = msg.parent_message_uuid || '__root__';
      const siblings = childrenOf.get(parentId) || [];
      siblings.push(msg);
      childrenOf.set(parentId, siblings);
    }

    // Find root(s): messages whose parent is null, empty, or the sentinel 00000000-...
    const roots = allMsgs.filter(
      (m) => !m.parent_message_uuid || m.parent_message_uuid === '00000000-0000-4000-8000-000000000000',
    );

    if (roots.length === 0) return allMsgs; // fallback to chronological

    // Walk the tree: at each node, pick the last child by created_at
    const result: MessageRow[] = [];
    let current: MessageRow | undefined = roots.sort((a, b) => a.created_at.localeCompare(b.created_at))[roots.length - 1];

    while (current) {
      result.push(current);
      const children = childrenOf.get(current.uuid);
      if (!children || children.length === 0) break;
      children.sort((a, b) => a.created_at.localeCompare(b.created_at));
      current = children[children.length - 1];
    }

    return result;
  } finally {
    db.close();
  }
}

export const getMainBranch = getConversationTree;

export interface BranchSummary {
  threadIndex: number;
  messageCount: number;
  forkPoint: string | null; // uuid of the message where this thread diverges from main
  forkDepth: number; // how many messages into the conversation the fork occurs
  lastMessage: string; // created_at of last message in this thread
  firstDivergentSender: string; // sender of the first message unique to this thread
}

export interface BranchResult {
  conversationUuid: string;
  totalMessages: number;
  threads: BranchSummary[];
  branchPoints: number; // how many messages have >1 child
}

export interface ThreadMessage {
  uuid: string;
  sender: string;
  text: string;
  created_at: string;
  parent_message_uuid: string | null;
  isShared: boolean; // true if this message is part of the main branch prefix
}

/**
 * Enumerate all distinct threads in a conversation.
 * Thread 0 = main branch (last child at each fork).
 * Thread 1+ = alternate branches, ordered by fork depth then created_at.
 */
export function getConversationBranches(dbPath: string, conversationUuid: string): BranchResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    const allMsgs = db.prepare(
      `SELECT ${MSG_COLUMNS} FROM messages WHERE conversation_uuid = ? ORDER BY created_at ASC`,
    ).all(conversationUuid) as MessageRow[];

    if (allMsgs.length === 0) {
      return { conversationUuid, totalMessages: allMsgs.length, threads: [], branchPoints: 0 };
    }

    // Build parent -> children map
    const childrenOf = new Map<string, MessageRow[]>();
    for (const msg of allMsgs) {
      const parentId = msg.parent_message_uuid || '__root__';
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(msg);
      childrenOf.set(parentId, siblings);
    }

    // Sort children by created_at at each node
    for (const children of childrenOf.values()) {
      children.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    // Find root
    const roots = allMsgs.filter(
      (m) => !m.parent_message_uuid || m.parent_message_uuid === '00000000-0000-4000-8000-000000000000',
    );
    if (roots.length === 0) {
      return { conversationUuid, totalMessages: allMsgs.length, threads: [], branchPoints: 0 };
    }
    const root = roots.sort((a, b) => a.created_at.localeCompare(b.created_at))[roots.length - 1];

    // Count branch points
    let branchPoints = 0;
    for (const children of childrenOf.values()) {
      if (children.length > 1) branchPoints++;
    }

    // DFS to enumerate all threads
    // Each thread is a root-to-leaf path. At each fork, the last child continues the current thread,
    // and earlier children spawn new threads.
    interface PendingThread {
      startNode: MessageRow;
      sharedPrefix: MessageRow[]; // messages from root to fork point (exclusive of startNode)
      forkPoint: string | null;
      forkDepth: number;
    }

    const threads: MessageRow[][] = [];
    const threadMeta: { forkPoint: string | null; forkDepth: number }[] = [];
    const pending: PendingThread[] = [{ startNode: root, sharedPrefix: [], forkPoint: null, forkDepth: 0 }];

    while (pending.length > 0) {
      const { startNode, sharedPrefix, forkPoint, forkDepth } = pending.shift()!;
      const thread: MessageRow[] = [...sharedPrefix, startNode];
      let current: MessageRow = startNode;

      // Walk forward, at each fork spawn pending threads for non-main children
      while (true) {
        const children = childrenOf.get(current.uuid);
        if (!children || children.length === 0) break;

        // Main child = last by created_at
        const mainChild = children[children.length - 1];

        // Alternate children spawn new threads
        for (let i = 0; i < children.length - 1; i++) {
          pending.push({
            startNode: children[i],
            sharedPrefix: [...thread], // share prefix up to and including current
            forkPoint: current.uuid,
            forkDepth: thread.length,
          });
        }

        thread.push(mainChild);
        current = mainChild;
      }

      threads.push(thread);
      threadMeta.push({ forkPoint, forkDepth });
    }

    // Build summaries — thread 0 is always the main branch
    const summaries: BranchSummary[] = threads.map((thread, idx) => {
      const meta = threadMeta[idx];
      const sharedLen = meta.forkDepth;
      const firstDivergent = thread[sharedLen]; // first message unique to this thread
      return {
        threadIndex: idx,
        messageCount: thread.length,
        forkPoint: meta.forkPoint,
        forkDepth: meta.forkDepth,
        lastMessage: thread[thread.length - 1].created_at,
        firstDivergentSender: firstDivergent?.sender ?? 'unknown',
      };
    });

    return { conversationUuid, totalMessages: allMsgs.length, threads: summaries, branchPoints };
  } finally {
    db.close();
  }
}

/**
 * Get the full message list for a specific thread index.
 * Thread 0 = main branch, Thread N = Nth alternate branch.
 * Messages shared with the main branch are marked with isShared=true.
 */
export function getThread(dbPath: string, conversationUuid: string, threadIndex: number): ThreadMessage[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const allMsgs = db.prepare(
      `SELECT ${MSG_COLUMNS} FROM messages WHERE conversation_uuid = ? ORDER BY created_at ASC`,
    ).all(conversationUuid) as MessageRow[];

    if (allMsgs.length === 0) return [];

    const childrenOf = new Map<string, MessageRow[]>();
    for (const msg of allMsgs) {
      const parentId = msg.parent_message_uuid || '__root__';
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(msg);
      childrenOf.set(parentId, siblings);
    }
    for (const children of childrenOf.values()) {
      children.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    const roots = allMsgs.filter(
      (m) => !m.parent_message_uuid || m.parent_message_uuid === '00000000-0000-4000-8000-000000000000',
    );
    if (roots.length === 0) return [];
    const root = roots.sort((a, b) => a.created_at.localeCompare(b.created_at))[roots.length - 1];

    // Same DFS as getConversationBranches to find the Nth thread
    interface PendingThread {
      startNode: MessageRow;
      sharedPrefix: MessageRow[];
      forkDepth: number;
    }

    const pending: PendingThread[] = [{ startNode: root, sharedPrefix: [], forkDepth: 0 }];
    let currentIndex = 0;

    while (pending.length > 0) {
      const { startNode, sharedPrefix, forkDepth } = pending.shift()!;
      const thread: MessageRow[] = [...sharedPrefix, startNode];
      let current: MessageRow = startNode;

      while (true) {
        const children = childrenOf.get(current.uuid);
        if (!children || children.length === 0) break;
        const mainChild = children[children.length - 1];
        for (let i = 0; i < children.length - 1; i++) {
          pending.push({
            startNode: children[i],
            sharedPrefix: [...thread],
            forkDepth: thread.length,
          });
        }
        thread.push(mainChild);
        current = mainChild;
      }

      if (currentIndex === threadIndex) {
        return thread.map((msg, idx) => ({
          uuid: msg.uuid,
          sender: msg.sender,
          text: msg.text,
          created_at: msg.created_at,
          parent_message_uuid: msg.parent_message_uuid,
          isShared: idx < forkDepth,
        }));
      }
      currentIndex++;
    }

    return []; // threadIndex out of range
  } finally {
    db.close();
  }
}

/**
 * Get all messages sharing the same parent (siblings/edits at a branch point).
 */
export function getMessageSiblings(dbPath: string, messageUuid: string): MessageRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT ${MSG_COLUMNS} FROM messages
      WHERE parent_message_uuid = (SELECT parent_message_uuid FROM messages WHERE uuid = ?)
      ORDER BY created_at ASC
    `).all(messageUuid) as MessageRow[];
  } finally {
    db.close();
  }
}
