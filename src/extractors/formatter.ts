/**
 * @file formatter.ts
 * @description Output formatters: markdown, JSON, compact XML — for both
 * web-chat conversations and Claude Code sessions.
 * @version 1.1.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-05-27T19:00:00Z
 */
import type {
  LinearConversation,
  OutputFormat,
  CodeSession,
  CodeSessionEvent,
  CodeSessionContentBlock,
} from '../types.js';

export function formatConversation(
  conversation: LinearConversation,
  format: OutputFormat = 'markdown',
): string {
  switch (format) {
    case 'markdown':
      return formatMarkdown(conversation);
    case 'json':
      return JSON.stringify(conversation, null, 2);
    case 'compact':
      return formatCompact(conversation);
  }
}

function formatMarkdown(conv: LinearConversation): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push('');
  lines.push(`**ID:** ${conv.uuid}`);
  if (conv.model) lines.push(`**Model:** ${conv.model}`);
  lines.push(`**Created:** ${conv.created_at}`);
  lines.push(`**Messages:** ${conv.messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of conv.messages) {
    const label = msg.role === 'human' ? '**Human**' : '**Assistant**';
    const time = new Date(msg.timestamp).toLocaleString();
    lines.push(`### ${label} — ${time}`);
    lines.push('');
    lines.push(msg.text);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatCompact(conv: LinearConversation): string {
  const lines: string[] = [];
  lines.push(`<conversation title="${escapeXml(conv.title)}" id="${conv.uuid}">`);

  for (const msg of conv.messages) {
    lines.push(`<${msg.role}>`);
    lines.push(escapeXml(msg.text));
    lines.push(`</${msg.role}>`);
  }

  lines.push('</conversation>');
  return lines.join('\n');
}

// ── Claude Code Session formatters ───────────────────────────────

export function formatCodeSession(
  meta: CodeSession,
  events: CodeSessionEvent[],
  format: OutputFormat = 'markdown',
): string {
  switch (format) {
    case 'markdown':
      return formatCodeSessionMarkdown(meta, events);
    case 'json':
      return JSON.stringify({ meta, events }, null, 2);
    case 'compact':
      return formatCodeSessionCompact(meta, events);
  }
}

function blockToText(block: CodeSessionContentBlock): string {
  if (block.type === 'text') return block.text ?? '';
  if (block.type === 'thinking') return block.thinking ? `<thinking>${block.thinking}</thinking>` : '';
  if (block.type === 'tool_use') {
    const input = block.input ? ` ${JSON.stringify(block.input).slice(0, 300)}` : '';
    return `[tool_use:${block.name ?? '?'}]${input}`;
  }
  if (block.type === 'tool_result') {
    let inner = '';
    if (typeof block.content === 'string') {
      inner = block.content;
    } else if (Array.isArray(block.content)) {
      inner = (block.content as CodeSessionContentBlock[])
        .map((b) => b.text ?? '')
        .filter(Boolean)
        .join('\n');
    }
    return `[tool_result] ${inner.slice(0, 600)}`;
  }
  return '';
}

function messageBodyToText(content: string | CodeSessionContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map(blockToText).filter(Boolean).join('\n\n');
}

function formatCodeSessionMarkdown(meta: CodeSession, events: CodeSessionEvent[]): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title}`);
  lines.push('');
  lines.push(`**ID:** ${meta.id}`);
  if (meta.session_context?.model) lines.push(`**Model:** ${meta.session_context.model}`);
  if (meta.session_context?.cwd) lines.push(`**CWD:** \`${meta.session_context.cwd}\``);
  if (meta.session_status) lines.push(`**Status:** ${meta.session_status}`);
  lines.push(`**Created:** ${meta.created_at}`);
  lines.push(`**Updated:** ${meta.updated_at}`);
  lines.push(`**Events:** ${events.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  const messageEvents = events.filter(
    (e) => (e.type === 'user' || e.type === 'assistant') && e.message?.role,
  );

  for (const ev of messageEvents) {
    const role = ev.message?.role === 'user' ? '**Human**' : '**Assistant**';
    const time = ev.created_at;
    const synth = ev.isSynthetic ? ' _(synthetic)_' : '';
    lines.push(`### ${role} — ${time}${synth}`);
    lines.push('');
    const body = messageBodyToText(ev.message?.content);
    if (body) {
      lines.push(body);
    } else {
      lines.push('_(no body content)_');
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function formatCodeSessionCompact(meta: CodeSession, events: CodeSessionEvent[]): string {
  const lines: string[] = [];
  lines.push(
    `<code_session id="${meta.id}" title="${escapeXml(meta.title)}" model="${escapeXml(
      meta.session_context?.model ?? '',
    )}">`,
  );

  const messageEvents = events.filter(
    (e) => (e.type === 'user' || e.type === 'assistant') && e.message?.role,
  );

  for (const ev of messageEvents) {
    const role = ev.message?.role ?? 'unknown';
    const tag = role === 'user' ? 'human' : 'assistant';
    lines.push(`<${tag}>`);
    lines.push(escapeXml(messageBodyToText(ev.message?.content)));
    lines.push(`</${tag}>`);
  }

  lines.push('</code_session>');
  return lines.join('\n');
}
