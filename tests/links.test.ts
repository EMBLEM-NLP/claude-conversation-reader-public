/**
 * @file links.test.ts
 * @description Unit tests for the centralized Claude.ai URL builder
 * @version 1.0.0
 * @created 2026-04-26T15:14:56Z
 * @lastUpdated 2026-04-26T15:14:56Z
 */
import { describe, it, expect } from 'vitest';
import { CLAUDE_BASE, conversationUrl, projectUrl } from '../src/utils/links.js';

describe('links', () => {
  describe('CLAUDE_BASE', () => {
    it('is the canonical base URL', () => {
      expect(CLAUDE_BASE).toBe('https://claude.ai');
    });
  });

  describe('conversationUrl', () => {
    it('builds a /chat/ URL', () => {
      expect(conversationUrl('abc-123')).toBe('https://claude.ai/chat/abc-123');
    });

    it('handles full UUIDs', () => {
      expect(conversationUrl('54db5ad6-e91b-4fd5-9650-c6ee77acfc30')).toBe(
        'https://claude.ai/chat/54db5ad6-e91b-4fd5-9650-c6ee77acfc30',
      );
    });
  });

  describe('projectUrl', () => {
    it('builds a /project/ URL', () => {
      expect(projectUrl('proj-456')).toBe('https://claude.ai/project/proj-456');
    });

    it('handles full UUIDs', () => {
      expect(projectUrl('fb56aa22-37a8-4633-825c-6dd1c91f4db5')).toBe(
        'https://claude.ai/project/fb56aa22-37a8-4633-825c-6dd1c91f4db5',
      );
    });
  });
});
