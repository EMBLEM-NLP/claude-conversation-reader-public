/**
 * Probe endpoint shapes for claude.ai/code session IDs
 * Usage: npx tsx scripts/probe-code-session.ts <sessionId>
 * Example: npx tsx scripts/probe-code-session.ts session_01XoVKGPYCNUT4RZsb3oB4vP
 */
import { loadSession } from '../src/auth/session.js';
import { createClient } from '../src/api/client.js';

const raw = process.argv[2] ?? 'session_01XoVKGPYCNUT4RZsb3oB4vP';
// Accept both "session_01XYZ" and bare "01XYZ"
const bareId = raw.startsWith('session_') ? raw.slice('session_'.length) : raw;

const session = await loadSession();
const client = createClient(session);
const orgs = await client.getOrganizations();
const orgId = orgs[0].uuid;

const h: Record<string, string> = {
  Cookie: session.raw.map((c) => `${c.name}=${c.value}`).join('; '),
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

const BASE = 'https://claude.ai/api';
const ORG = `${BASE}/organizations/${orgId}`;

const candidates = [
  // Standard chat variants
  `${ORG}/chat_conversations/session_${bareId}`,
  `${ORG}/chat_conversations/${bareId}`,
  `${ORG}/chat_conversations/${bareId}?tree=True&rendering_mode=messages&render_all_tools=true`,
  // Code-session specific
  `${ORG}/code_sessions/${bareId}`,
  `${ORG}/code_sessions/session_${bareId}`,
  `${ORG}/sessions/${bareId}`,
  `${BASE}/sessions/${bareId}`,
  `${BASE}/code/sessions/${bareId}`,
  `${BASE}/code_sessions/${bareId}`,
  // Claude Code specific
  `${ORG}/claude_code/sessions/${bareId}`,
  `${BASE}/claude_code/sessions/${bareId}`,
];

console.log(`\nOrg:      ${orgId}`);
console.log(`Bare ID:  ${bareId}`);
console.log(`Full ID:  session_${bareId}\n`);
console.log('─'.repeat(70));

for (const url of candidates) {
  const r = await fetch(url, { headers: h });
  const body = await r.text();
  const preview = body.slice(0, 200).replace(/\s+/g, ' ');
  const status = r.status;
  const label = status === 200 ? '✓' : status === 404 ? '·' : '!';
  console.log(`${label} ${status}  ${url.replace(BASE, '')}`);
  if (status !== 404) {
    console.log(`       ${preview}\n`);
  }
}

console.log('─'.repeat(70));
console.log('\nLegend: ✓ = success  · = not found  ! = other error (interesting!)');
