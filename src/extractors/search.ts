/**
 * @file search.ts
 * @description Client-side conversation search by title, date, keyword
 * @version 1.1.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-27T05:58:49Z
 */
import type { ConversationMeta } from '../types.js';

export interface SearchOptions {
  query?: string;
  before?: string; // ISO date
  after?: string;  // ISO date
  limit?: number;
}

export function searchConversations(
  conversations: ConversationMeta[],
  options: SearchOptions,
): ConversationMeta[] {
  let results = [...conversations];

  if (options.query) {
    const q = options.query.toLowerCase();
    results = results.filter((c) => c.name?.toLowerCase().includes(q));
  }

  if (options.after) {
    const after = new Date(options.after).getTime();
    if (isNaN(after)) throw new Error(`Invalid --after date: "${options.after}". Use ISO format, e.g. 2024-01-15.`);
    results = results.filter((c) => new Date(c.created_at).getTime() >= after);
  }

  if (options.before) {
    const before = new Date(options.before).getTime();
    if (isNaN(before)) throw new Error(`Invalid --before date: "${options.before}". Use ISO format, e.g. 2024-01-15.`);
    results = results.filter((c) => new Date(c.created_at).getTime() <= before);
  }

  // Sort by most recent first
  results.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  if (options.limit && options.limit > 0) {
    results = results.slice(0, options.limit);
  }

  return results;
}
