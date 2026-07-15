/**
 * @file code-session-client.ts
 * @description Typed client for claude.ai/v1/sessions/<id> endpoints. Uses a
 * Playwright BrowserContext request stack so Cloudflare bot management accepts
 * the requests — raw node:fetch trips the "Just a moment…" JS challenge.
 *
 * Required headers (discovered from claude.ai/code's own network traffic):
 *   anthropic-version: 2023-06-01
 *   anthropic-client-platform: web_claude_ai
 *   x-organization-uuid: <org>
 *   anthropic-beta: ccr-byoc-2025-07-29
 *
 * @version 1.0.0
 * @created 2026-05-27T18:45:00Z
 * @lastUpdated 2026-05-27T18:45:00Z
 */
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type {
  SessionCookies,
  CookieEntry,
  CodeSession,
  CodeSessionEvent,
  CodeSessionEventsResponse,
  CodeSessionShareStatus,
  CodeSessionClient,
} from '../types.js';

const BASE = 'https://claude.ai';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const REQUIRED_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-client-platform': 'web_claude_ai',
  'anthropic-client-feature': 'ccr',
  'anthropic-beta': 'ccr-byoc-2025-07-29',
} as const;

// Normalize "session_<slug>", bare slug, or full URL → canonical session_ ID.
export function normalizeCodeSessionId(input: string): string {
  const m = input.match(/(session_[A-Za-z0-9]+)/);
  if (m) return m[1];
  return input.startsWith('session_') ? input : `session_${input}`;
}

function toPlaywrightCookies(session: SessionCookies): Array<{
  name: string; value: string; domain: string; path: string;
  expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Lax' | 'None' | 'Strict';
}> {
  return session.raw.map((c: CookieEntry) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
}

export interface CreateCodeSessionClientOptions {
  /** Pre-resolved org UUID. If omitted, the client fetches it from /api/organizations on first use. */
  orgId?: string;
  /** Run the underlying browser headless (default: true). */
  headless?: boolean;
}

/**
 * Create a typed client for the Claude Code session API.
 *
 * The client owns a Playwright BrowserContext for the lifetime of its calls,
 * and must be closed with `client.close()` when done.
 */
export async function createCodeSessionClient(
  session: SessionCookies,
  options: CreateCodeSessionClientOptions = {},
): Promise<CodeSessionClient> {
  const browser: Browser = await chromium.launch({
    headless: options.headless ?? true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const ctx: BrowserContext = await browser.newContext({
    userAgent: USER_AGENT,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await ctx.addCookies(toPlaywrightCookies(session));

  // Warm up Cloudflare: a single page load on claude.ai/ refreshes __cf_bm
  // and primes the TLS fingerprint so subsequent ctx.request calls pass.
  const warmup = await ctx.newPage();
  await warmup.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await warmup.close();

  let cachedOrgId: string | undefined = options.orgId;

  async function getOrgId(): Promise<string> {
    if (cachedOrgId) return cachedOrgId;
    const r = await ctx.request.get(`${BASE}/api/organizations`);
    if (!r.ok()) {
      throw new Error(`Failed to list organizations: ${r.status()} ${r.statusText()}`);
    }
    const orgs = (await r.json()) as Array<{ uuid: string }>;
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error('No organizations found for this session.');
    }
    cachedOrgId = orgs[0].uuid;
    return cachedOrgId;
  }

  function headersFor(sessionId?: string): Record<string, string> {
    const h: Record<string, string> = { ...REQUIRED_HEADERS };
    if (sessionId) h.Referer = `${BASE}/code/${sessionId}`;
    return h;
  }

  async function get<T>(url: string, sessionId?: string): Promise<T> {
    const orgId = await getOrgId();
    const r = await ctx.request.get(url, {
      headers: { ...headersFor(sessionId), 'x-organization-uuid': orgId },
    });
    if (!r.ok()) {
      const body = await r.text();
      throw new Error(`GET ${url} → ${r.status()} ${r.statusText()}: ${body.slice(0, 500)}`);
    }
    return (await r.json()) as T;
  }

  return {
    async listCodeSessions(): Promise<CodeSession[]> {
      const data = await get<CodeSession[] | { data?: CodeSession[]; items?: CodeSession[] }>(
        `${BASE}/v1/sessions`,
      );
      if (Array.isArray(data)) return data;
      return data.data ?? data.items ?? [];
    },

    async getCodeSession(sessionId: string): Promise<CodeSession> {
      const id = normalizeCodeSessionId(sessionId);
      return get<CodeSession>(`${BASE}/v1/sessions/${id}`, id);
    },

    async getCodeSessionEvents(sessionId: string, limit = 1000): Promise<CodeSessionEvent[]> {
      const id = normalizeCodeSessionId(sessionId);
      const data = await get<CodeSessionEvent[] | CodeSessionEventsResponse>(
        `${BASE}/v1/sessions/${id}/events?limit=${limit}`,
        id,
      );
      if (Array.isArray(data)) return data;
      return data.data ?? data.events ?? data.items ?? [];
    },

    async getCodeSessionShareStatus(sessionId: string): Promise<CodeSessionShareStatus> {
      const id = normalizeCodeSessionId(sessionId);
      return get<CodeSessionShareStatus>(`${BASE}/v1/sessions/${id}/share-status`, id);
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };
}

/**
 * Convenience wrapper: open a client, fetch full session + events + share status,
 * and write the result to disk as the same JSON shape produced by
 * scripts/fetch-code-session.ts (so importCodeSession() can read it).
 */
export async function fetchAndDumpCodeSession(
  session: SessionCookies,
  sessionInput: string,
  outputPath: string,
  options: CreateCodeSessionClientOptions = {},
): Promise<{ outputPath: string; meta: CodeSession; eventCount: number }> {
  const { writeFile } = await import('node:fs/promises');
  const id = normalizeCodeSessionId(sessionInput);
  const client = await createCodeSessionClient(session, options);
  try {
    const meta = await client.getCodeSession(id);
    const events = await client.getCodeSessionEvents(id);
    let share: CodeSessionShareStatus | { error: string };
    try {
      share = await client.getCodeSessionShareStatus(id);
    } catch (err) {
      share = { error: (err as Error).message };
    }
    await writeFile(
      outputPath,
      JSON.stringify({ meta, share, events }, null, 2),
      'utf-8',
    );
    return { outputPath, meta, eventCount: events.length };
  } finally {
    await client.close();
  }
}
