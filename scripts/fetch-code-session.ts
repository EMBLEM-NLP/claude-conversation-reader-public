/**
 * Fetch a Claude Code session via /v1/sessions/<id> endpoints, using Playwright's
 * APIRequestContext so Cloudflare's bot management lets us through.
 *
 * Usage: npx tsx scripts/fetch-code-session.ts <sessionIdOrUrl>
 */
import { chromium, request as pwRequest } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { loadSession } from '../src/auth/session.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npx tsx scripts/fetch-code-session.ts <sessionIdOrUrl>');
  process.exit(1);
}
const m = arg.match(/(session_[A-Za-z0-9]+)/);
const sessionId = m ? m[1] : (arg.startsWith('session_') ? arg : `session_${arg}`);

const session = await loadSession();

// Build a fresh APIRequestContext with the saved cookies — Playwright's request
// stack uses the same TLS/HTTP fingerprint as a real Chromium, which passes
// Cloudflare bot management where node:fetch gets a JS challenge.
const apiContext = await pwRequest.newContext({
  baseURL: 'https://claude.ai',
  extraHTTPHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'anthropic-client-platform': 'web_claude_ai',
    Accept: 'application/json',
  },
});

// Inject cookies
await apiContext.storageState(); // ensure context is initialized
const cookies = session.raw.map((c) => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  expires: c.expires,
  httpOnly: c.httpOnly,
  secure: c.secure,
  sameSite: c.sameSite as 'Lax' | 'None' | 'Strict',
}));
// APIRequestContext doesn't have addCookies — use a fresh BrowserContext instead
await apiContext.dispose();

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await ctx.addCookies(cookies);

  // Warm up Cloudflare by loading a claude.ai page first
  const warmup = await ctx.newPage();
  await warmup.goto('https://claude.ai/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await warmup.close();

  // Resolve org UUID
  const orgsResp = await ctx.request.get('https://claude.ai/api/organizations');
  if (!orgsResp.ok()) {
    console.error('Failed to list orgs:', orgsResp.status(), await orgsResp.text());
    process.exit(1);
  }
  const orgs = (await orgsResp.json()) as Array<{ uuid: string; name?: string }>;
  const orgId = orgs[0].uuid;
  console.log(`Using org: ${orgId} (${orgs[0].name ?? ''})`);

  const sharedHeaders = {
    'anthropic-version': '2023-06-01',
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-feature': 'ccr',
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgId,
    Referer: `https://claude.ai/code/${sessionId}`,
  };

  console.log(`\nGET /v1/sessions/${sessionId}`);
  const metaResp = await ctx.request.get(`https://claude.ai/v1/sessions/${sessionId}`, { headers: sharedHeaders });
  console.log(`  → ${metaResp.status()}`);
  if (!metaResp.ok()) {
    console.error('  body:', (await metaResp.text()).slice(0, 500));
    process.exit(1);
  }
  const meta = await metaResp.json();

  console.log(`GET /v1/sessions/${sessionId}/events?limit=1000`);
  const eventsResp = await ctx.request.get(`https://claude.ai/v1/sessions/${sessionId}/events?limit=1000`, { headers: sharedHeaders });
  console.log(`  → ${eventsResp.status()}`);
  const events = eventsResp.ok() ? await eventsResp.json() : { error: await eventsResp.text() };

  console.log(`GET /v1/sessions/${sessionId}/share-status`);
  const shareResp = await ctx.request.get(`https://claude.ai/v1/sessions/${sessionId}/share-status`, { headers: sharedHeaders });
  console.log(`  → ${shareResp.status()}`);
  const share = shareResp.ok() ? await shareResp.json() : { error: await shareResp.text() };

  const out = `fetched-${sessionId}.json`;
  await writeFile(out, JSON.stringify({ meta, share, events }, null, 2), 'utf-8');
  console.log(`\nWrote ${out}`);

  const m2 = meta as { id: string; title: string; session_status: string; session_context: { model?: string; cwd?: string }; created_at: string; updated_at: string };
  console.log('\n=== SESSION ===');
  console.log(`  id        : ${m2.id}`);
  console.log(`  title     : ${m2.title}`);
  console.log(`  status    : ${m2.session_status}`);
  console.log(`  model     : ${m2.session_context?.model ?? '(none)'}`);
  console.log(`  cwd       : ${m2.session_context?.cwd ?? '(none)'}`);
  console.log(`  created   : ${m2.created_at}`);
  console.log(`  updated   : ${m2.updated_at}`);

  const ev = events as { data?: unknown[]; events?: unknown[]; items?: unknown[]; results?: unknown[] };
  const list = ev.data ?? ev.events ?? ev.items ?? ev.results ?? [];
  console.log(`\n=== EVENTS: ${Array.isArray(list) ? list.length : 'unknown shape — keys: ' + Object.keys(events as object).join(', ')} ===`);
  if (Array.isArray(list) && list.length > 0) {
    const sample = list[0] as Record<string, unknown>;
    console.log('Top-level keys on event[0]:', Object.keys(sample));
    console.log('event[0] sample (first 800 chars):', JSON.stringify(sample).slice(0, 800));
  }
} finally {
  await browser.close();
}
