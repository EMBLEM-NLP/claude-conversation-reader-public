/**
 * @file server.ts
 * @description MCP server entry point (stdio transport, 22 tools)
 * @version 1.0.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-15T17:15:45Z
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './mcp/tools.js';

const server = new McpServer({
  name: 'claude-conversation-reader',
  version: '0.1.0',
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
