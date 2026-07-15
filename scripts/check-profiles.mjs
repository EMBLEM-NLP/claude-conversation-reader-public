/**
 * @file check-profiles.mjs
 * @description Read-only inspection of the conversation_profiles table:
 *   list profile tables present, total profiled-conversation count, the
 *   profile row (if any) for a given conversation, and the type
 *   distribution across all profiled conversations. Used during 2026-05-28
 *   to confirm `import-code-session` data landed BEFORE the last profile
 *   run, motivating Block E (resolve write-lock).
 *   Usage: node scripts/check-profiles.mjs [conversation_uuid]
 * @version 1.0.0
 * @created 2026-05-28T14:32:33Z
 * @lastUpdated 2026-05-28T14:32:33Z
 */
import D from 'better-sqlite3';
const db = new D('.ccr-import.sqlite', { readonly: true });
const id = process.argv[2] || 'session_01QzYcqzdPke6WKiBkyg1d8W';

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%profile%'").all();
console.log('Profile tables:', tables.map(t => t.name).join(', ') || '(none)');

try {
  const total = db.prepare('SELECT COUNT(*) as c FROM conversation_profiles').get();
  console.log('Total profiled conversations:', total.c);

  const ours = db.prepare('SELECT * FROM conversation_profiles WHERE conversation_uuid = ?').get(id);
  if (ours) {
    console.log('\nProfile for ' + id + ':');
    for (const [k, v] of Object.entries(ours)) {
      const display = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v;
      console.log('  ' + k.padEnd(28) + ' ' + JSON.stringify(display));
    }
  } else {
    console.log('\nNo profile row exists for ' + id);
  }

  console.log('\nType distribution:');
  const types = db.prepare('SELECT primary_type, COUNT(*) as c FROM conversation_profiles GROUP BY primary_type ORDER BY c DESC').all();
  for (const t of types) console.log('  ' + (t.primary_type || '(null)').padEnd(15) + ' ' + t.c);
} catch (e) {
  console.log('Error reading conversation_profiles:', e.message);
}
db.close();
