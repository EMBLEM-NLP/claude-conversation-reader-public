/**
 * @file tools.ts
 * @description MCP tool definitions and handlers (33 tools: API + SQLite + profile + rename-local + graph + code-sessions)
 * IMPORTANT: Update CLAUDE.md line 40 and README.md line 204 whenever tools are added or removed.
 * @version 1.5.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-05-27T19:10:00Z
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import { loadSession } from '../auth/session.js';
import { login } from '../auth/claude-login.js';
import { createClient } from '../api/client.js';
import { AuthError } from '../api/errors.js';
import { flattenConversation } from '../extractors/conversation.js';
import { formatConversation, formatCodeSession } from '../extractors/formatter.js';
import { searchConversations } from '../extractors/search.js';
import { createCodeSessionClient, normalizeCodeSessionId } from '../api/code-session-client.js';
import {
  searchMessages, searchMessagesGrouped,
  searchThinking, searchThinkingGrouped,
  searchByToolName, searchByToolNameGrouped,
  searchContent, searchContentGrouped,
  type GroupedSearchResult,
} from '../importers/sqlite-search.js';
import { searchByEntity, searchByEntityGrouped } from '../importers/entity-search.js';
import { conversationUrl, projectUrl } from '../utils/links.js';
import {
  getMainBranch, getConversationBranches, getThread,
  getUntitledConversations, getEmptyConversations, getConversationStats,
  deleteConversationLocal, getFullStats,
} from '../importers/advanced-queries.js';
import { extractEntities } from '../importers/entity-extract.js';
import { profileConversations, getProfiles } from '../importers/conversation-profiler.js';
import { renameUntitled } from '../importers/conversation-renamer.js';
import {
  buildGraph, clusterGraph,
  queryGraph, getNeighbors, getCommunity, shortestPath,
  godNodes, surprisingConnections, suggestQuestions,
  toHtml,
} from '../graph/index.js';
import type { ClaudeApiClient, OutputFormat } from '../types.js';

const DEFAULT_DB = path.resolve('.ccr-import.sqlite');

function formatGroupedMcp(row: GroupedSearchResult): string {
  const proj = row.project_uuid
    ? `\nIn project: ${row.project_name || row.project_uuid.slice(0, 8)} — ${projectUrl(row.project_uuid)}`
    : '';
  const snips = row.top_snippets
    .map(s => `  [${s.created_at}] ${s.sender}: ${s.text.substring(0, 200)}`)
    .join('\n');
  return [
    `---`,
    `**${row.name}**  (${row.hit_count} hit${row.hit_count !== 1 ? 's' : ''})`,
    conversationUrl(row.conversation_uuid),
    `UUID: \`${row.conversation_uuid}\`${proj}`,
    snips,
  ].join('\n');
}

let cachedClient: ClaudeApiClient | null = null;
let cachedOrgId: string | null = null;

async function getClient(): Promise<{ client: ClaudeApiClient; orgId: string }> {
  if (cachedClient && cachedOrgId) {
    return { client: cachedClient, orgId: cachedOrgId };
  }

  try {
    const session = await loadSession();
    const client = createClient(session);
    const orgs = await client.getOrganizations();

    if (orgs.length === 0) {
      throw new Error('No organizations found. Ensure your session is valid.');
    }

    cachedClient = client;
    cachedOrgId = orgs[0].uuid;
    return { client, orgId: cachedOrgId };
  } catch (err) {
    if (err instanceof AuthError) {
      // Reset cache so next call re-authenticates
      resetClientCache();
      throw new Error(`auth_required: ${err.message} Run the claude_login tool to re-authenticate.`);
    }
    throw err;
  }
}

function resetClientCache(): void {
  cachedClient = null;
  cachedOrgId = null;
}

export function registerTools(server: McpServer): void {
  server.tool(
    'claude_login',
    'Authenticate with Claude.ai via browser. Opens a Playwright browser for the user to log in. Use when session has expired.',
    { headed: z.boolean().optional().describe('Open visible browser window (default: true for login)') },
    async ({ headed }) => {
      resetClientCache();
      await login({ headed: headed ?? true });
      return { content: [{ type: 'text', text: 'Login successful. Session saved.' }] };
    },
  );

  server.tool(
    'list_conversations',
    'List recent Claude.ai conversations. Returns titles, IDs, and dates.',
    {
      query: z.string().optional().describe('Filter conversations by title (case-insensitive substring match)'),
      limit: z.number().optional().describe('Maximum number of conversations to return (default: 20)'),
    },
    async ({ query, limit }) => {
      const { client, orgId } = await getClient();
      let conversations = await client.listConversations(orgId);

      conversations = searchConversations(conversations, {
        query,
        limit: limit ?? 20,
      });

      const text = conversations
        .map((c) => `- **${c.name}**\n  ${conversationUrl(c.uuid)}\n  UUID: \`${c.uuid}\`\n  Updated: ${c.updated_at}`)
        .join('\n');

      return {
        content: [{ type: 'text', text: text || 'No conversations found.' }],
      };
    },
  );

  server.tool(
    'get_conversation',
    'Fetch a full Claude.ai conversation thread by ID. Returns the complete conversation formatted as markdown, JSON, or compact XML.',
    {
      conversation_id: z.string().describe('The conversation UUID (from the URL or list_conversations)'),
      format: z.enum(['markdown', 'json', 'compact']).optional().describe('Output format (default: markdown)'),
    },
    async ({ conversation_id, format }) => {
      const { client, orgId } = await getClient();
      const tree = await client.getConversation(orgId, conversation_id);
      const linear = flattenConversation(tree);
      const output = formatConversation(linear, (format as OutputFormat) ?? 'markdown');

      return { content: [{ type: 'text', text: output }] };
    },
  );

  server.tool(
    'search_conversations',
    'Search Claude.ai conversations by title, date range, or keyword.',
    {
      query: z.string().optional().describe('Search term to match against conversation titles'),
      after: z.string().optional().describe('Only conversations created after this ISO date'),
      before: z.string().optional().describe('Only conversations created before this ISO date'),
      limit: z.number().optional().describe('Maximum results (default: 20)'),
    },
    async ({ query, after, before, limit }) => {
      const { client, orgId } = await getClient();
      const all = await client.listConversations(orgId);
      const results = searchConversations(all, {
        query,
        after,
        before,
        limit: limit ?? 20,
      });

      const text = results
        .map((c) => `- **${c.name}**\n  ${conversationUrl(c.uuid)}\n  UUID: \`${c.uuid}\`\n  Created: ${c.created_at} | Updated: ${c.updated_at}`)
        .join('\n');

      return {
        content: [{ type: 'text', text: text || 'No matching conversations found.' }],
      };
    },
  );

  server.tool(
    'get_conversation_as_context',
    'Fetch a Claude.ai conversation and format it as a compact context block suitable for injecting into a Copilot prompt. Uses XML-style tags for minimal token usage.',
    {
      conversation_id: z.string().describe('The conversation UUID'),
    },
    async ({ conversation_id }) => {
      const { client, orgId } = await getClient();
      const tree = await client.getConversation(orgId, conversation_id);
      const linear = flattenConversation(tree);
      const output = formatConversation(linear, 'compact');

      return { content: [{ type: 'text', text: output }] };
    },
  );

  // ── SQLite offline tools ──────────────────────────────────────

  server.tool(
    'search_sqlite',
    'Full-text search across all imported conversation messages in the local SQLite database. Uses FTS5 with Porter stemming.',
    {
      query: z.string().describe('FTS5 search query (supports AND, OR, NOT, prefix*)'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
      limit: z.number().optional().describe('Maximum results (default: 10)'),
    },
    async ({ query, db_path, limit }) => {
      try {
        const rows = searchMessagesGrouped(db_path ?? DEFAULT_DB, query, limit ?? 10);
        const text = rows.map(formatGroupedMcp).join('\n');
        return { content: [{ type: 'text', text: text || 'No results.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'search_entity',
    'Search for messages containing a specific extracted entity (topic keyword, URL, or UUID) in the local SQLite database.',
    {
      entity: z.string().describe('Entity value to search for (e.g. "playwright", "react", a URL)'),
      type: z.enum(['topic', 'url', 'uuid']).optional().describe('Filter by entity type'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
      limit: z.number().optional().describe('Maximum results (default: 10)'),
    },
    async ({ entity, type, db_path, limit }) => {
      try {
        const rows = searchByEntityGrouped(db_path ?? DEFAULT_DB, entity, type, limit ?? 10);
        const text = rows.map(formatGroupedMcp).join('\n');
        return { content: [{ type: 'text', text: text || 'No results.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'get_conversation_messages',
    'Retrieve all messages from a conversation in the local SQLite database, ordered by main branch (tree traversal).',
    {
      conversation_uuid: z.string().describe('The conversation UUID'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ conversation_uuid, db_path }) => {
      try {
        const rows = getMainBranch(db_path ?? DEFAULT_DB, conversation_uuid);
        const text = rows
          .map((r) => `[${r.created_at}] ${r.sender}: ${r.text}`)
          .join('\n---\n');
        return { content: [{ type: 'text', text: text || 'No messages found.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── New content block search tools ──────────────────────────

  server.tool(
    'search_thinking',
    'Search Claude\'s thinking/reasoning blocks in the local SQLite database. Useful for understanding why Claude answered a certain way.',
    {
      query: z.string().describe('FTS5 search query to match against thinking block text'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
      limit: z.number().optional().describe('Maximum results (default: 10)'),
    },
    async ({ query, db_path, limit }) => {
      try {
        const rows = searchThinkingGrouped(db_path ?? DEFAULT_DB, query, limit ?? 10);
        const text = rows.map(formatGroupedMcp).join('\n');
        return { content: [{ type: 'text', text: text || 'No thinking blocks found.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'search_tool_calls',
    'Find messages where Claude used a specific tool (e.g. bash_tool, web_search, artifacts, sequentialthinking).',
    {
      tool_name: z.string().describe('Tool name to search for (e.g. "bash_tool", "brave_web_search", "artifacts")'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
      limit: z.number().optional().describe('Maximum results (default: 10)'),
    },
    async ({ tool_name, db_path, limit }) => {
      try {
        const rows = searchByToolNameGrouped(db_path ?? DEFAULT_DB, tool_name, limit ?? 10);
        const text = rows.map(formatGroupedMcp).join('\n');
        return { content: [{ type: 'text', text: text || 'No tool calls found.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'search_content',
    'Unified full-text search across all content blocks (text, thinking, tool_use, tool_result, voice_note) with optional type filter.',
    {
      query: z.string().describe('FTS5 search query'),
      block_type: z.enum(['text', 'thinking', 'tool_use', 'tool_result', 'voice_note', 'token_budget']).optional().describe('Filter by content block type'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
      limit: z.number().optional().describe('Maximum results (default: 10)'),
    },
    async ({ query, block_type, db_path, limit }) => {
      try {
        const rows = searchContentGrouped(db_path ?? DEFAULT_DB, query, block_type, limit ?? 10);
        const text = rows.map(formatGroupedMcp).join('\n');
        return { content: [{ type: 'text', text: text || 'No content blocks found.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Extraction tools ──────────────────────────────────────

  server.tool(
    'extract_attachments',
    'List uploaded documents/attachments from a conversation. Returns attachment metadata and extracted text content.',
    {
      conversation_id: z.string().describe('The conversation UUID'),
    },
    async ({ conversation_id }) => {
      try {
        const { client, orgId } = await getClient();
        const tree = await client.getConversation(orgId, conversation_id);
        const messages = tree.chat_messages ?? [];

        const attachments: { messageIndex: number; sender: string; fileName: string; fileType: string; size: number; content: string }[] = [];
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const atts = (msg as unknown as Record<string, unknown>).attachments as Array<{ file_name: string; file_type: string; file_size: number; extracted_content: string }> | undefined;
          if (!atts) continue;
          for (const att of atts) {
            if (!att.extracted_content) continue;
            attachments.push({
              messageIndex: i + 1,
              sender: msg.sender,
              fileName: att.file_name || `attachment.${att.file_type}`,
              fileType: att.file_type,
              size: att.file_size,
              content: att.extracted_content.slice(0, 2000),
            });
          }
        }

        if (attachments.length === 0) {
          return { content: [{ type: 'text', text: 'No attachments found.' }] };
        }
        const lines = attachments.map((a) =>
          `---\nMessage ${a.messageIndex} [${a.sender}] — ${a.fileName} (${a.fileType}, ${a.size} bytes)\n${a.content}${a.content.length >= 2000 ? '\n...(truncated)' : ''}`,
        );
        return { content: [{ type: 'text', text: `${attachments.length} attachment(s):\n\n${lines.join('\n\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'extract_artifacts',
    'List generated artifacts from a conversation. Returns artifact titles, types, and content.',
    {
      conversation_id: z.string().describe('The conversation UUID'),
    },
    async ({ conversation_id }) => {
      try {
        const { client, orgId } = await getClient();
        const tree = await client.getConversation(orgId, conversation_id);
        const messages = tree.chat_messages ?? [];

        const artifacts: { title: string; type: string; content: string }[] = [];
        for (const msg of messages) {
          if (!msg.content) continue;
          for (const block of msg.content) {
            if (block.type !== 'tool_use' || block.name !== 'artifacts') continue;
            const input = block.input as { command?: string; title?: string; type?: string; content?: string } | undefined;
            if (!input || input.command !== 'create' || !input.content) continue;
            artifacts.push({
              title: input.title || 'Untitled',
              type: input.type || 'text/plain',
              content: input.content.slice(0, 3000),
            });
          }
        }

        if (artifacts.length === 0) {
          return { content: [{ type: 'text', text: 'No artifacts found.' }] };
        }
        const lines = artifacts.map((a) =>
          `---\n**${a.title}** (${a.type})\n${a.content}${a.content.length >= 3000 ? '\n...(truncated)' : ''}`,
        );
        return { content: [{ type: 'text', text: `${artifacts.length} artifact(s):\n\n${lines.join('\n\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Stats tools ───────────────────────────────────────────

  server.tool(
    'conversation_stats',
    'Get comprehensive usage statistics: total prompts, messages by sender, content block breakdown, tool usage, temporal patterns, top conversations, entity counts.',
    {
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ db_path }) => {
      try {
        const s = getFullStats(db_path ?? DEFAULT_DB);
        const lines = [
          `Conversations: ${s.conversations.total} (untitled: ${s.conversations.untitled}, empty: ${s.conversations.empty}, in projects: ${s.conversations.withProject})`,
          `Messages: ${s.messages.total} (human/prompts: ${s.messages.human}, assistant: ${s.messages.assistant}, avg/conv: ${s.messages.avgPerConversation})`,
          `Content blocks: ${s.contentBlocks.total} — ${s.contentBlocks.byType.map((t) => `${t.type}: ${t.count}`).join(', ')}`,
          `Thinking: ${s.thinking.total} blocks (avg ${s.thinking.avgPerAssistantMessage}/response)`,
          `Date range: ${s.dateRange.first} to ${s.dateRange.last}`,
          '',
          'Monthly activity:',
          ...s.monthlyActivity.map((m) => `  ${m.month}: ${m.count} messages`),
          '',
          'Top conversations:',
          ...s.topConversations.map((c) => `  ${c.messageCount} msgs — ${c.name || '(untitled)'}`),
          '',
          'Top tools:',
          ...s.topTools.map((t) => `  ${t.count} calls — ${t.name}`),
          '',
          `Entities: ${s.entities.total} — ${s.entities.byType.map((t) => `${t.type}: ${t.count}`).join(', ')}`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Project tools ──────────────────────────────────────────

  server.tool(
    'list_projects',
    'List all Claude.ai projects with links. Projects organize conversations into themed workspaces.',
    {
      include_archived: z.boolean().optional().describe('Include archived projects (default: false)'),
    },
    async ({ include_archived }) => {
      try {
        const { client, orgId } = await getClient();
        let projects = await client.listProjects(orgId);
        if (!include_archived) {
          projects = projects.filter((p) => !p.archived_at);
        }
        if (projects.length === 0) {
          return { content: [{ type: 'text', text: 'No projects found.' }] };
        }
        const lines = projects.map((p) => {
          const archived = p.archived_at ? ' [archived]' : '';
          const desc = p.description ? ` — ${p.description.slice(0, 80)}` : '';
          return `- **${p.name}**${archived}${desc}\n  ${projectUrl(p.uuid)}\n  docs: ${p.docs_count} | files: ${p.files_count} | updated: ${p.updated_at}`;
        });
        return { content: [{ type: 'text', text: `${projects.length} projects:\n\n${lines.join('\n\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Delete tools ───────────────────────────────────────────

  server.tool(
    'delete_conversation',
    'Delete a conversation from Claude.ai. WARNING: This is irreversible. Use audit_conversations first to identify targets.',
    {
      conversation_id: z.string().describe('The conversation UUID to delete'),
      local_only: z.boolean().optional().describe('Only remove from local SQLite, skip Claude.ai API (default: false)'),
      db_path: z.string().optional().describe('Path to SQLite database for local cleanup (default: .ccr-import.sqlite)'),
    },
    async ({ conversation_id, local_only, db_path }) => {
      try {
        if (local_only) {
          deleteConversationLocal(db_path ?? DEFAULT_DB, conversation_id);
          return { content: [{ type: 'text', text: `Removed ${conversation_id} from local database.` }] };
        }
        const { client, orgId } = await getClient();
        await client.deleteConversation(orgId, conversation_id);
        deleteConversationLocal(db_path ?? DEFAULT_DB, conversation_id);
        return { content: [{ type: 'text', text: `Deleted ${conversation_id} from Claude.ai and local database.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Audit tools ────────────────────────────────────────────

  server.tool(
    'audit_conversations',
    'Audit conversations in the SQLite database: find untitled conversations, empty conversations (no messages), or get summary stats.',
    {
      mode: z.enum(['stats', 'untitled', 'empty']).optional().describe('What to audit (default: stats)'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
      limit: z.number().optional().describe('Maximum results for untitled/empty mode (default: 50)'),
    },
    async ({ mode, db_path, limit }) => {
      try {
        const dbPath = db_path ?? DEFAULT_DB;
        const m = mode ?? 'stats';

        if (m === 'untitled') {
          const rows = getUntitledConversations(dbPath, limit ?? 50);
          if (rows.length === 0) return { content: [{ type: 'text', text: 'No untitled conversations.' }] };
          const lines = rows.map((r) => `${r.uuid} | ${r.message_count} msgs | ${r.updated_at}`);
          return { content: [{ type: 'text', text: `Untitled conversations (${rows.length}):\n${lines.join('\n')}` }] };
        } else if (m === 'empty') {
          const rows = getEmptyConversations(dbPath, limit ?? 50);
          if (rows.length === 0) return { content: [{ type: 'text', text: 'No empty conversations.' }] };
          const lines = rows.map((r) => `${r.uuid} | ${r.name || '(no title)'} | ${r.updated_at}`);
          return { content: [{ type: 'text', text: `Empty conversations (${rows.length}):\n${lines.join('\n')}` }] };
        } else {
          const stats = getConversationStats(dbPath);
          return {
            content: [{
              type: 'text',
              text: `Conversation audit:\n  Total: ${stats.total}\n  Untitled: ${stats.untitled} (${((stats.untitled / stats.total) * 100).toFixed(1)}%)\n  Empty: ${stats.empty} (${((stats.empty / stats.total) * 100).toFixed(1)}%)`,
            }],
          };
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Branch/thread tools ────────────────────────────────────

  server.tool(
    'get_conversation_branches',
    'List all threads/branches in a conversation. Conversations are trees — message edits create alternate branches. Thread 0 is the main branch.',
    {
      conversation_uuid: z.string().describe('The conversation UUID'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ conversation_uuid, db_path }) => {
      try {
        const result = getConversationBranches(db_path ?? DEFAULT_DB, conversation_uuid);
        if (result.threads.length === 0) {
          return { content: [{ type: 'text', text: 'No messages found for this conversation.' }] };
        }
        const lines = result.threads.map((t) => {
          const label = t.threadIndex === 0 ? '(main)' : `(forks at depth ${t.forkDepth})`;
          return `Thread ${t.threadIndex} ${label}: ${t.messageCount} messages, last: ${t.lastMessage}`;
        });
        const text = `${result.threads.length} thread(s), ${result.totalMessages} total messages, ${result.branchPoints} branch point(s)\n\n${lines.join('\n')}`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'get_conversation_thread',
    'Get messages from a specific thread/branch of a conversation. Use get_conversation_branches first to see available threads.',
    {
      conversation_uuid: z.string().describe('The conversation UUID'),
      thread_index: z.number().describe('Thread index (0 = main branch, 1+ = alternate branches)'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ conversation_uuid, thread_index, db_path }) => {
      try {
        const messages = getThread(db_path ?? DEFAULT_DB, conversation_uuid, thread_index);
        if (messages.length === 0) {
          return { content: [{ type: 'text', text: 'No messages found (thread index may be out of range).' }] };
        }
        const text = messages.map((m) => {
          const shared = m.isShared ? ' [shared]' : '';
          return `[${m.created_at}] ${m.sender}${shared}: ${m.text}`;
        }).join('\n---\n');
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Profile tools ────────────────────────────────────────────

  server.tool(
    'profile_conversations',
    'Build semantic profiles for all conversations: 20 regex categories (code, CLI, Docker, errors, etc.) plus structural metrics (tool calls, thinking blocks, code blocks). Returns type distribution and density stats.',
    {
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ db_path }) => {
      try {
        const result = profileConversations(db_path ?? DEFAULT_DB);
        const lines = [
          `Profiled ${result.totalProfiled} conversations.`,
          `Avg technical density: ${result.avgDensity.toFixed(3)}`,
          'Type distribution:',
          ...Object.entries(result.typeDistribution)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => `  ${type}: ${count}`),
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'query_profiles',
    'Query conversation semantic profiles. Filter by primary type (coding/devops/research/qa/general) or minimum technical density.',
    {
      primary_type: z.enum(['coding', 'devops', 'research', 'qa', 'general']).optional().describe('Filter by conversation type'),
      min_density: z.number().optional().describe('Minimum technical density 0.0–1.0'),
      limit: z.number().optional().describe('Max results (default: 20)'),
      order_by: z.enum(['technical_density', 'code_blocks', 'tool_invocations', 'total_words', 'duration_minutes']).optional().describe('Sort field (default: technical_density)'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ primary_type, min_density, limit, order_by, db_path }) => {
      try {
        const profiles = getProfiles(db_path ?? DEFAULT_DB, {
          primaryType: primary_type,
          minDensity: min_density,
          limit: limit ?? 20,
          orderBy: order_by ?? 'technical_density',
        });
        if (profiles.length === 0) {
          return { content: [{ type: 'text', text: 'No profiles found. Run profile_conversations first.' }] };
        }
        const lines = profiles.map((p) => {
          const name = p.conversation_name || p.conversation_uuid.slice(0, 12);
          return `- **${name}** type=${p.primary_type} density=${p.technical_density.toFixed(3)} words=${p.total_words} duration=${p.duration_minutes}m code_blocks=${p.code_blocks} tools=${p.tool_invocations} thinking=${p.thinking_blocks}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'rename_local_untitled_conversations',
    'Auto-generate titles for untitled conversations in local SQLite (NOT synced to claude.ai). Derives titles from assistant answers (primary), topic entities (secondary), or the first human message (fallback).',
    {
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
      dry_run: z.boolean().optional().describe('Preview titles without updating (default: false)'),
      limit: z.number().optional().describe('Max conversations to rename (default: all)'),
    },
    async ({ db_path, dry_run, limit }) => {
      try {
        const result = renameUntitled(db_path ?? DEFAULT_DB, {
          dryRun: dry_run ?? false,
          limit: limit ?? 0,
        });
        if (result.total === 0) {
          return { content: [{ type: 'text', text: 'No untitled conversations found.' }] };
        }
        const lines = [
          `${dry_run ? '[DRY RUN] ' : ''}Found ${result.total} untitled conversations`,
          '',
          ...result.titles.map((t) => `  ${t.uuid.slice(0, 12)}… → "${t.title}" (${t.source})`),
          ...(result.skipped > 0 ? [`\n  ${result.skipped} skipped (no content)`] : []),
          `\n${dry_run ? 'Would rename' : 'Renamed locally'}: ${result.renamed} | Skipped: ${result.skipped}`,
          ...(dry_run ? [] : ['(local SQLite only — not synced to claude.ai)']),
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Knowledge graph tools ──────────────────────────────────

  server.tool(
    'graph_build',
    'Build or rebuild the knowledge graph from extracted entities. Runs entity extraction, graph construction, and community clustering.',
    {
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
      cluster_method: z.enum(['label-propagation', 'kmeans']).optional().describe('Clustering method (default: label-propagation)'),
      k: z.number().optional().describe('Number of clusters for kmeans (auto if omitted)'),
    },
    async ({ db_path, cluster_method, k }) => {
      try {
        const dbPath = db_path ?? DEFAULT_DB;
        extractEntities(dbPath);
        const build = buildGraph(dbPath);
        const cluster = clusterGraph(dbPath, cluster_method ?? 'label-propagation', k ?? undefined);
        return {
          content: [{
            type: 'text',
            text: `Graph built: ${build.nodeCount} nodes (${build.entityNodes} entities, ${build.conversationNodes} conversations, ${build.toolNodes} tools), ${build.edgeCount} edges (${build.coOccurrenceEdges} co-occurrence, ${build.mentionedInEdges} mentioned-in, ${build.usesToolEdges} uses-tool), ${cluster.communityCount} communities (largest: ${cluster.largestCommunity}, avg cohesion: ${cluster.avgCohesion.toFixed(3)})`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'graph_query',
    'Search the knowledge graph by keyword using BFS traversal. Returns matching nodes and their connections.',
    {
      keyword: z.string().describe('Entity or topic to search for'),
      depth: z.number().optional().describe('BFS traversal depth (default: 2)'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ keyword, depth, db_path }) => {
      try {
        const result = queryGraph(db_path ?? DEFAULT_DB, keyword, depth ?? 2);
        if (result.nodes.length === 0) {
          return { content: [{ type: 'text', text: `No graph nodes matching "${keyword}".` }] };
        }
        const nodeLines = result.nodes.map((n) =>
          `${result.seedNodes.includes(n.id) ? '*' : ' '} ${n.label} [${n.entity_type ?? n.node_type}] degree=${n.degree} community=${n.community_id ?? '-'}`,
        );
        const edgeLines = result.edges.slice(0, 30).map((e) =>
          `  ${e.source_label} -[${e.relation} w=${e.weight.toFixed(1)}]-> ${e.target_label}`,
        );
        const text = `${result.nodes.length} nodes, ${result.edges.length} edges\n\nNodes:\n${nodeLines.join('\n')}\n\nEdges:\n${edgeLines.join('\n')}`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'graph_god_nodes',
    'Get the most connected entities in the knowledge graph, with suggested follow-up queries.',
    {
      limit: z.number().optional().describe('Number of top entities to return (default: 10)'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ limit, db_path }) => {
      try {
        const dbPath = db_path ?? DEFAULT_DB;
        const nodes = godNodes(dbPath, limit ?? 10);
        if (nodes.length === 0) {
          return { content: [{ type: 'text', text: 'No graph nodes found. Run graph_build first.' }] };
        }
        const lines = nodes.map((n) => `${n.label} [${n.entity_type}] degree=${n.degree} community=${n.community_id ?? '-'}`);
        const questions = suggestQuestions(dbPath);
        const text = `Most connected entities:\n${lines.join('\n')}${questions.length > 0 ? `\n\nSuggested queries:\n${questions.map((q) => `  → ${q}`).join('\n')}` : ''}`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'graph_neighbors',
    'Get direct neighbors of a node in the knowledge graph.',
    {
      node_id: z.string().describe('Node ID (entity value or conv:<uuid>)'),
      limit: z.number().optional().describe('Maximum neighbors to return (default: 20)'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ node_id, limit, db_path }) => {
      try {
        const neighbors = getNeighbors(db_path ?? DEFAULT_DB, node_id, limit ?? 20);
        if (neighbors.length === 0) {
          return { content: [{ type: 'text', text: `No neighbors found for "${node_id}".` }] };
        }
        const lines = neighbors.map((n) =>
          `${n.direction === 'outgoing' ? '→' : '←'} ${n.label} [${n.entity_type ?? n.node_type}] ${n.relation} w=${n.weight.toFixed(1)} degree=${n.degree}`,
        );
        return { content: [{ type: 'text', text: `Neighbors of ${node_id}:\n${lines.join('\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'graph_shortest_path',
    'Find the shortest path between two entities in the knowledge graph.',
    {
      from_id: z.string().describe('Starting node ID'),
      to_id: z.string().describe('Target node ID'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ from_id, to_id, db_path }) => {
      try {
        const result = shortestPath(db_path ?? DEFAULT_DB, from_id, to_id);
        if (!result.found) {
          return { content: [{ type: 'text', text: `No path found between "${from_id}" and "${to_id}".` }] };
        }
        return { content: [{ type: 'text', text: `Path (${result.length} hops): ${result.labels.join(' → ')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'graph_community',
    'Get all members of a community in the knowledge graph.',
    {
      community_id: z.number().describe('Community ID'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ community_id, db_path }) => {
      try {
        const result = getCommunity(db_path ?? DEFAULT_DB, community_id);
        if (result.nodes.length === 0) {
          return { content: [{ type: 'text', text: `No nodes found in community ${community_id}.` }] };
        }
        const lines = result.nodes.map((n) => `${n.label} [${n.entity_type ?? n.node_type}] degree=${n.degree}`);
        return {
          content: [{
            type: 'text',
            text: `Community ${community_id}: "${result.label ?? 'unnamed'}" (cohesion: ${result.cohesion_score?.toFixed(3) ?? 'N/A'})\n${result.nodes.length} members:\n${lines.join('\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'graph_surprising_connections',
    'Find surprising cross-community entity connections in the knowledge graph.',
    {
      limit: z.number().optional().describe('Maximum results (default: 10)'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ limit, db_path }) => {
      try {
        const connections = surprisingConnections(db_path ?? DEFAULT_DB, limit ?? 10);
        if (connections.length === 0) {
          return { content: [{ type: 'text', text: 'No cross-community connections found.' }] };
        }
        const lines = connections.map((c) =>
          `${c.source_label} ↔ ${c.target_label} (weight: ${c.weight.toFixed(1)}, shared conversations: ${c.shared_conversations})`,
        );
        return { content: [{ type: 'text', text: `Surprising connections:\n${lines.join('\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'graph_export',
    'Export the knowledge graph as an interactive HTML visualization with vis-network.js.',
    {
      output_path: z.string().optional().describe('Output HTML file path (default: graph.html)'),
      seed_entity: z.string().optional().describe('Seed entity for ego graph view'),
      max_nodes: z.number().optional().describe('Maximum nodes to include (default: 50)'),
      db_path: z.string().optional().describe('Path to SQLite database (default: .ccr-import.sqlite)'),
    },
    async ({ output_path, seed_entity, max_nodes, db_path }) => {
      try {
        const output = path.resolve(output_path ?? 'graph.html');
        toHtml(db_path ?? DEFAULT_DB, output, {
          maxNodes: max_nodes ?? 50,
          seedEntity: seed_entity,
        });
        return { content: [{ type: 'text', text: `Graph exported to ${output}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Claude Code Session tools ──────────────────────────────────
  // Distinct from the web-chat conversation tools above: these hit
  // claude.ai/v1/sessions/<id> via a Playwright-backed client (needed to
  // pass Cloudflare bot management). Each call launches a fresh browser
  // context — acceptable for occasional reads, not chatty polling.

  server.tool(
    'get_code_session',
    'Fetch a Claude Code session by ID. Returns session metadata + formatted message events (markdown/JSON/compact). Accepts full URL, session_<slug>, or bare slug.',
    {
      session_id: z.string().describe('Session ID (session_01...) or full claude.ai/code/<id> URL'),
      format: z.enum(['markdown', 'json', 'compact']).optional().describe('Output format (default: markdown)'),
      limit: z.number().optional().describe('Max events to include (default: 1000)'),
    },
    async ({ session_id, format, limit }) => {
      try {
        const session = await loadSession();
        const client = await createCodeSessionClient(session);
        try {
          const id = normalizeCodeSessionId(session_id);
          const meta = await client.getCodeSession(id);
          const events = await client.getCodeSessionEvents(id, limit ?? 1000);
          const text = formatCodeSession(meta, events, (format as OutputFormat) ?? 'markdown');
          return { content: [{ type: 'text', text }] };
        } finally {
          await client.close();
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'list_code_sessions',
    'List all Claude Code sessions on the account. Optionally filter by title substring.',
    {
      query: z.string().optional().describe('Filter sessions by title (case-insensitive substring)'),
      limit: z.number().optional().describe('Maximum number of sessions to return (default: 50)'),
    },
    async ({ query, limit }) => {
      try {
        const session = await loadSession();
        const client = await createCodeSessionClient(session);
        try {
          let sessions = await client.listCodeSessions();
          if (query) {
            const q = query.toLowerCase();
            sessions = sessions.filter((s) => (s.title ?? '').toLowerCase().includes(q));
          }
          sessions = sessions.slice(0, limit ?? 50);
          if (sessions.length === 0) {
            return { content: [{ type: 'text', text: 'No code sessions found.' }] };
          }
          const text = sessions
            .map(
              (s) =>
                `- **${s.title || '(untitled)'}**\n  https://claude.ai/code/${s.id}\n  ID: \`${s.id}\`\n  Status: ${s.session_status ?? 'unknown'} | Model: ${s.session_context?.model ?? 'unknown'} | Updated: ${s.updated_at}`,
            )
            .join('\n');
          return { content: [{ type: 'text', text }] };
        } finally {
          await client.close();
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'search_code_sessions',
    'Search Claude Code sessions by title substring. Alias for list_code_sessions with a required query.',
    {
      query: z.string().describe('Title substring to match (case-insensitive)'),
      limit: z.number().optional().describe('Maximum results (default: 20)'),
    },
    async ({ query, limit }) => {
      try {
        const session = await loadSession();
        const client = await createCodeSessionClient(session);
        try {
          const q = query.toLowerCase();
          const all = await client.listCodeSessions();
          const matches = all
            .filter((s) => (s.title ?? '').toLowerCase().includes(q))
            .slice(0, limit ?? 20);
          if (matches.length === 0) {
            return { content: [{ type: 'text', text: `No code sessions matching "${query}".` }] };
          }
          const text = matches
            .map(
              (s) =>
                `- **${s.title}**\n  https://claude.ai/code/${s.id}\n  ID: \`${s.id}\` | Updated: ${s.updated_at}`,
            )
            .join('\n');
          return { content: [{ type: 'text', text }] };
        } finally {
          await client.close();
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
