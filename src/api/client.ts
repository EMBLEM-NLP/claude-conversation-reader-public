/**
 * @file client.ts
 * @description Claude.ai internal API wrapper with rate limiting, DELETE, POST, and PATCH support
 * @version 1.1.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-26T19:58:07Z
 */
import type {
  SessionCookies,
  ClaudeApiClient,
  Organization,
  ConversationMeta,
  ConversationTree,
  ProjectMeta,
  ClaudeFile,
} from '../types.js';
import { AuthError, RateLimitError, ApiError } from './errors.js';

const BASE_URL = 'https://claude.ai/api';

// Per-orgId token bucket: 1 req/sec sustained, burst of 3.
// Keyed by orgId extracted from the request URL so different orgs don't share quota.
const TOKEN_BUCKETS = new Map<string, { tokens: number; lastRefill: number }>();
const BUCKET_CAPACITY = 3;
const REFILL_RATE_MS = 1000; // 1 token per second

function getOrgId(url: string): string {
  const m = url.match(/\/organizations\/([^/]+)/);
  return m ? m[1] : '__global__';
}

async function tokenBucketWait(orgId: string): Promise<void> {
  if (!TOKEN_BUCKETS.has(orgId)) {
    TOKEN_BUCKETS.set(orgId, { tokens: BUCKET_CAPACITY, lastRefill: Date.now() });
  }
  const bucket = TOKEN_BUCKETS.get(orgId)!;

  const now = Date.now();
  const newTokens = Math.floor((now - bucket.lastRefill) / REFILL_RATE_MS);
  if (newTokens > 0) {
    bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + newTokens);
    bucket.lastRefill = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens--;
    return;
  }
  // Wait for next refill
  await delay(REFILL_RATE_MS - (now - bucket.lastRefill) + Math.floor(Math.random() * 200));
  bucket.tokens = 0;
  bucket.lastRefill = Date.now();
}

async function rateLimitedFetch(
  url: string,
  headers: Record<string, string>,
  options?: { method?: string; body?: string },
): Promise<Response> {
  await tokenBucketWait(getOrgId(url));

  const MAX_RETRIES = 3;
  let attempt = 0;

  while (true) {
    const response = await fetch(url, {
      headers,
      method: options?.method ?? 'GET',
      body: options?.body,
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(response.status);
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
      if (attempt < MAX_RETRIES) {
        attempt++;
        const backoff = retryAfter * 1000 + Math.floor(Math.random() * 1000);
        await delay(backoff);
        await tokenBucketWait(getOrgId(url));
        continue;
      }
      throw new RateLimitError(retryAfter);
    }

    if (!response.ok) {
      if (attempt < MAX_RETRIES && response.status >= 500) {
        attempt++;
        await delay(Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 500));
        continue;
      }
      throw new ApiError(response.status, response.statusText);
    }

    return response;
  }
}

function buildHeaders(session: SessionCookies): Record<string, string> {
  return {
    Cookie: session.raw.map((c) => `${c.name}=${c.value}`).join('; '),
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  };
}

export function createClient(session: SessionCookies): ClaudeApiClient {
  const headers = buildHeaders(session);

  return {
    async getOrganizations(): Promise<Organization[]> {
      const url = `${BASE_URL}/organizations`;
      const response = await rateLimitedFetch(url, headers);
      const data = await response.json();
      // API may return an array directly or wrap it — handle both
      return Array.isArray(data) ? (data as Organization[]) : [];
    },

    async listConversations(orgId: string, projectUuid?: string): Promise<ConversationMeta[]> {
      let url = `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/chat_conversations`;
      if (projectUuid) url += `?project_uuid=${encodeURIComponent(projectUuid)}`;
      const response = await rateLimitedFetch(url, headers);
      const data = await response.json();
      return Array.isArray(data) ? (data as ConversationMeta[]) : [];
    },

    async getConversation(
      orgId: string,
      conversationId: string,
    ): Promise<ConversationTree> {
      const url = `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(conversationId)}?tree=True&rendering_mode=messages&render_all_tools=true`;
      const response = await rateLimitedFetch(url, headers);
      const data = (await response.json()) as ConversationTree;
      return data;
    },

    async deleteConversation(
      orgId: string,
      conversationId: string,
    ): Promise<void> {
      const url = `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(conversationId)}`;
      await rateLimitedFetch(url, headers, { method: 'DELETE' });
    },

    async listProjects(orgId: string): Promise<ProjectMeta[]> {
      const url = `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/projects`;
      const response = await rateLimitedFetch(url, headers);
      const data = await response.json();
      return Array.isArray(data) ? (data as ProjectMeta[]) : [];
    },

    async createProject(orgId: string, name: string, description?: string): Promise<ProjectMeta> {
      const url = `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/projects`;
      const body = JSON.stringify({ name, description: description ?? '' });
      const response = await rateLimitedFetch(url, headers, { method: 'POST', body });
      return response.json() as Promise<ProjectMeta>;
    },

    async moveConversationToProject(
      orgId: string,
      convId: string,
      projectUuid: string | null,
    ): Promise<ConversationMeta> {
      const url = `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(convId)}`;
      const body = JSON.stringify({ project_uuid: projectUuid });
      const response = await rateLimitedFetch(url, headers, { method: 'PUT', body });
      return response.json() as Promise<ConversationMeta>;
    },

    async listProjectConversations(orgId: string, projectUuid: string): Promise<ConversationMeta[]> {
      // Try the nested project route first — more correct REST scoping
      try {
        const url = `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectUuid)}/chat_conversations`;
        const response = await rateLimitedFetch(url, headers);
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) return data as ConversationMeta[];
      } catch { /* fall through */ }
      // Fallback: full list filtered client-side by project_uuid field
      const all = await this.listConversations(orgId);
      return all.filter((c) => c.project_uuid === projectUuid);
    },

    async renameConversation(orgId: string, convId: string, name: string): Promise<ConversationMeta> {
      const url = `${BASE_URL}/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(convId)}`;
      const body = JSON.stringify({ name });
      const response = await rateLimitedFetch(url, headers, { method: 'PUT', body });
      return response.json() as Promise<ConversationMeta>;
    },

    async downloadFile(file: ClaudeFile): Promise<{ buffer: Buffer; ext: string } | null> {
      let downloadUrl: string | null = null;
      let ext: string;

      if (file.file_kind === 'image' && file.preview_asset?.url) {
        downloadUrl = `https://claude.ai${file.preview_asset.url}`;
        ext = 'webp';
      } else if (file.file_kind === 'document' && file.document_asset?.url) {
        downloadUrl = `https://claude.ai${file.document_asset.url}`;
        ext = 'pdf';
      } else {
        return null; // blob (DOCX etc.) — not accessible via API
      }

      const response = await rateLimitedFetch(downloadUrl, headers);
      return { buffer: Buffer.from(await response.arrayBuffer()), ext };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
