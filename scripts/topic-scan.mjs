/**
 * @file topic-scan.mjs
 * @description Count message mentions of a fixed list of deployment/SEO/security
 *   topics within a single conversation in .ccr-import.sqlite. Surfaces gaps by
 *   showing which topics have 0 mentions ("never discussed"). Used to build the
 *   pharmacy project's FOLLOWUPS.md gap analysis from the imported
 *   `session_01QzYcqzdPke6WKiBkyg1d8W` events.
 *   Usage: node scripts/topic-scan.mjs [conversation_uuid]
 * @version 1.0.0
 * @created 2026-05-27T21:00:00Z
 * @lastUpdated 2026-05-28T14:32:33Z
 */
import D from 'better-sqlite3';
const db = new D('.ccr-import.sqlite', {readonly:true});
const id = process.argv[2] || 'session_01QzYcqzdPke6WKiBkyg1d8W';
const topics = ['env var','secret','redirect','custom domain','form','analytics','plausible','lighthouse','wcag','accessibility','phipa','robots.txt','sitemap','consent','cookie','OG image','open graph','schema.org','jsonld','PWA','manifest','service worker','404 page','minor ailments','blister','OceanMD','jane app','Decap','admin/','main branch','merge','test','vitest','playwright','CSP','HTTPS','SSL','CDN','cache','HSTS','env','token'];
console.log('Topic mentions in '+id+':');
const stmt = db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_uuid = ? AND text LIKE ?');
const out = [];
for (const t of topics) {
  const r = stmt.get(id, '%' + t + '%');
  out.push([t, r.c]);
}
out.sort((a,b) => b[1] - a[1]);
for (const [t,c] of out) console.log('  ' + String(t).padEnd(22) + ' ' + c);
db.close();
