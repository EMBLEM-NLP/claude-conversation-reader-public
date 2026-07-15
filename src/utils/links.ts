/**
 * @file links.ts
 * @description Centralized Claude.ai URL builders — single source of truth for all link construction
 * @version 1.1.0
 * @created 2026-04-26T15:14:56Z
 * @lastUpdated 2026-05-27T18:30:00Z
 */

export const CLAUDE_BASE = 'https://claude.ai';

// Web-chat conversations use UUIDs and live at /chat/<uuid>.
// Code sessions use ULID-style IDs prefixed with "session_" and live at /code/<id>.
export const conversationUrl = (id: string): string =>
  id.startsWith('session_')
    ? `${CLAUDE_BASE}/code/${id}`
    : `${CLAUDE_BASE}/chat/${id}`;

export const projectUrl = (uuid: string): string => `${CLAUDE_BASE}/project/${uuid}`;
export const projectConversationUrl = (projectUuid: string, convUuid: string): string =>
  `${CLAUDE_BASE}/project/${projectUuid}/chat/${convUuid}`;
