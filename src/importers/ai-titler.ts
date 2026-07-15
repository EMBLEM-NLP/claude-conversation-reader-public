/**
 * @file ai-titler.ts
 * @description Generate descriptive conversation titles using Claude.ai's internal API
 *              via the existing session cookies — no separate API key required
 * @version 1.1.0
 * @created 2026-04-26T17:30:00Z
 * @lastUpdated 2026-04-26T18:02:12Z
 */
import type { LinearMessage, SessionCookies } from '../types.js';

const BASE_URL = 'https://claude.ai/api';
const MODEL = 'claude-haiku-4-5-20251001';

function buildHeaders(session: SessionCookies, accept = 'text/event-stream'): Record<string, string> {
  return {
    Cookie: session.raw.map((c) => `${c.name}=${c.value}`).join('; '),
    Accept: accept,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
}

function parseSseCompletion(sseText: string): string {
  let result = '';
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const obj = JSON.parse(line.slice(6)) as { type?: string; completion?: string; stop_reason?: string | null };
      if (obj.type === 'completion' && obj.completion && obj.stop_reason === null) {
        result += obj.completion;
      }
    } catch { /* ignore malformed SSE lines */ }
  }
  return result.replace(/^\s+/, '').trim();
}

export async function generateTitle(
  session: SessionCookies,
  orgId: string,
  messages: LinearMessage[],
): Promise<string> {
  const jsonHeaders = buildHeaders(session, 'application/json');
  const sseHeaders = buildHeaders(session);

  // Step 1: create a temporary conversation (deleted in finally)
  const createRes = await fetch(
    `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/chat_conversations`,
    { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'CCR-TITLE-GEN' }) },
  );
  if (!createRes.ok) throw new Error(`Could not create temp conversation: ${createRes.status}`);
  const { uuid: tempUuid } = (await createRes.json()) as { uuid: string };

  try {
    // Step 2: build a concise conversation sample (keep prompt short to avoid 413)
    const sample = messages
      .slice(0, 10)
      .map((m) => `${m.role === 'human' ? 'HUMAN' : 'ASSISTANT'}: ${m.text.slice(0, 300)}`)
      .join('\n\n');

    const prompt =
      `\n\nHuman: Here is a conversation:\n\n${sample}\n\n` +
      `Generate a concise, specific 5-8 word title for this conversation. ` +
      `Focus on the exact topic, equipment, or task — not generic words like "help" or "discussion". ` +
      `Reply with ONLY the title, no quotes, no trailing period.\n\nAssistant:`;

    // Step 3: POST /completion (returns SSE)
    const compRes = await fetch(
      `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/chat_conversations/${tempUuid}/completion`,
      {
        method: 'POST',
        headers: sseHeaders,
        body: JSON.stringify({
          prompt,
          model: MODEL,
          max_tokens_to_sample: 60,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          attachments: [],
          files: [],
        }),
      },
    );

    if (!compRes.ok) {
      const err = await compRes.text();
      throw new Error(`Completion failed (${compRes.status}): ${err.slice(0, 200)}`);
    }

    const sseText = await compRes.text();
    const raw = parseSseCompletion(sseText);
    if (!raw) throw new Error('Empty title returned from Claude.ai completion');

    return raw.replace(/^["'`]|["'`]$/g, '').replace(/\.$/, '').slice(0, 80);
  } finally {
    // Step 4: always delete the temp conversation
    await fetch(
      `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/chat_conversations/${tempUuid}`,
      { method: 'DELETE', headers: jsonHeaders },
    ).catch(() => { /* best-effort cleanup */ });
  }
}
