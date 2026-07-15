/**
 * @file discover-code-api.ts
 * @description Reverse-engineer the claude.ai/code/<session_id> web viewer's API surface by loading a saved CCR session into Playwright, navigating to a session page, and capturing every request/response that matches a URL filter. Output is a JSON dump plus a templatized summary suitable for modeling new ClaudeApiClient methods.
 * @version 1.1.0
 * @created 2026-05-27T16:59:35Z
 * @lastUpdated 2026-05-27T17:30:00Z
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { loadSession } from './session.js';
import type { SessionCookies, CookieEntry } from '../types.js';

const CLAUDE_CODE_URL_PREFIX = 'https://claude.ai/code/';
const DEFAULT_FILTER = 'claude.ai/api';
const DEFAULT_IDLE_TIMEOUT_MS = 8000;
const STATIC_ASSET_PATTERN = /\.(png|jpg|jpeg|webp|svg|ico|css|woff2?|ttf|otf|js\.map|mp4|map)(\?|$)/i;
const MAX_BODY_BYTES = 200_000;

export interface DiscoverOptions {
  headed?: boolean;
  filter?: string;
  outputPath?: string;
  idleTimeoutMs?: number;
  includeStatic?: boolean;
  dwellMs?: number;
}

export interface CapturedExchange {
  timestamp: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  postData: string | null;
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    contentType: string;
    body: string | null;
    bodyError?: string;
  } | null;
}

export interface EndpointSummary {
  method: string;
  template: string;
  count: number;
  sampleStatus: number;
  sampleContentType: string;
}

export interface WebSocketCapture {
  url: string;
  openedAt: string;
  closedAt: string | null;
  framesSent: number;
  framesReceived: number;
  sampleFrames: Array<{ direction: 'sent' | 'recv'; payload: string; at: string }>;
}

export interface PageState {
  requestedUrl: string;
  finalUrl: string;
  redirected: boolean;
  title: string;
  bodyTextSnippet: string;
  consoleErrors: string[];
  pageErrors: string[];
}

export interface DiscoveryResult {
  metadata: {
    sessionId: string;
    pageUrl: string;
    capturedAt: string;
    filter: string;
    totalExchanges: number;
  };
  pageState: PageState;
  summary: EndpointSummary[];
  exchanges: CapturedExchange[];
  websockets: WebSocketCapture[];
}

// Accept any of: full URL, "session_<slug>", bare slug
export function normalizeSessionId(input: string): string {
  const fromUrl = input.match(/(session_[A-Za-z0-9]+)/);
  if (fromUrl) return fromUrl[1];
  return input.startsWith('session_') ? input : `session_${input}`;
}

function templatize(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .replace(/\/session_[A-Za-z0-9]{20,}/g, '/{session_id}')
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{uuid}')
      .replace(/\/[A-Z0-9]{20,}/g, '/{ulid}')
      .replace(/\/\d{6,}/g, '/{n}');
    return `${u.origin}${path}`;
  } catch {
    return url;
  }
}

function toPlaywrightCookies(session: SessionCookies): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'None' | 'Strict';
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

export async function discoverCodeApi(
  sessionInput: string,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const sessionId = normalizeSessionId(sessionInput);
  const pageUrl = `${CLAUDE_CODE_URL_PREFIX}${sessionId}`;
  const filter = options.filter ?? DEFAULT_FILTER;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const dwellMs = options.dwellMs ?? 2000;
  const headed = options.headed ?? true;
  const includeStatic = options.includeStatic ?? false;

  const session = await loadSession();

  const exchanges: CapturedExchange[] = [];
  const websockets: WebSocketCapture[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let finalUrl = pageUrl;
  let title = '';
  let bodyTextSnippet = '';

  const browser = await chromium.launch({
    headless: !headed,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await context.addCookies(toPlaywrightCookies(session));

    const page = await context.newPage();

    const shouldCapture = (url: string): boolean => {
      if (!url.includes(filter)) return false;
      if (!includeStatic && STATIC_ASSET_PATTERN.test(url)) return false;
      return true;
    };

    page.on('websocket', (ws) => {
      const url = ws.url();
      if (filter && !url.includes(filter) && !url.startsWith('wss://')) {
        // Always capture WS even if filter is narrow — they're high-signal
      }
      const entry: WebSocketCapture = {
        url,
        openedAt: new Date().toISOString(),
        closedAt: null,
        framesSent: 0,
        framesReceived: 0,
        sampleFrames: [],
      };
      websockets.push(entry);
      ws.on('framesent', (payload) => {
        entry.framesSent++;
        if (entry.sampleFrames.length < 5) {
          const text = typeof payload.payload === 'string' ? payload.payload : '[binary]';
          entry.sampleFrames.push({ direction: 'sent', payload: text.slice(0, 500), at: new Date().toISOString() });
        }
      });
      ws.on('framereceived', (payload) => {
        entry.framesReceived++;
        if (entry.sampleFrames.length < 10) {
          const text = typeof payload.payload === 'string' ? payload.payload : '[binary]';
          entry.sampleFrames.push({ direction: 'recv', payload: text.slice(0, 500), at: new Date().toISOString() });
        }
      });
      ws.on('close', () => {
        entry.closedAt = new Date().toISOString();
      });
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    page.on('request', (req) => {
      const url = req.url();
      if (!shouldCapture(url)) return;
      exchanges.push({
        timestamp: new Date().toISOString(),
        url,
        method: req.method(),
        requestHeaders: req.headers(),
        postData: req.postData(),
        response: null,
      });
    });

    page.on('response', async (resp) => {
      const url = resp.url();
      if (!shouldCapture(url)) return;

      const headers = resp.headers();
      const contentType = headers['content-type'] ?? '';
      let body: string | null = null;
      let bodyError: string | undefined;

      try {
        const textLike =
          contentType.includes('json') ||
          contentType.startsWith('text/') ||
          contentType.includes('event-stream') ||
          contentType === '';
        if (textLike) {
          body = await resp.text();
          if (body.length > MAX_BODY_BYTES) {
            body = body.slice(0, MAX_BODY_BYTES) + '\n…[truncated]';
          }
        } else {
          bodyError = `non-text content-type: ${contentType}`;
        }
      } catch (err) {
        bodyError = (err as Error).message;
      }

      // Match the most recent un-resolved request with the same URL + method.
      // Reverse-scan is O(n) per response but n is small for a single page load.
      const reqMethod = resp.request().method();
      for (let i = exchanges.length - 1; i >= 0; i--) {
        const ex = exchanges[i];
        if (ex.url === url && ex.method === reqMethod && ex.response === null) {
          ex.response = {
            status: resp.status(),
            statusText: resp.statusText(),
            headers,
            contentType,
            body,
            ...(bodyError ? { bodyError } : {}),
          };
          break;
        }
      }
    });

    console.log(`Navigating to ${pageUrl}`);
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
      console.warn(`Navigation warning (continuing to capture): ${(err as Error).message}`);
    }
    await page.bringToFront();

    // Let lazy-loaded API calls fire — networkidle plus a small dwell catches
    // sessions that poll for events after the initial render.
    try {
      await page.waitForLoadState('networkidle', { timeout: idleTimeoutMs });
    } catch {
      // networkidle timeout is fine — capture whatever we have
    }
    await page.waitForTimeout(dwellMs);

    // Capture final page state before closing
    try {
      finalUrl = page.url();
      title = await page.title();
      bodyTextSnippet = (await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 3000);
    } catch (err) {
      pageErrors.push(`page-state-capture: ${(err as Error).message}`);
    }
  } finally {
    await browser.close();
  }

  // Build summary: group by (method, templatized URL)
  const summaryMap = new Map<string, EndpointSummary>();
  for (const x of exchanges) {
    const tpl = templatize(x.url);
    const key = `${x.method} ${tpl}`;
    const existing = summaryMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      summaryMap.set(key, {
        method: x.method,
        template: tpl,
        count: 1,
        sampleStatus: x.response?.status ?? 0,
        sampleContentType: x.response?.contentType ?? '',
      });
    }
  }
  const summary = [...summaryMap.values()].sort((a, b) => b.count - a.count);

  const result: DiscoveryResult = {
    metadata: {
      sessionId,
      pageUrl,
      capturedAt: new Date().toISOString(),
      filter,
      totalExchanges: exchanges.length,
    },
    pageState: {
      requestedUrl: pageUrl,
      finalUrl,
      redirected: finalUrl !== pageUrl,
      title,
      bodyTextSnippet,
      consoleErrors,
      pageErrors,
    },
    summary,
    exchanges,
    websockets,
  };

  if (options.outputPath) {
    await writeFile(options.outputPath, JSON.stringify(result, null, 2), 'utf-8');
  }

  return result;
}
