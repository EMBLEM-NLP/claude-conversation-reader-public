/**
 * @file session-readout.mjs
 * @description Rich readout of a fetched code-session JSON file: meta,
 *   pending action, event-type breakdown, top tool calls, real human prompts
 *   (filtering out task-notifications + tool_results), and first/last
 *   assistant replies. Reads `fetched-<id>.json` produced by
 *   `scripts/fetch-code-session.ts`. Used during 2026-05-28 analysis of
 *   `session_01QzYcqzdPke6WKiBkyg1d8W` to identify the deploy-stalled arc.
 *   Usage: node scripts/session-readout.mjs [fetched-<id>.json]
 * @version 1.0.0
 * @created 2026-05-27T20:50:00Z
 * @lastUpdated 2026-05-28T14:32:33Z
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'fetched-session_01QzYcqzdPke6WKiBkyg1d8W.json';
const d = JSON.parse(readFileSync(path, 'utf-8'));
const events = Array.isArray(d.events) ? d.events : (d.events.data ?? d.events.events ?? []);

const m = d.meta;
console.log('=== META ===');
console.log('id        :', m.id);
console.log('title     :', m.title);
console.log('status    :', m.session_status);
console.log('model     :', m.session_context?.model);
console.log('cwd       :', m.session_context?.cwd);
console.log('env_kind  :', m.environment_kind);
console.log('connection:', m.connection_status);
console.log('tags      :', (m.tags || []).join(', '));
console.log('created   :', m.created_at);
console.log('updated   :', m.updated_at);
const pa = m.external_metadata?.pending_action;
if (pa) {
  console.log('\n=== PENDING ACTION (paused here) ===');
  console.log('tool      :', pa.display_tool_name, '(' + pa.tool_name + ')');
  console.log('desc      :', pa.action_description);
  console.log('cmd       :', (pa.raw_command || pa.input?.command || '').slice(0, 200));
}

const types = {};
for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
console.log('\n=== EVENT BREAKDOWN ===');
for (const [t, c] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.log(' ', t.padEnd(28), c);
}

// Tool call frequency
const toolCounts = {};
for (const e of events) {
  const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
  for (const b of blocks) {
    if (b.type === 'tool_use' && b.name) {
      toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
    }
  }
}
console.log('\n=== TOP TOOL CALLS ===');
const tools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
for (const [t, c] of tools.slice(0, 15)) console.log(' ', t.padEnd(28), c);
console.log('  total tool calls:', tools.reduce((s, [, c]) => s + c, 0));

// All real human prompts
const humanPrompts = [];
for (const e of events) {
  if (e.message?.role !== 'user' || e.isSynthetic) continue;
  const c = e.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter(b => b.type === 'text').map(b => b.text).join(' ');
  if (!text || text.includes('<task-notification>') || text.includes('Tool loaded')) continue;
  humanPrompts.push({ at: e.created_at, text });
}
console.log('\n=== REAL HUMAN PROMPTS (' + humanPrompts.length + ') ===');
for (const p of humanPrompts) {
  console.log(`[${p.at.slice(0, 19)}] ${p.text.slice(0, 250).replace(/\s+/g, ' ')}`);
}

// First and last assistant text — useful for context
const assistantTextEvents = events.filter(e =>
  e.message?.role === 'assistant' &&
  Array.isArray(e.message.content) &&
  e.message.content.some(b => b.type === 'text')
);
const first = assistantTextEvents[0];
const last = assistantTextEvents[assistantTextEvents.length - 1];
const grabText = (e) => (e.message.content.find(b => b.type === 'text')?.text || '').slice(0, 600).replace(/\s+/g, ' ');
console.log('\n=== FIRST ASSISTANT REPLY ===');
console.log(`[${first.created_at.slice(0, 19)}]`, grabText(first));
console.log('\n=== LATEST ASSISTANT REPLY ===');
console.log(`[${last.created_at.slice(0, 19)}]`, grabText(last));
