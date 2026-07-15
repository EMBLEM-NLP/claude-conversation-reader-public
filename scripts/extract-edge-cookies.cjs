#!/usr/bin/env node
/**
 * Extract Claude.ai session cookies from Microsoft Edge via Chrome DevTools Protocol.
 * Closes Edge, restarts with --remote-debugging-port, connects via Playwright CDP,
 * extracts all cookies (including HttpOnly), saves session, leaves Edge running.
 *
 * @version 2.0.0
 * @created 2026-04-15T17:15:45Z
 * @lastUpdated 2026-04-15T21:10:12Z
 *
 * Usage: node scripts/extract-edge-cookies.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const SESSION_DIR = path.join(os.homedir(), '.ccr');
const SESSION_PATH = path.join(SESSION_DIR, 'session.json');
const CDP_PORT = 9222;
const EDGE_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data');

function getEdgePath() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'msedge.exe';
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function waitForCDP(maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const resp = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (resp.status === 200) return JSON.parse(resp.data);
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`CDP endpoint not ready after ${maxWait / 1000}s`);
}

async function main() {
  console.log('=== Edge Cookie Extraction via CDP ===\n');

  // Step 1: Kill existing Edge
  console.log('1. Closing Edge...');
  try {
    execSync('taskkill.exe /F /IM msedge.exe', { stdio: 'pipe' });
    await new Promise(r => setTimeout(r, 2000));
    console.log('   Edge closed.');
  } catch {
    console.log('   Edge was not running.');
  }

  // Step 2: Restart Edge with remote debugging
  const edgePath = getEdgePath();
  console.log('2. Starting Edge with remote debugging on port ' + CDP_PORT + '...');
  console.log('   Path: ' + edgePath);
  console.log('   Profile: ' + EDGE_USER_DATA);

  const edgeProc = spawn(edgePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${EDGE_USER_DATA}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://claude.ai',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  edgeProc.unref();

  // Step 3: Wait for CDP endpoint
  console.log('3. Waiting for CDP endpoint...');
  const version = await waitForCDP();
  console.log('   Connected! Edge ' + (version.Browser || 'unknown'));

  // Step 4: Connect via Playwright
  console.log('4. Connecting Playwright via CDP...');
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

  try {
    // Step 5: Extract cookies from all contexts
    console.log('5. Extracting cookies...');
    const contexts = browser.contexts();
    let allCookies = [];

    for (const ctx of contexts) {
      const cookies = await ctx.cookies('https://claude.ai');
      allCookies.push(...cookies);
    }

    // If no contexts have claude.ai cookies, try opening a page
    if (allCookies.length === 0) {
      console.log('   No cookies in existing contexts, opening claude.ai...');
      const ctx = contexts[0] || await browser.newContext();
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      allCookies = await ctx.cookies('https://claude.ai');
    }

    // Deduplicate by name
    const seen = new Set();
    const claudeCookies = allCookies
      .filter(c => c.domain.includes('claude.ai'))
      .filter(c => {
        if (seen.has(c.name)) return false;
        seen.add(c.name);
        return true;
      });

    console.log(`\n   Found ${claudeCookies.length} Claude.ai cookies:`);
    for (const c of claudeCookies) {
      const httpOnly = c.httpOnly ? ' [HttpOnly]' : '';
      const preview = c.value.length > 30 ? c.value.slice(0, 30) + '...' : c.value;
      console.log(`   ${c.name}${httpOnly}: ${preview}`);
    }

    if (claudeCookies.length === 0) {
      console.error('\nNo Claude.ai cookies found. Are you logged in?');
      process.exit(1);
    }

    // Check for sessionKey
    const hasSessionKey = claudeCookies.some(c => c.name === 'sessionKey');
    if (!hasSessionKey) {
      console.warn('\n   WARNING: No sessionKey cookie found. You may not be logged in.');
    }

    // Step 6: Save session
    const cookies = claudeCookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite || 'Lax',
    }));

    const AUTH_COOKIE_NAMES = ['sessionKey', '__ssid', 'activitySessionId', 'anthropic-device-id'];
    const primaryCookie = cookies.find(c => AUTH_COOKIE_NAMES.includes(c.name)) || cookies[0];

    const session = {
      cookies: {
        sessionKey: primaryCookie.value,
        raw: cookies,
      },
      savedAt: new Date().toISOString(),
    };

    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });

    console.log(`\n6. Session saved to ${SESSION_PATH}`);
    console.log(`   Cookies: ${cookies.length} | Primary: ${primaryCookie.name} | HttpOnly: ${cookies.filter(c => c.httpOnly).length}`);
  } finally {
    // Disconnect but leave Edge running
    await browser.close();
    console.log('\n   Disconnected from Edge (Edge remains open).');
  }
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
