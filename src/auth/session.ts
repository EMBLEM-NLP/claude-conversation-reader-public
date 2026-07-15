/**
 * @file session.ts
 * @description Session cookie persistence, validation, and cookie string import
 * @version 1.0.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-15T17:15:45Z
 */
import { readFile, writeFile, unlink, access, mkdir, constants } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import os from 'node:os';
import type { SessionCookies, SessionFile, CookieEntry } from '../types.js';

const SESSION_PATH = process.env.SESSION_PATH
  ? resolve(process.env.SESSION_PATH)
  : resolve(os.homedir(), '.ccr', 'session.json');

// Refuse to read/write sessions from inside the project directory tree.
// Backup tools (OneDrive, Dropbox) will exfil a plaintext session cookie if it lands here.
function assertSessionNotInProjectTree(sessionPath: string): void {
  const cwd = resolve(process.cwd());
  const resolved = resolve(sessionPath);
  if (resolved === cwd || resolved.startsWith(cwd + sep)) {
    throw new Error(
      `Refusing to load session from project directory: ${resolved}\n` +
      `Sessions must be stored outside the project tree to prevent accidental backup exfiltration.\n` +
      `Default location: ${resolve(os.homedir(), '.ccr', 'session.json')}\n` +
      `Fix: run \`ccr login\` or \`ccr login --cookie "..."\``,
    );
  }
}

export async function saveSession(cookies: SessionCookies): Promise<void> {
  assertSessionNotInProjectTree(SESSION_PATH);
  const sessionFile: SessionFile = {
    cookies,
    savedAt: new Date().toISOString(),
  };

  await mkdir(dirname(SESSION_PATH), { recursive: true });
  await writeFile(SESSION_PATH, JSON.stringify(sessionFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export async function loadSession(): Promise<SessionCookies> {
  assertSessionNotInProjectTree(SESSION_PATH);
  try {
    await access(SESSION_PATH, constants.R_OK);
  } catch {
    throw new Error('No session found. Run `ccr login` first.');
  }

  const raw = await readFile(SESSION_PATH, 'utf-8');
  const parsed: unknown = JSON.parse(raw);

  if (!isValidSessionFile(parsed)) {
    throw new Error('Invalid session file format. Run `ccr login` to re-authenticate.');
  }

  if (!isSessionFresh(parsed.cookies.raw)) {
    throw new Error('Session cookies have expired. Run `ccr login` to re-authenticate.');
  }

  return parsed.cookies;
}

export async function isSessionValid(): Promise<boolean> {
  try {
    await loadSession();
    return true;
  } catch {
    return false;
  }
}

export async function clearSession(): Promise<void> {
  try {
    await unlink(SESSION_PATH);
  } catch {
    // File doesn't exist — nothing to clear
  }
}

/**
 * Create a session from a raw Cookie header string (from browser DevTools).
 * Format: "name1=value1; name2=value2; ..."
 */
export async function saveSessionFromCookieString(cookieString: string): Promise<SessionCookies> {
  // Cookies whose real attributes are known to include httpOnly
  const HTTP_ONLY_COOKIES = new Set(['sessionKey', '__cf_bm', '__Host-session', '__ssid']);

  const pairs = cookieString.split(';').map((s) => s.trim()).filter(Boolean);
  const cookies: CookieEntry[] = pairs.map((pair) => {
    const eqIdx = pair.indexOf('=');
    const name = eqIdx > 0 ? pair.slice(0, eqIdx).trim() : pair.trim();
    const value = eqIdx > 0 ? pair.slice(eqIdx + 1).trim() : '';
    return {
      name,
      value,
      domain: '.claude.ai',
      path: '/',
      expires: -1, // unknown from a cookie header string; treat as session cookie
      httpOnly: HTTP_ONLY_COOKIES.has(name),
      secure: true,
      sameSite: 'Lax' as const,
    };
  });

  if (cookies.length === 0) {
    throw new Error('No cookies parsed from the provided string.');
  }

  const AUTH_COOKIE_NAMES = ['sessionKey', '__ssid', 'activitySessionId', 'anthropic-device-id'];
  const primaryCookie = cookies.find((c) => AUTH_COOKIE_NAMES.includes(c.name)) ?? cookies[0];

  const session: SessionCookies = {
    sessionKey: primaryCookie.value,
    raw: cookies,
  };

  await saveSession(session);
  return session;
}

// ── Type Guards ─────────────────────────────────────────────────

function isValidSessionFile(data: unknown): data is SessionFile {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;

  if (typeof obj.savedAt !== 'string') return false;
  if (typeof obj.cookies !== 'object' || obj.cookies === null) return false;

  const cookies = obj.cookies as Record<string, unknown>;
  return typeof cookies.sessionKey === 'string' && Array.isArray(cookies.raw);
}

function isSessionFresh(raw: CookieEntry[]): boolean {
  const now = Date.now() / 1000;

  // sessionKey is the primary auth credential — session is invalid without it
  const sessionKey = raw.find((c) => c.name === 'sessionKey');
  if (!sessionKey) return false;

  // If sessionKey carries an explicit expiry, enforce it strictly
  if (sessionKey.expires > 0 && sessionKey.expires <= now) return false;

  return true;
}
