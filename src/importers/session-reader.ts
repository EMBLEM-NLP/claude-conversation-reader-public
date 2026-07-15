/**
 * @file session-reader.ts
 * @description Read local Claude Code JSONL session files into LinearConversation format.
 *              Supports path-based and session-ID-based lookup, tree-walk branch resolution,
 *              optional tool-call and thinking display, and glob-search under ~/.claude/projects/.
 * @version 1.0.0
 * @created 2026-05-26T22:22:52Z
 * @lastUpdated 2026-05-26T22:22:52Z
 */

import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import type { LinearConversation, LinearMessage } from '../types.js';

// ── Raw JSONL shapes ─────────────────────────────────────────────

interface RawContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface RawMessage {
  role?: 'user' | 'assistant';
  content?: string | RawContentBlock[];
  model?: string;
  id?: string;
  stop_reason?: string;
}

interface RawEntry {
  type: string;
  uuid: string;
  parentUuid?: string;
  timestamp: string;
  message: RawMessage;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
}

// ── Public options ───────────────────────────────────────────────

export interface ReadSessionOptions {
  /** Include tool_use blocks as [Tool: name] lines (default: false) */
  showTools?: boolean;
  /** Include thinking blocks as [Thinking: ...] lines (default: false) */
  showThinking?: boolean;
  /** Max messages to include (default: unlimited) */
  limit?: number;
}

// ── Core reader ──────────────────────────────────────────────────

/**
 * Parse a JSONL session file and return a LinearConversation.
 * Handles multi-branch sessions by following the latest child at each node
 * (same strategy as extractors/conversation.ts).
 */
export async function readLocalSession(
  filePath: string,
  options: ReadSessionOptions = {},
): Promise<LinearConversation> {
  const { showTools = false, showThinking = false, limit } = options;

  // ── 1. Stream-parse JSONL ──────────────────────────────────────
  const entries: RawEntry[] = [];
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed) as RawEntry;
        // Keep only message-bearing entry types
        if (obj.type === 'user' || obj.type === 'assistant') {
          entries.push(obj);
        }
      } catch {
        // skip malformed lines
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  if (entries.length === 0) {
    return emptySession(filePath);
  }

  // ── 2. Build tree structures ───────────────────────────────────
  const byUuid = new Map<string, RawEntry>();
  const childrenOf = new Map<string, string[]>(); // parentUuid → child uuids

  for (const e of entries) {
    byUuid.set(e.uuid, e);
    if (e.parentUuid) {
      const siblings = childrenOf.get(e.parentUuid) ?? [];
      siblings.push(e.uuid);
      childrenOf.set(e.parentUuid, siblings);
    }
  }

  // Roots: entries whose parentUuid is absent or not a user/assistant entry
  const roots = entries.filter((e) => !e.parentUuid || !byUuid.has(e.parentUuid));

  // ── 3. Walk primary branch (last child = most recent = "kept" branch) ──
  const linear: LinearMessage[] = [];
  const visited = new Set<string>();

  function walk(uuid: string): void {
    if (visited.has(uuid)) return;
    visited.add(uuid);

    const entry = byUuid.get(uuid);
    if (!entry) return;

    const text = extractText(entry, showTools, showThinking);
    if (text) {
      linear.push({
        role: entry.message.role === 'assistant' ? 'assistant' : 'human',
        text,
        timestamp: entry.timestamp,
        uuid: entry.uuid,
      });
    }

    // Follow the last (most-recent) child
    const children = childrenOf.get(uuid) ?? [];
    if (children.length > 0) {
      const sorted = [...children].sort((a, b) => {
        const ta = byUuid.get(a)?.timestamp ?? '';
        const tb = byUuid.get(b)?.timestamp ?? '';
        return ta.localeCompare(tb);
      });
      walk(sorted[sorted.length - 1]);
    }
  }

  if (roots.length > 0) {
    walk(roots[0].uuid);
  }

  // Fallback: if tree-walk recovered <50% of entries, fall back to chronological
  const usedLinear =
    linear.length >= entries.length * 0.5 || entries.length <= 2
      ? linear
      : entries
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .flatMap((e) => {
            const text = extractText(e, showTools, showThinking);
            if (!text) return [];
            return [
              {
                role: (e.message.role === 'assistant' ? 'assistant' : 'human') as 'human' | 'assistant',
                text,
                timestamp: e.timestamp,
                uuid: e.uuid,
              },
            ];
          });

  // ── 4. Apply limit ─────────────────────────────────────────────
  const messages = limit !== undefined ? usedLinear.slice(0, limit) : usedLinear;

  // ── 5. Derive session metadata ─────────────────────────────────
  const sessionId = entries[0]?.sessionId ?? deriveSessionId(filePath);
  const firstUserMsg = usedLinear.find((m) => m.role === 'human')?.text ?? '';
  const title = deriveTitle(firstUserMsg, sessionId);
  const model = findModel(entries);
  const created_at = entries[0]?.timestamp ?? new Date().toISOString();

  return { uuid: sessionId, title, model, created_at, messages };
}

// ── Session file locator ─────────────────────────────────────────

/**
 * Find the JSONL file for a given session ID (UUID or partial UUID).
 * Searches recursively under ~/.claude/projects/.
 * Returns the absolute path or null if not found.
 */
export async function findLocalSessionFile(sessionId: string): Promise<string | null> {
  // Strip the "session_" prefix if present (Claude Code web IDs)
  const bareId = sessionId.startsWith('session_') ? sessionId.slice('session_'.length) : sessionId;

  const claudeDir = join(homedir(), '.claude', 'projects');

  try {
    await stat(claudeDir); // ensure it exists
  } catch {
    return null;
  }

  return searchDir(claudeDir, bareId);
}

async function searchDir(dir: string, sessionId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = join(dir, entry);

    // Direct match: exact filename with .jsonl extension (never match bare dirs)
    if (entry === `${sessionId}.jsonl`) {
      return full;
    }

    // Partial match: filename starts with the ID (covers truncated / prefix searches)
    if (entry.startsWith(sessionId) && entry.endsWith('.jsonl')) {
      return full;
    }

    // Recurse into subdirectories
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        const found = await searchDir(full, sessionId);
        if (found) return found;
      }
    } catch {
      // ignore stat errors
    }
  }

  return null;
}

/**
 * List all JSONL session files found under ~/.claude/projects/,
 * returning { path, sessionId, cwd } for each.
 */
export async function listLocalSessions(): Promise<Array<{ path: string; sessionId: string; cwd: string }>> {
  const claudeDir = join(homedir(), '.claude', 'projects');
  try {
    await stat(claudeDir);
  } catch {
    return [];
  }
  return collectJsonl(claudeDir);
}

async function collectJsonl(
  dir: string,
): Promise<Array<{ path: string; sessionId: string; cwd: string }>> {
  const result: Array<{ path: string; sessionId: string; cwd: string }> = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        const sub = await collectJsonl(full);
        result.push(...sub);
      } else if (entry.endsWith('.jsonl')) {
        // The parent directory name is the encoded CWD
        const encodedCwd = dir.split(/[\\/]/).pop() ?? '';
        const cwd = encodedCwd.replace(/--/g, '/').replace(/^\//, '');
        result.push({
          path: full,
          sessionId: entry.replace('.jsonl', ''),
          cwd,
        });
      }
    } catch {
      // skip
    }
  }

  return result;
}

// ── Text extraction helpers ──────────────────────────────────────

function extractText(entry: RawEntry, showTools: boolean, showThinking: boolean): string {
  const { message } = entry;

  // User messages: content is always a plain string
  if (entry.type === 'user') {
    if (typeof message.content === 'string') return message.content.trim();
    // Occasionally user content can be a block array (file attachments etc.)
    if (Array.isArray(message.content)) {
      return message.content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('\n')
        .trim();
    }
    return '';
  }

  // Assistant messages: content is an array of blocks
  if (Array.isArray(message.content)) {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text.trim());
      } else if (block.type === 'thinking' && showThinking && block.thinking) {
        parts.push(`[Thinking]\n${block.thinking.trim()}\n[/Thinking]`);
      } else if (block.type === 'tool_use' && showTools && block.name) {
        const inputStr = block.input ? JSON.stringify(block.input, null, 2) : '';
        parts.push(`[Tool: ${block.name}${inputStr ? `\n${inputStr}` : ''}]`);
      }
    }
    return parts.join('\n\n').trim();
  }

  return '';
}

function deriveTitle(firstUserText: string, sessionId: string): string {
  if (!firstUserText) return `Session ${sessionId.slice(0, 8)}`;
  // Take first line, cap at 80 chars
  const firstLine = firstUserText.split('\n')[0].trim();
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
}

function deriveSessionId(filePath: string): string {
  // Extract UUID from file path
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace('.jsonl', '');
}

function findModel(entries: RawEntry[]): string | undefined {
  for (const e of entries) {
    if (e.type === 'assistant' && e.message.model) return e.message.model;
  }
  return undefined;
}

function emptySession(filePath: string): LinearConversation {
  const sessionId = deriveSessionId(filePath);
  return {
    uuid: sessionId,
    title: `Session ${sessionId.slice(0, 8)}`,
    created_at: new Date().toISOString(),
    messages: [],
  };
}
