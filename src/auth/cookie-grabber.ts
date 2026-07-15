/**
 * @file cookie-grabber.ts
 * @description Extract claude.ai session cookies from a running Chrome via CDP (no re-login needed).
 *              Optionally restarts Chrome with --remote-debugging-port if not already listening.
 * @version 1.1.0
 * @created 2026-05-27T00:00:00Z
 * @lastUpdated 2026-05-27T00:00:00Z
 */
import { chromium } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import { saveSession } from './session.js';
import type { SessionCookies, CookieEntry } from '../types.js';

const CLAUDE_DOMAIN = 'https://claude.ai';

export interface GrabCookieOptions {
  port?: number;
  /** Automatically close and relaunch Chrome with the debug flag if not already listening */
  autoRestart?: boolean;
  browser?: 'chrome' | 'edge';
  onProgress?: (msg: string) => void;
}

// ── CDP readiness check ──────────────────────────────────────────

function httpGet(url: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function waitForCDP(port: number, maxWaitMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/json/version`);
      if (res.status === 200) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`CDP endpoint on port ${port} not ready after ${maxWaitMs / 1000}s`);
}

// ── Browser path resolution ──────────────────────────────────────

function resolveBrowserPath(browser: 'chrome' | 'edge'): string {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] ?? '';

  const candidates: string[] = browser === 'chrome'
    ? [
        `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
        `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
        `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      ]
    : [
        `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${local}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ];

  const { existsSync } = require('fs') as typeof import('fs');
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return browser === 'chrome' ? 'chrome.exe' : 'msedge.exe';
}

function resolveUserDataDir(browser: 'chrome' | 'edge'): string {
  const local = process.env['LOCALAPPDATA'] ?? '';
  return browser === 'chrome'
    ? `${local}\\Google\\Chrome\\User Data`
    : `${local}\\Microsoft\\Edge\\User Data`;
}

function resolveProcessName(browser: 'chrome' | 'edge'): string {
  return browser === 'chrome' ? 'chrome.exe' : 'msedge.exe';
}

// ── Main export ──────────────────────────────────────────────────

/**
 * Extract claude.ai session cookies from Chrome or Edge via CDP.
 *
 * If `autoRestart` is true and no CDP endpoint is found on the port, the browser is
 * closed and relaunched with --remote-debugging-port=<port> preserving the user profile.
 */
export async function grabCookiesFromChrome(options: GrabCookieOptions = {}): Promise<SessionCookies> {
  const {
    port = 9222,
    autoRestart = false,
    browser: browserChoice = 'chrome',
    onProgress = () => {},
  } = options;

  // ── Step 1: Check if CDP is already listening ────────────────
  let cdpReady = false;
  try {
    await httpGet(`http://127.0.0.1:${port}/json/version`);
    cdpReady = true;
  } catch {
    // not listening
  }

  if (!cdpReady) {
    if (!autoRestart) {
      throw new Error(
        `Could not connect to ${browserChoice} on port ${port}.\n` +
        `${browserChoice} must be running with: --remote-debugging-port=${port}\n\n` +
        `Quick fix — re-run with --auto-restart to close and relaunch ${browserChoice} automatically:\n` +
        `  ccr grab-cookie --auto-restart\n\n` +
        `Or use the PowerShell helper:\n` +
        `  .\\scripts\\Restart-ChromeWithCDP.ps1`,
      );
    }

    // ── Step 2: Kill existing browser process ──────────────────
    const procName = resolveProcessName(browserChoice);
    onProgress(`Closing ${browserChoice}...`);
    try {
      execSync(`taskkill.exe /F /IM ${procName}`, { stdio: 'pipe' });
      await new Promise((r) => setTimeout(r, 2000));
      onProgress(`${browserChoice} closed.`);
    } catch {
      onProgress(`${browserChoice} was not running.`);
    }

    // ── Step 3: Relaunch with debug flag ───────────────────────
    const exePath = resolveBrowserPath(browserChoice);
    const userDataDir = resolveUserDataDir(browserChoice);
    onProgress(`Launching ${browserChoice} with --remote-debugging-port=${port}...`);

    const child = spawn(exePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      CLAUDE_DOMAIN,
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    // ── Step 4: Wait for CDP endpoint to be ready ──────────────
    onProgress(`Waiting for CDP endpoint on port ${port}...`);
    await waitForCDP(port);
    onProgress('CDP ready.');
  }

  // ── Step 5: Connect Playwright via CDP ────────────────────────
  onProgress('Connecting Playwright via CDP...');
  const pw = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

  try {
    const contexts = pw.contexts();
    if (contexts.length === 0) {
      throw new Error('No browser contexts found. Make sure a tab is open.');
    }

    // ── Step 6: Extract claude.ai cookies from all contexts ────
    onProgress('Extracting cookies...');
    const seen = new Set<string>();
    const allCookies: CookieEntry[] = [];

    for (const ctx of contexts) {
      let raw = await ctx.cookies([CLAUDE_DOMAIN]);

      // If no cookies yet (fresh launch) navigate and retry once
      if (raw.length === 0 && autoRestart) {
        onProgress('Navigating to claude.ai to load session...');
        const pages = ctx.pages();
        const page = pages[0] ?? await ctx.newPage();
        await page.goto(CLAUDE_DOMAIN, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await new Promise((r) => setTimeout(r, 2000));
        raw = await ctx.cookies([CLAUDE_DOMAIN]);
      }

      for (const c of raw) {
        if (!seen.has(c.name)) {
          seen.add(c.name);
          allCookies.push({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: (c.sameSite ?? 'Lax') as 'Lax' | 'None' | 'Strict',
          });
        }
      }
    }

    if (allCookies.length === 0) {
      throw new Error(
        `No cookies found for ${CLAUDE_DOMAIN}.\n` +
        `Make sure you are logged in to claude.ai before running this command.`,
      );
    }

    const AUTH_COOKIE_NAMES = ['sessionKey', '__ssid', 'activitySessionId', 'anthropic-device-id'];
    const primaryCookie = allCookies.find((c) => AUTH_COOKIE_NAMES.includes(c.name)) ?? allCookies[0];

    const session: SessionCookies = {
      sessionKey: primaryCookie.value,
      raw: allCookies,
    };

    await saveSession(session);
    return session;
  } finally {
    // Disconnect Playwright but leave the browser running
    await pw.close();
  }
}
