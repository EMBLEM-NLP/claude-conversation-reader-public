/**
 * @file types.ts
 * @description All shared TypeScript interfaces for the project
 * @version 1.2.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-05-27T18:40:00Z
 */
// Shared TypeScript interfaces for the Claude Conversation Reader

// ── Auth & Session ──────────────────────────────────────────────

export interface SessionCookies {
  sessionKey: string;
  raw: CookieEntry[];
}

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'None' | 'Strict';
}

export interface SessionFile {
  cookies: SessionCookies;
  savedAt: string;
}

export interface LoginOptions {
  headed?: boolean;
}

// ── Claude.ai API Shapes ────────────────────────────────────────

export interface Organization {
  uuid: string;
  name: string;
}

export interface ConversationMeta {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  model?: string;
  project_uuid?: string;
}

export interface ProjectMeta {
  uuid: string;
  name: string;
  description: string;
  is_private: boolean;
  is_starred: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  docs_count: number;
  files_count: number;
}

export interface ConversationTree {
  uuid: string;
  name: string;
  model?: string;
  created_at: string;
  updated_at: string;
  chat_messages?: ChatMessage[];
}

export interface ChatMessage {
  uuid: string;
  sender: 'human' | 'assistant';
  text?: string;
  content?: MessageContent[];
  parent?: string;
  children?: string[];
  index: number;
  created_at: string;
  updated_at: string;
}

export interface MessageContent {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking' | 'voice_note' | 'token_budget';
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

// ── Extracted / Formatted ───────────────────────────────────────

export interface LinearMessage {
  role: 'human' | 'assistant';
  text: string;
  timestamp: string;
  uuid: string;
}

export interface LinearConversation {
  uuid: string;
  title: string;
  model?: string;
  created_at: string;
  messages: LinearMessage[];
}

export type OutputFormat = 'markdown' | 'json' | 'compact';

// ── SQLite DB Row Types ─────────────────────────────────────────

export interface DbMessageRow {
  uuid: string;
  conversation_uuid: string;
  sender: string;
  text: string;
  created_at: string;
  updated_at: string | null;
  parent_message_uuid: string | null;
  attachments: string;
  files: string;
  name?: string; // joined from conversations
}

export interface DbContentBlockRow {
  id: number;
  message_uuid: string;
  conversation_uuid: string;
  block_index: number;
  block_type: string;
  text_content: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input: string | null;
  is_error: number | null;
  meta: string;
  name?: string; // joined from conversations
  sender?: string; // joined from messages
  created_at?: string; // joined from messages
}

// ── API Client Interface ────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  description?: string;
  is_private?: boolean;
}

// ── Claude.ai File Objects ──────────────────────────────────────

export interface ClaudeFileAsset {
  url: string;
  file_variant?: string;
  image_width?: number;
  image_height?: number;
  page_count?: number;
  primary_color?: string;
}

export interface ClaudeFile {
  success: boolean;
  file_kind: 'image' | 'document' | 'blob';
  file_uuid: string;
  file_name: string;
  created_at: string;
  uuid: string;
  path?: string;
  // image fields
  thumbnail_url?: string;
  preview_url?: string;
  thumbnail_asset?: ClaudeFileAsset;
  preview_asset?: ClaudeFileAsset;
  // document fields
  document_asset?: ClaudeFileAsset;
}

export interface ClaudeApiClient {
  getOrganizations(): Promise<Organization[]>;
  listConversations(orgId: string, projectUuid?: string): Promise<ConversationMeta[]>;
  listProjectConversations(orgId: string, projectUuid: string): Promise<ConversationMeta[]>;
  getConversation(orgId: string, conversationId: string): Promise<ConversationTree>;
  deleteConversation(orgId: string, conversationId: string): Promise<void>;
  listProjects(orgId: string): Promise<ProjectMeta[]>;
  createProject(orgId: string, name: string, description?: string): Promise<ProjectMeta>;
  moveConversationToProject(orgId: string, convId: string, projectUuid: string | null): Promise<ConversationMeta>;
  renameConversation(orgId: string, convId: string, name: string): Promise<ConversationMeta>;
  downloadFile(file: ClaudeFile): Promise<{ buffer: Buffer; ext: string } | null>;
}

// ── Claude Code Session API Shapes ───────────────────────────────
// Served from claude.ai/v1/sessions/<session_id>. Distinct from the web-chat
// conversation API (different path, different ID format, additional headers
// required). IDs are ULID-style with "session_" prefix.

export interface CodeSession {
  id: string;
  title: string;
  type?: string;
  session_status?: string;
  session_context?: CodeSessionContext;
  permission_mode?: string;
  environment_id?: string;
  environment_kind?: string;
  connection_status?: string;
  tags?: string[];
  unread?: boolean;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
  external_metadata?: Record<string, unknown>;
  active_mount_paths?: string[];
}

export interface CodeSessionContext {
  model?: string;
  cwd?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  environment_variables?: Record<string, string>;
  outcomes?: unknown[];
  sources?: unknown[];
}

export interface CodeSessionEvent {
  uuid: string;
  type: 'user' | 'assistant' | 'control_request' | 'control_response' | 'control_cancel_request' | 'result' | string;
  created_at: string;
  timestamp?: string;
  historical?: boolean;
  isSynthetic?: boolean;
  parent_tool_use_id?: string | null;
  session_id?: string;
  message?: CodeSessionMessage;
}

export interface CodeSessionMessage {
  role?: 'user' | 'assistant';
  content?: string | CodeSessionContentBlock[];
}

export interface CodeSessionContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

export interface CodeSessionShareStatus {
  is_shared?: boolean;
  share_url?: string;
  [key: string]: unknown;
}

export interface CodeSessionEventsResponse {
  data?: CodeSessionEvent[];
  events?: CodeSessionEvent[];
  items?: CodeSessionEvent[];
}

export interface CodeSessionClient {
  listCodeSessions(): Promise<CodeSession[]>;
  getCodeSession(sessionId: string): Promise<CodeSession>;
  getCodeSessionEvents(sessionId: string, limit?: number): Promise<CodeSessionEvent[]>;
  getCodeSessionShareStatus(sessionId: string): Promise<CodeSessionShareStatus>;
  close(): Promise<void>;
}
