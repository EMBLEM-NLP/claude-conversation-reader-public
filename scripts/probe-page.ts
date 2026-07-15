/**
 * Probe the rendered page at claude.ai/code/<sessionId>: report final URL after
 * any redirect, page title, visible body text snippet, and write a screenshot.
 * Usage: npx tsx scripts/probe-page.ts <sessionIdOrUrl>
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { loadSession } from '../src/auth/session.js';
import type { CookieEntry } from '../src/types.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npx tsx scripts/probe-page.ts <sessionIdOrUrl>');
  process.exit(1);
}
const m = arg.match(/(session_[A-Za-z0-9]+)/);
const sessionId = m ? m[1] : (arg.startsWith('session_') ? arg : `session_${arg}`);
const url = `https://claude.ai/code/${sessionId}`;

const session = await loadSession();
const browser = await chromium.launch({
  headless: false,
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
  await context.addCookies(session.raw.map((c: CookieEntry) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
  })));

  const page = await context.newPage();

  const wsConnections: Array<{ url: string; framesSent: number; framesRecv: number }> = [];
  page.on('websocket', (ws) => {
    const entry = { url: ws.url(), framesSent: 0, framesRecv: 0 };
    wsConnections.push(entry);
    ws.on('framesent', () => entry.framesSent++);
    ws.on('framereceived', () => entry.framesRecv++);
  });

  console.log(`Navigating to ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    console.warn(`goto warning: ${(err as Error).message}`);
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch {
    /* ok */
  }
  await page.waitForTimeout(3000);

  const finalUrl = page.url();
  const title = await page.title();
  const bodyText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 3000);
  const h1Text = await page.evaluate(() => Array.from(document.querySelectorAll('h1,h2')).map((el) => (el as HTMLElement).innerText).join(' | '));

  const screenshotPath = `probe-${sessionId}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });

  console.log('\n=== PAGE PROBE RESULT ===');
  console.log('Requested URL : ' + url);
  console.log('Final URL     : ' + finalUrl);
  console.log('Redirected?   : ' + (finalUrl !== url ? 'YES' : 'no'));
  console.log('Title         : ' + title);
  console.log('H1/H2         : ' + h1Text);
  console.log('Screenshot    : ' + screenshotPath);
  console.log('WebSocket conns: ' + wsConnections.length);
  for (const ws of wsConnections) {
    console.log(`  - ${ws.url}  (sent=${ws.framesSent}, recv=${ws.framesRecv})`);
  }
  console.log('\n--- Visible text (first 3000 chars) ---');
  console.log(bodyText);
  console.log('--- end ---\n');

  await writeFile(`probe-${sessionId}.json`, JSON.stringify({
    requested: url, finalUrl, redirected: finalUrl !== url,
    title, h1Text, wsConnections, bodyText,
  }, null, 2), 'utf-8');
} finally {
  await browser.close();
}
