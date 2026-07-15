/**
 * @file conversation.ts
 * @description Tree-to-linear conversation flattener (DAG to thread)
 * @version 1.0.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-15T17:15:45Z
 */
import type { ConversationTree, ChatMessage, LinearConversation, LinearMessage } from '../types.js';

export function flattenConversation(tree: ConversationTree): LinearConversation {
  const messages = tree.chat_messages ?? [];
  if (messages.length === 0) {
    return {
      uuid: tree.uuid,
      title: tree.name,
      model: tree.model,
      created_at: tree.created_at,
      messages: [],
    };
  }

  // Build lookup map
  const byId = new Map<string, ChatMessage>();
  for (const msg of messages) {
    byId.set(msg.uuid, msg);
  }

  // Find root messages (no parent or parent not in set)
  const roots = messages.filter((m) => !m.parent || !byId.has(m.parent));

  // Walk the primary branch: at each node follow the last child (most recent)
  const linear: LinearMessage[] = [];
  const visited = new Set<string>();

  function walk(msgId: string): void {
    if (visited.has(msgId)) return;
    visited.add(msgId);

    const msg = byId.get(msgId);
    if (!msg) return;

    linear.push({
      role: msg.sender,
      text: extractText(msg),
      timestamp: msg.created_at,
      uuid: msg.uuid,
    });

    // Follow the last child (most recent branch), sorted by created_at
    const children = Array.isArray(msg.children) ? msg.children : [];
    if (children.length > 0) {
      const sorted = [...children].sort((a, b) => {
        const msgA = byId.get(a);
        const msgB = byId.get(b);
        if (!msgA || !msgB) return 0;
        return msgA.created_at.localeCompare(msgB.created_at);
      });
      walk(sorted[sorted.length - 1]);
    }
  }

  // Start from the first root (typically the first human message)
  if (roots.length > 0) {
    walk(roots[0].uuid);
  }

  // Fallback: if tree walk returned far fewer messages than exist,
  // the conversation likely has no parent/child links (all root-level).
  // Fall back to chronological order of all messages.
  if (linear.length < messages.length * 0.5 && messages.length > 1) {
    const sorted = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return {
      uuid: tree.uuid,
      title: tree.name,
      model: tree.model,
      created_at: tree.created_at,
      messages: sorted.map((msg) => ({
        role: msg.sender,
        text: extractText(msg),
        timestamp: msg.created_at,
        uuid: msg.uuid,
      })),
    };
  }

  return {
    uuid: tree.uuid,
    title: tree.name,
    model: tree.model,
    created_at: tree.created_at,
    messages: linear,
  };
}

function extractText(msg: ChatMessage): string {
  // Prefer the top-level text field
  if (msg.text) return msg.text;

  // Fall back to content array
  if (msg.content && msg.content.length > 0) {
    return msg.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
  }

  return '';
}
