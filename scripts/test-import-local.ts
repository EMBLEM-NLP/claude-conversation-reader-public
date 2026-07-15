/**
 * @file test-import-local.ts
 * @description Quick debug script for import-local-sessions
 * @version 1.0.0
 * @created 2026-05-26T22:22:52Z
 * @lastUpdated 2026-05-26T22:22:52Z
 */
import { importLocalSessions } from '../src/importers/import-local-sessions.js';
import { tmpdir } from 'os';
import { join } from 'path';

const dbPath = join(tmpdir(), 'ccr-test-import.sqlite');
console.log('DB:', dbPath);

const result = await importLocalSessions({
  dbPath,
  filter: ['303900f2-4788-4893-a3df-c72b45eccb0d'],
  onProgress: (msg) => console.log('  ' + msg),
});

console.log('\nResult:', JSON.stringify(result, null, 2));
