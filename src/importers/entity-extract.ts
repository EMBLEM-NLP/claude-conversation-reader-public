/**
 * @file entity-extract.ts
 * @description Regex-based entity extraction: topics, URLs, UUIDs
 * @version 1.1.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-04-16T00:00:00Z
 */
import Database from 'better-sqlite3';

// Simple regex-based entity extraction
const ENTITY_PATTERNS = [
  { type: 'uuid', regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
  { type: 'url', regex: /https?:\/\/[\w.-]+[\w/\-?&=.%#]+/gi },
  { type: 'topic', regex: /\b(mcp|knowledge graph|rag|playwright|typescript|react|led|dmx|grandma|ma2|job|scraper|youtube|power query|cli|typing|crypto|whatsapp|invoice|automation|svg|visualization|api|github|copilot|skill|agent|docker|server|prompt|sequential thinking)\b/gi },
];

function extractFromText(text: string, messageUuid: string, conversationUuid: string, insertEntity: Database.Statement) {
  for (const { type, regex } of ENTITY_PATTERNS) {
    const found = (text || '').match(regex);
    if (found) {
      for (const entity of found) {
        insertEntity.run(entity.toLowerCase(), type, messageUuid, conversationUuid);
      }
    }
  }
}

export function extractEntities(dbPath: string) {
  const db = new Database(dbPath);

  // Clear existing entities for clean re-extraction
  db.exec('DELETE FROM entities');

  const insertEntity = db.prepare('INSERT OR IGNORE INTO entities (entity, type, message_uuid, conversation_uuid) VALUES (?, ?, ?, ?)');

  // Extract from message text
  interface MsgRow { uuid: string; conversation_uuid: string; text: string }
  const selectMsgs = db.prepare('SELECT uuid, conversation_uuid, text FROM messages');
  const msgRows = selectMsgs.all() as MsgRow[];

  // Extract from content blocks (thinking, text, voice_note)
  interface BlockRow { message_uuid: string; conversation_uuid: string; text_content: string }
  const selectBlocks = db.prepare(
    "SELECT message_uuid, conversation_uuid, text_content FROM content_blocks WHERE block_type IN ('text', 'thinking', 'voice_note') AND text_content IS NOT NULL",
  );
  const blockRows = selectBlocks.all() as BlockRow[];

  // Extract tool names from tool_use content blocks
  interface ToolRow { message_uuid: string; conversation_uuid: string; tool_name: string }
  const toolBlocks = db.prepare(
    'SELECT cb.message_uuid, cb.conversation_uuid, cb.tool_name ' +
    'FROM content_blocks cb ' +
    "WHERE cb.block_type = 'tool_use' AND cb.tool_name IS NOT NULL",
  ).all() as ToolRow[];

  db.transaction(() => {
    for (const row of msgRows) {
      extractFromText(row.text, row.uuid, row.conversation_uuid, insertEntity);
    }
    for (const row of blockRows) {
      extractFromText(row.text_content, row.message_uuid, row.conversation_uuid, insertEntity);
    }
    for (const row of toolBlocks) {
      insertEntity.run(row.tool_name.toLowerCase(), 'tool', row.message_uuid, row.conversation_uuid);
    }
  })();

  const { n: entityCount } = db.prepare('SELECT COUNT(*) as n FROM entities').get() as { n: number };
  const { n: toolCount } = db.prepare("SELECT COUNT(*) as n FROM entities WHERE type = 'tool'").get() as { n: number };

  db.close();
  console.log(`Entity extraction complete: ${entityCount} entities (${toolCount} tool) from ${msgRows.length} messages + ${blockRows.length} content blocks + ${toolBlocks.length} tool_use blocks.`);
}
