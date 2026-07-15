/**
 * @file build.ts
 * @description Graph construction: entity + conversation + tool nodes, 3 edge types
 * @version 1.1.0
 * @created 2026-04-14T00:00:00Z
 * @lastUpdated 2026-04-17T16:10:11Z
 */
import Database from 'better-sqlite3';
import { createGraphSchema, dropGraphSchema } from './schema.js';
import { profileConversations } from '../importers/conversation-profiler.js';

export interface BuildResult {
  nodeCount: number;
  edgeCount: number;
  entityNodes: number;
  conversationNodes: number;
  toolNodes: number;
  coOccurrenceEdges: number;
  mentionedInEdges: number;
  usesToolEdges: number;
}

interface EntityRow {
  entity: string;
  type: string;
  message_uuid: string;
  conversation_uuid: string;
}

interface ConversationRow {
  uuid: string;
  name: string;
}

export function buildGraph(dbPath: string): BuildResult {
  // Auto-run profiler before graph build so profile data is available for node enrichment
  const hasProfiles = (() => {
    const checkDb = new Database(dbPath, { readonly: true });
    try {
      const row = checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_profiles'").get();
      if (!row) return false;
      const cnt = checkDb.prepare('SELECT COUNT(*) as n FROM conversation_profiles').get() as { n: number };
      return cnt.n > 0;
    } catch { return false; }
    finally { checkDb.close(); }
  })();
  if (!hasProfiles) {
    console.log('Running semantic profiler before graph build...');
    profileConversations(dbPath);
  }

  const db = new Database(dbPath);
  try {
    // Drop and recreate graph tables for a clean rebuild
    dropGraphSchema(db);
    createGraphSchema(db);

    const insertNode = db.prepare(
      'INSERT OR IGNORE INTO graph_nodes (id, label, node_type, entity_type) VALUES (?, ?, ?, ?)',
    );
    const insertEdge = db.prepare(`
      INSERT INTO graph_edges (source_id, target_id, relation, confidence, weight, conversation_uuid, message_uuid)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, target_id, relation) DO UPDATE SET weight = weight + excluded.weight
    `);

    // Step 1: Insert conversation nodes
    const conversations = db.prepare('SELECT uuid, name FROM conversations').all() as ConversationRow[];
    db.transaction(() => {
      for (const conv of conversations) {
        insertNode.run(`conv:${conv.uuid}`, conv.name || conv.uuid, 'conversation', null);
      }
    })();

    // Step 2: Insert entity nodes from entities table
    const distinctEntities = db
      .prepare("SELECT DISTINCT entity, type FROM entities WHERE entity != ''")
      .all() as { entity: string; type: string }[];
    db.transaction(() => {
      for (const { entity, type } of distinctEntities) {
        insertNode.run(entity, entity, 'entity', type);
      }
    })();

    // Step 3: Insert tool nodes from content_blocks
    const distinctTools = db
      .prepare("SELECT DISTINCT tool_name FROM content_blocks WHERE block_type = 'tool_use' AND tool_name IS NOT NULL AND tool_name != ''")
      .all() as { tool_name: string }[];
    db.transaction(() => {
      for (const { tool_name } of distinctTools) {
        insertNode.run(`tool:${tool_name}`, tool_name, 'tool', null);
      }
    })();

    // Step 4: Build uses_tool edges (conversation -> tool) and tool co-occurrence edges
    interface ToolUsageRow { conversation_uuid: string; tool_name: string; call_count: number }
    const toolUsage = db.prepare(
      `SELECT conversation_uuid, tool_name, COUNT(*) as call_count
       FROM content_blocks
       WHERE block_type = 'tool_use' AND tool_name IS NOT NULL AND tool_name != ''
       GROUP BY conversation_uuid, tool_name`,
    ).all() as ToolUsageRow[];

    let usesToolEdges = 0;
    // Group tools by conversation for co-occurrence
    const toolsByConv = new Map<string, string[]>();
    db.transaction(() => {
      for (const row of toolUsage) {
        const convNodeId = `conv:${row.conversation_uuid}`;
        const toolNodeId = `tool:${row.tool_name}`;
        insertEdge.run(convNodeId, toolNodeId, 'uses_tool', 'EXTRACTED', row.call_count, row.conversation_uuid, null);
        usesToolEdges++;
        const list = toolsByConv.get(row.conversation_uuid) ?? [];
        list.push(row.tool_name);
        toolsByConv.set(row.conversation_uuid, list);
      }
      // Tool co-occurrence: tools used in the same conversation
      for (const [convUuid, tools] of toolsByConv) {
        for (let i = 0; i < tools.length; i++) {
          for (let j = i + 1; j < tools.length; j++) {
            const [a, b] = tools[i] < tools[j] ? [tools[i], tools[j]] : [tools[j], tools[i]];
            insertEdge.run(`tool:${a}`, `tool:${b}`, 'co_occurs', 'EXTRACTED', 1.0, convUuid, null);
          }
        }
      }
    })();

    // Step 5: Enrich conversation nodes with tool metadata
    db.exec(`
      UPDATE graph_nodes SET
        tool_count = (
          SELECT COUNT(*) FROM content_blocks
          WHERE block_type = 'tool_use' AND tool_name IS NOT NULL AND tool_name != ''
            AND conversation_uuid = SUBSTR(graph_nodes.id, 6)
        ),
        tool_names = (
          SELECT json_group_array(DISTINCT tool_name) FROM content_blocks
          WHERE block_type = 'tool_use' AND tool_name IS NOT NULL AND tool_name != ''
            AND conversation_uuid = SUBSTR(graph_nodes.id, 6)
        )
      WHERE node_type = 'conversation'
    `);

    // Step 6: Build co-occurrence edges (entities sharing a message) + mentioned_in edges
    const allEntityRows = db.prepare('SELECT entity, type, message_uuid, conversation_uuid FROM entities').all() as EntityRow[];

    // Group by message
    const byMessage = new Map<string, EntityRow[]>();
    for (const row of allEntityRows) {
      const list = byMessage.get(row.message_uuid) ?? [];
      list.push(row);
      byMessage.set(row.message_uuid, list);
    }

    let coOccurrenceEdges = 0;
    let mentionedInEdges = 0;

    db.transaction(() => {
      for (const [msgUuid, rows] of byMessage) {
        const convUuid = rows[0].conversation_uuid;
        const convNodeId = `conv:${convUuid}`;

        // co_occurs: all pairs of entities in the same message
        for (let i = 0; i < rows.length; i++) {
          for (let j = i + 1; j < rows.length; j++) {
            const a = rows[i].entity;
            const b = rows[j].entity;
            // Always use lexicographic order for stable dedup
            const [src, tgt] = a < b ? [a, b] : [b, a];
            insertEdge.run(src, tgt, 'co_occurs', 'EXTRACTED', 1.0, convUuid, msgUuid);
            coOccurrenceEdges++;
          }
          // mentioned_in: entity -> conversation
          insertEdge.run(rows[i].entity, convNodeId, 'mentioned_in', 'EXTRACTED', 1.0, convUuid, msgUuid);
          mentionedInEdges++;
        }
      }
    })();

    // Step 7: Compute degree (in + out) for all nodes
    db.exec(`
      UPDATE graph_nodes SET degree = (
        SELECT COUNT(*) FROM graph_edges
        WHERE source_id = graph_nodes.id OR target_id = graph_nodes.id
      )
    `);

    // Step 8: Temporal enrichment — first/last seen from message timestamps
    db.exec(`
      UPDATE graph_nodes SET
        first_seen = (
          SELECT MIN(m.created_at) FROM entities e
          JOIN messages m ON m.uuid = e.message_uuid
          WHERE e.entity = graph_nodes.id
        ),
        last_seen = (
          SELECT MAX(m.created_at) FROM entities e
          JOIN messages m ON m.uuid = e.message_uuid
          WHERE e.entity = graph_nodes.id
        )
      WHERE node_type = 'entity'
    `);
    db.exec(`
      UPDATE graph_nodes SET
        first_seen = (SELECT created_at FROM conversations WHERE 'conv:' || uuid = graph_nodes.id),
        last_seen = (SELECT updated_at FROM conversations WHERE 'conv:' || uuid = graph_nodes.id)
      WHERE node_type = 'conversation'
    `);

    // Step 9: Enrich conversation nodes with semantic profile data
    const hasProfileTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_profiles'").get();
    if (hasProfileTable) {
      db.exec(`
        UPDATE graph_nodes SET
          category = (
            SELECT primary_type FROM conversation_profiles
            WHERE conversation_uuid = SUBSTR(graph_nodes.id, 6)
          ),
          meta = (
            SELECT json_object(
              'technical_density', technical_density,
              'total_words', total_words,
              'code_blocks', code_blocks,
              'tool_invocations', tool_invocations,
              'thinking_blocks', thinking_blocks,
              'duration_minutes', duration_minutes
            ) FROM conversation_profiles
            WHERE conversation_uuid = SUBSTR(graph_nodes.id, 6)
          )
        WHERE node_type = 'conversation'
          AND EXISTS (SELECT 1 FROM conversation_profiles WHERE conversation_uuid = SUBSTR(graph_nodes.id, 6))
      `);
    }

    const { nodeCount } = db.prepare('SELECT COUNT(*) as nodeCount FROM graph_nodes').get() as { nodeCount: number };
    const { edgeCount } = db.prepare('SELECT COUNT(*) as edgeCount FROM graph_edges').get() as { edgeCount: number };

    return {
      nodeCount,
      edgeCount,
      entityNodes: distinctEntities.length,
      conversationNodes: conversations.length,
      toolNodes: distinctTools.length,
      coOccurrenceEdges,
      mentionedInEdges,
      usesToolEdges,
    };
  } finally {
    db.close();
  }
}
