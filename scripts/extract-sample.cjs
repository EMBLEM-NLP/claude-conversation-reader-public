const Database = require('better-sqlite3');
const fs = require('fs');

const db = new Database('.ccr-import.sqlite', { readonly: true });

// Simple fast queries - no expensive JOINs
const convs = db.prepare('SELECT uuid, name as title, created_at FROM conversations ORDER BY RANDOM() LIMIT 100').all();

const getMsgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_uuid = ?');
const getFirstMsg = db.prepare("SELECT SUBSTR(text, 1, 500) as txt FROM messages WHERE conversation_uuid = ? AND sender = 'human' AND text IS NOT NULL LIMIT 1");
const getTopics = db.prepare("SELECT GROUP_CONCAT(DISTINCT entity) as t FROM entities WHERE conversation_uuid = ? AND type = 'topic'");
const getToolEntities = db.prepare("SELECT GROUP_CONCAT(DISTINCT entity) as t FROM entities WHERE conversation_uuid = ? AND type = 'tool'");

const sample = convs.map(c => ({
  uuid: c.uuid,
  title: c.title,
  created_at: c.created_at,
  msg_count: getMsgCount.get(c.uuid).c,
  first_human_msg: (getFirstMsg.get(c.uuid) || {}).txt || null,
  topics: (getTopics.get(c.uuid) || {}).t || null,
  tools: (getToolEntities.get(c.uuid) || {}).t || null,
}));

console.log('Sample:', sample.length);
console.log('With titles:', sample.filter(s => s.title && s.title !== 'Untitled').length);
console.log('With topics:', sample.filter(s => s.topics).length);
console.log('With tools:', sample.filter(s => s.tools).length);

fs.writeFileSync('sample-conversations.json', JSON.stringify(sample, null, 2));
console.log('Saved sample-conversations.json');
db.close();
