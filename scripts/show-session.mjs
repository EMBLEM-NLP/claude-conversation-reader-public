/**
 * @file show-session.mjs
 * @description Dump the first N messages of a session straight from
 *   .ccr-import.sqlite in chronological order. Used as a workaround when
 *   `ccr main-branch` returned only 1 row (pre-`fac0fff` parent_message_uuid
 *   bug). Now mainly useful for quick "give me this conv's first 60 messages"
 *   peeks without launching the full CLI.
 *   Usage: node scripts/show-session.mjs <conversation_uuid>
 * @version 1.0.0
 * @created 2026-05-27T20:30:00Z
 * @lastUpdated 2026-05-28T14:32:33Z
 */
import D from 'better-sqlite3';

const id = process.argv[2];
if (!id) {
  console.error('Usage: node scripts/show-session.mjs <session_id>');
  process.exit(1);
}

const db = new D('.ccr-import.sqlite', { readonly: true });
const conv = db.prepare('SELECT name, summary, created_at, updated_at FROM conversations WHERE uuid = ?').get(id);
if (!conv) {
  console.error(`No conversation found for ${id}`);
  process.exit(1);
}
const total = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_uuid = ?').get(id).c;
const rows = db.prepare('SELECT sender, text, created_at FROM messages WHERE conversation_uuid = ? ORDER BY created_at LIMIT 60').all(id);

console.log(`# ${conv.name}`);
console.log(`Status:  ${conv.summary}`);
console.log(`Created: ${conv.created_at}`);
console.log(`Updated: ${conv.updated_at}`);
console.log(`Total messages: ${total}`);
console.log('---');
for (const r of rows) {
  const text = (r.text || '').slice(0, 280).replace(/\s+/g, ' ');
  console.log(`[${r.created_at.slice(0, 19)}] ${r.sender}: ${text}`);
}
db.close();
