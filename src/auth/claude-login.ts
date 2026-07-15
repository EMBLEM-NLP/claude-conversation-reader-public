/**
 * @file claude-login.ts
 * @description Playwright browser automation for Claude.ai login with Cloudflare bypass
 * @version 1.1.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-27T05:58:31Z
 */
import { chromium } from 'playwright';
import { join } from 'node:path';
import os from 'node:os';
import type { SessionCookies, CookieEntry, LoginOptions } from '../types.js';
import { saveSession } from './session.js';

const CLAUDE_LOGIN_URL = 'https://claude.ai/login';

export async function login(options: LoginOptions = {}): Promise<SessionCookies> {
  const browser = await chromium.launch({
    headless: !(options.headed ?? true),
    args: [
      '--window-size=1280,900',
      '--window-position=100,100',
      // Hide Playwright automation signals from Cloudflare bot detection
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      // Real Chrome 135 user agent — Playwright's default UA triggers Cloudflare
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    });

    // Spoof navigator.webdriver so Cloudflare can't detect automation via JS
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    // Step 1: Navigate to Claude.ai login
    console.log('Navigating to Claude.ai login...');
    await page.goto(CLAUDE_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

    // Force the browser window to the foreground
    await page.bringToFront();

    // Step 2: Wait for the user to complete authentication
    // Claude.ai uses email + verification code or Google SSO — both require human interaction
    console.log('Please complete the login in the browser window...');
    console.log('Waiting for authentication to complete (up to 10 min)...');

    // The true signal of successful auth is a 200 from /api/organizations.
    // Evasion techniques in use:
    //   1. --disable-blink-features=AutomationControlled (Chrome flag; update if Cloudflare adds new signals)
    //   2. navigator.webdriver spoofed to undefined via addInitScript (JS-level detection)
    //   3. Chrome 135 UA (update the version string when Cloudflare starts flagging it)
    // Timeout is capped at 90s — 600s hung silently on Cloudflare interstitial changes.
    const screenshotPath = join(os.homedir(), '.ccr', 'last-login-failure.png');
    try {
      await page.waitForResponse(
        (resp) =>
          resp.url().includes('claude.ai/api/organizations') && resp.status() === 200,
        { timeout: 90_000 },
      );
    } catch {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      throw new Error(
        'Login timed out after 90s waiting for Claude.ai authentication.\n' +
        `Screenshot saved to: ${screenshotPath}\n` +
        'Possible causes: Cloudflare challenge changed, slow network, or login not completed.\n' +
        'Check the screenshot to see what the browser is showing, then retry.',
      );
    }
    console.log('Authentication complete. Extracting session cookies...');

    // Step 3: Extract session cookies — all cookies are sent with every API request
    const rawCookies = await context.cookies('https://claude.ai');
    const cookies = mapCookies(rawCookies);

    if (cookies.length === 0) {
      throw new Error('Authentication failed: no cookies found for claude.ai after login.');
    }

    // Use the first available auth-like cookie as the primary key (all raw cookies are sent anyway)
    const AUTH_COOKIE_NAMES = ['sessionKey', '__ssid', 'activitySessionId', 'anthropic-device-id'];
    const primaryCookie = cookies.find((c) => AUTH_COOKIE_NAMES.includes(c.name)) ?? cookies[0];

    const session: SessionCookies = {
      sessionKey: primaryCookie.value,
      raw: cookies,
    };

    // Step 4: Persist session
    await saveSession(session);
    console.log('Session saved successfully.');

    return session;
  } finally {
    await browser.close();
  }
}

function mapCookies(
  playwrightCookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Lax' | 'None' | 'Strict';
  }>,
): CookieEntry[] {
  return playwrightCookies.map((c) => ({
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
