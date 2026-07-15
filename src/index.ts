#!/usr/bin/env node
/**
 * @file index.ts
 * @description Commander.js CLI entry point with 39 commands
 * @version 1.11.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2026-05-27T18:50:00Z
 */

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { login } from './auth/claude-login.js';
import { grabCookiesFromChrome } from './auth/cookie-grabber.js';
import { discoverCodeApi, normalizeSessionId } from './auth/discover-code-api.js';
import { fetchAndDumpCodeSession, normalizeCodeSessionId } from './api/code-session-client.js';
import { readLocalSession, findLocalSessionFile, listLocalSessions } from './importers/session-reader.js';
import { loadSession, isSessionValid, clearSession, saveSessionFromCookieString } from './auth/session.js';
import { createClient } from './api/client.js';
import { flattenConversation } from './extractors/conversation.js';
import { formatConversation } from './extractors/formatter.js';
import { searchConversations } from './extractors/search.js';
import { importConversationsToSqlite, cacheProjects } from './importers/import-sqlite.js';
import { importLocalSessions } from './importers/import-local-sessions.js';
import { importCodeSession } from './importers/import-code-session.js';
import { generateTitle } from './importers/ai-titler.js';
import { scaffoldProject, slugify } from './importers/project-downloader.js';
import { SPEAKER_PDFS, extractSpeakerImage, type ExtractionMode } from './importers/speaker-image-extractor.js';
import {
  searchMessages, searchMessagesGrouped,
  searchThinking, searchThinkingGrouped,
  searchByToolName, searchByToolNameGrouped,
  searchContent, searchContentGrouped,
} from './importers/sqlite-search.js';
import { extractEntities } from './importers/entity-extract.js';
import { profileConversations, getProfiles } from './importers/conversation-profiler.js';
import { searchByEntity, searchByEntityGrouped } from './importers/entity-search.js';
import { conversationUrl, projectUrl } from './utils/links.js';
import { renameUntitled } from './importers/conversation-renamer.js';
import {
  getEditHistory, searchAttachments, getMainBranch,
  getConversationBranches, getThread,
  getUntitledConversations, getEmptyConversations, getConversationStats,
  deleteConversationLocal, getFullStats,
} from './importers/advanced-queries.js';
import {
  buildGraph, clusterGraph, categorizeConversations,
  queryGraph, shortestPath,
  godNodes, bridgeEntities, temporalBursts, suggestQuestions, toolUsageStats,
  toHtml,
} from './graph/index.js';
import path from 'path';
import type { OutputFormat } from './types.js';

function parsePositiveInt(value: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) throw new Error(`Invalid limit: "${value}". Must be a positive integer.`);
  return n;
}

function formatGrouped(row: {
  name: string; hit_count: number; conversation_uuid: string;
  project_uuid: string | null; project_name: string | null;
  top_snippets: Array<{ sender: string; text: string; created_at: string }>;
}): string {
  const proj = row.project_uuid
    ? `\n${chalk.gray('In project:')} ${row.project_name || row.project_uuid.slice(0, 8)} — ${chalk.cyan(projectUrl(row.project_uuid))}`
    : '';
  const snips = row.top_snippets
    .map(s => `  ${chalk.gray('[' + s.created_at + ']')} ${s.sender}: ${s.text.substring(0, 200)}`)
    .join('\n');
  return [
    `---`,
    `${chalk.white(row.name)}  ${chalk.yellow('(' + row.hit_count + ' hit' + (row.hit_count !== 1 ? 's' : '') + ')')}`,
    chalk.cyan(conversationUrl(row.conversation_uuid)),
    `${chalk.gray('UUID:')} ${row.conversation_uuid}${proj}`,
    snips,
  ].join('\n');
}

const program = new Command();

program
  .name('ccr')
  .description('Read Claude.ai conversation threads')
  .version('0.1.0');

// ── login ───────────────────────────────────────────────────────

program
  .command('login')
  .description('Authenticate with Claude.ai via browser or cookie string')
  .option('--headless', 'Run browser in headless mode')
  .option('--cookie <string>', 'Paste cookie string from browser DevTools (skips Playwright)')
  .action(async (opts) => {
    if (opts.cookie) {
      try {
        await saveSessionFromCookieString(opts.cookie);
        console.log(chalk.green('Session saved from cookie string.'));
      } catch (err) {
        console.error(chalk.red(`Failed: ${(err as Error).message}`));
        process.exitCode = 1;
      }
      return;
    }
    const spinner = ora('Opening browser for Claude.ai login...').start();
    try {
      await login({ headed: !opts.headless });
      spinner.succeed(chalk.green('Logged in and session saved.'));
    } catch (err) {
      spinner.fail(chalk.red(`Login failed: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });

// ── grab-cookie ─────────────────────────────────────────────────

program
  .command('grab-cookie')
  .description('Extract claude.ai cookies from a running Chrome/Edge via CDP — no re-login needed. Use --auto-restart to close and relaunch the browser with the debug flag automatically.')
  .option('-p, --port <number>', 'Chrome DevTools Protocol port', '9222')
  .option('--auto-restart', 'Close and relaunch the browser with --remote-debugging-port automatically')
  .option('--browser <name>', 'Browser to use: chrome or edge', 'chrome')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const browserChoice = (opts.browser === 'edge' ? 'edge' : 'chrome') as 'chrome' | 'edge';
    const spinner = ora(`Connecting to ${browserChoice} on port ${port}...`).start();
    try {
      const session = await grabCookiesFromChrome({
        port,
        autoRestart: !!opts.autoRestart,
        browser: browserChoice,
        onProgress: (msg) => { spinner.text = msg; },
      });
      const hasSessionKey = session.raw.some((c) => c.name === 'sessionKey');
      spinner.succeed(
        chalk.green(`Session saved — ${session.raw.length} cookie(s) grabbed from ${browserChoice}.`) +
        (hasSessionKey ? chalk.gray(' (sessionKey ✓)') : chalk.yellow(' (warning: no sessionKey found)')),
      );
      console.log(chalk.gray('Run `ccr status` to verify.'));
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── discover-code-api ───────────────────────────────────────────

program
  .command('discover-code-api <sessionIdOrUrl>')
  .description(
    'Reverse-engineer the claude.ai/code session API by loading a saved session into Playwright, ' +
    'navigating to the page, and capturing every matching request/response. ' +
    'Accepts a full URL, "session_..." slug, or bare ID.',
  )
  .option('--headless', 'Run browser headless (default: headed)')
  .option('--filter <substring>', 'Only capture URLs containing this substring', 'claude.ai/api')
  .option('-o, --output <path>', 'Write the full JSON dump to this path (default: ./code-api-<id>.json)')
  .option('--idle-timeout <ms>', 'How long to wait for networkidle after navigation', parsePositiveInt, 8000 as unknown as number)
  .option('--dwell <ms>', 'Extra dwell time after networkidle to catch pollers', parsePositiveInt, 2000 as unknown as number)
  .option('--include-static', 'Also capture images/css/fonts (default: skipped)')
  .action(async (sessionIdOrUrl: string, opts) => {
    const normalized = normalizeSessionId(sessionIdOrUrl);
    const outputPath = opts.output ?? path.resolve(`code-api-${normalized}.json`);
    const spinner = ora(`Discovering API surface for ${normalized}…`).start();
    try {
      const result = await discoverCodeApi(sessionIdOrUrl, {
        headed: !opts.headless,
        filter: opts.filter,
        outputPath,
        idleTimeoutMs: opts.idleTimeout,
        dwellMs: opts.dwell,
        includeStatic: !!opts.includeStatic,
      });
      spinner.succeed(
        chalk.green(
          `Captured ${result.metadata.totalExchanges} HTTP exchange(s) and ${result.websockets.length} WebSocket(s) — wrote ${outputPath}`,
        ),
      );
      console.log();
      console.log(chalk.bold('Page state:'));
      console.log(`  Final URL    : ${result.pageState.finalUrl}`);
      console.log(`  Redirected   : ${result.pageState.redirected ? chalk.yellow('YES') : 'no'}`);
      console.log(`  Title        : ${result.pageState.title}`);
      console.log(`  Body chars   : ${result.pageState.bodyTextSnippet.length}`);
      if (result.pageState.consoleErrors.length > 0) {
        console.log(chalk.red(`  Console errors: ${result.pageState.consoleErrors.length}`));
        for (const e of result.pageState.consoleErrors.slice(0, 5)) console.log(chalk.gray(`    - ${e.slice(0, 200)}`));
      }
      if (result.websockets.length > 0) {
        console.log();
        console.log(chalk.bold('WebSocket connections:'));
        for (const ws of result.websockets) {
          console.log(`  ${chalk.cyan(ws.url)}  sent=${ws.framesSent} recv=${ws.framesReceived} ${ws.closedAt ? 'closed' : 'open'}`);
        }
      }
      console.log();
      console.log(chalk.bold('Endpoint summary (templatized):'));
      if (result.summary.length === 0) {
        console.log(chalk.yellow('  (no matching requests — try widening --filter or --idle-timeout)'));
      } else {
        for (const s of result.summary) {
          const status = s.sampleStatus ? chalk.gray(`${s.sampleStatus}`) : chalk.red('---');
          const ct = s.sampleContentType ? chalk.gray(s.sampleContentType.split(';')[0]) : '';
          console.log(`  ${chalk.cyan(s.method.padEnd(6))} ${status}  ${chalk.white(s.template)}  ${chalk.gray('×' + s.count)}  ${ct}`);
        }
      }
      console.log();
      console.log(chalk.gray(`Full dump: ${outputPath}`));
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── read-session ─────────────────────────────────────────────────

program
  .command('read-session [pathOrId]')
  .description(
    'Read a local Claude Code JSONL session file. ' +
    'Pass a file path, a session UUID, or omit to list available sessions.',
  )
  .option('-f, --format <format>', 'Output format: markdown | json | compact', 'markdown')
  .option('-n, --limit <number>', 'Max messages to show', parsePositiveInt, undefined as unknown as number)
  .option('--tools', 'Show tool-use blocks inline')
  .option('--thinking', 'Show <thinking> blocks inline')
  .action(async (pathOrId: string | undefined, opts) => {
    const format = (opts.format as 'markdown' | 'json' | 'compact') ?? 'markdown';

    // No argument → list all available sessions
    if (!pathOrId) {
      const spinner = ora('Scanning ~/.claude/projects/...').start();
      try {
        const sessions = await listLocalSessions();
        spinner.stop();
        if (sessions.length === 0) {
          console.log(chalk.yellow('No local sessions found under ~/.claude/projects/'));
          return;
        }
        console.log(chalk.bold(`Found ${sessions.length} local session(s):\n`));
        for (const s of sessions) {
          console.log(`  ${chalk.cyan(s.sessionId)}  ${chalk.gray(s.cwd)}`);
          console.log(`    ${chalk.gray(s.path)}`);
        }
        console.log(chalk.gray('\nRun: ccr read-session <sessionId>  to read one.'));
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
      return;
    }

    // Resolve path: if it looks like a UUID/session ID (no separators), search for it
    let filePath = pathOrId;
    const looksLikeId = !pathOrId.includes('/') && !pathOrId.includes('\\') && !pathOrId.endsWith('.jsonl');
    if (looksLikeId) {
      const spinner = ora(`Looking up session ${pathOrId}...`).start();
      const found = await findLocalSessionFile(pathOrId);
      if (!found) {
        spinner.fail(chalk.red(`Session not found: ${pathOrId}`));
        process.exitCode = 1;
        return;
      }
      spinner.succeed(chalk.gray(`Found: ${found}`));
      filePath = found;
    }

    const spinner = ora(`Reading ${path.basename(filePath)}...`).start();
    try {
      const conv = await readLocalSession(filePath, {
        showTools: !!opts.tools,
        showThinking: !!opts.thinking,
        limit: opts.limit as number | undefined,
      });
      spinner.stop();
      const output = formatConversation(conv, format);
      console.log(output);
      if (format !== 'json') {
        console.log(chalk.gray(`\n— ${conv.messages.length} message(s) · session ${conv.uuid.slice(0, 8)}`));
      }
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── status ──────────────────────────────────────────────────────

program
  .command('status')
  .description('Check if current session is valid')
  .action(async () => {
    const valid = await isSessionValid();
    if (valid) {
      console.log(chalk.green('Session is valid.'));
    } else {
      console.log(chalk.yellow('No valid session. Run `ccr login` to authenticate.'));
    }
  });

// ── logout ──────────────────────────────────────────────────────

program
  .command('logout')
  .description('Clear saved session')
  .action(async () => {
    await clearSession();
    console.log(chalk.green('Session cleared.'));
  });

// ── list ────────────────────────────────────────────────────────

program
  .command('list')
  .description('List recent conversations')
  .option('-q, --query <text>', 'Filter by title')
  .option('-n, --limit <number>', 'Max results', '20')
  .action(async (opts) => {
    const spinner = ora('Fetching conversations...').start();
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');

      let conversations = await client.listConversations(orgs[0].uuid);
      conversations = searchConversations(conversations, {
        query: opts.query,
        limit: parseInt(opts.limit, 10),
      });

      spinner.stop();
      if (conversations.length === 0) {
        console.log(chalk.yellow('No conversations found.'));
        return;
      }

      for (const c of conversations) {
        const date = new Date(c.updated_at).toLocaleDateString();
        console.log(`${chalk.cyan(c.uuid)}  ${chalk.white(c.name)}  ${chalk.gray(date)}`);
      }
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── get ─────────────────────────────────────────────────────────

program
  .command('get <conversation-id>')
  .description('Fetch and display a conversation')
  .option('-f, --format <type>', 'Output format: markdown, json, compact', 'markdown')
  .action(async (conversationId: string, opts) => {
    const spinner = ora('Fetching conversation...').start();
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');

      const tree = await client.getConversation(orgs[0].uuid, conversationId);
      const linear = flattenConversation(tree);
      const output = formatConversation(linear, opts.format as OutputFormat);

      spinner.stop();
      console.log(output);
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── search ──────────────────────────────────────────────────────

program
  .command('search <query>')
  .description('Search conversations by title')
  .option('--after <date>', 'Only after this date (ISO)')
  .option('--before <date>', 'Only before this date (ISO)')
  .option('-n, --limit <number>', 'Max results', '20')
  .action(async (query: string, opts) => {
    const spinner = ora('Searching...').start();
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');

      const all = await client.listConversations(orgs[0].uuid);
      const results = searchConversations(all, {
        query,
        after: opts.after,
        before: opts.before,
        limit: parseInt(opts.limit, 10),
      });

      spinner.stop();
      if (results.length === 0) {
        console.log(chalk.yellow('No matching conversations.'));
        return;
      }

      for (const c of results) {
        const date = new Date(c.updated_at).toLocaleDateString();
        console.log(`${chalk.white(c.name || '(untitled)')}  ${chalk.gray(date)}`);
        console.log(chalk.cyan(conversationUrl(c.uuid)));
        console.log(`${chalk.gray('UUID:')} ${c.uuid}\n`);
      }
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── search-sqlite ──────────────────────────────────────────────────────

program
  .command('search-sqlite <dbPath> <query>')
  .option('-l, --limit <n>', 'Limit results', parsePositiveInt)
  .description('Full-text search messages in imported SQLite DB')
  .action((dbPath, query, options) => {
    try {
      const results = searchMessagesGrouped(path.resolve(dbPath), query, options.limit || 10);
      for (const row of results) console.log(formatGrouped(row) + '\n');
      if (results.length === 0) console.log('No results.');
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── search-entity ──────────────────────────────────────────────────────

program
  .command('search-entity <dbPath> <entity>')
  .option('-t, --type <type>', 'Entity type (topic, url, uuid)')
  .option('-l, --limit <n>', 'Limit results', parsePositiveInt)
  .description('Search messages by extracted entity in SQLite DB')
  .action((dbPath, entity, options) => {
    try {
      const results = searchByEntityGrouped(path.resolve(dbPath), entity, options.type, options.limit || 10);
      for (const row of results) console.log(formatGrouped(row) + '\n');
      if (results.length === 0) console.log('No results.');
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── import-local-sessions ──────────────────────────────────────────────

program
  .command('import-local-sessions [dbPath]')
  .description(
    'Import local Claude Code JSONL session files into the SQLite FTS5 database. ' +
    'Scans ~/.claude/projects/ and upserts sessions alongside any existing Claude export data. ' +
    'Skips sessions already present (use --force to reimport).',
  )
  .option('--db <path>', 'SQLite database path', '.ccr-import.sqlite')
  .option('--force', 'Reimport sessions already in the database')
  .option('--sessions-dir <path>', 'Custom sessions directory (default: ~/.claude/projects/)')
  .option('--only <ids...>', 'Import only these session IDs or paths (space-separated)')
  .action(async (dbPathArg: string | undefined, opts) => {
    const dbPath = path.resolve(dbPathArg ?? opts.db);
    const spinner = ora('Importing local Claude Code sessions...').start();
    try {
      const result = await importLocalSessions({
        dbPath,
        force: !!opts.force,
        sessionsDir: opts.sessionsDir ? path.resolve(opts.sessionsDir) : undefined,
        filter: opts.only,
        onProgress: (msg) => { spinner.text = msg; },
      });
      spinner.succeed(
        chalk.green(
          `Imported ${result.imported} session(s) — ` +
          `${result.messageCount} messages, ${result.blockCount} content blocks`,
        ) +
        (result.skipped > 0 ? chalk.gray(` (${result.skipped} skipped, already in DB)`) : '') +
        (result.errors > 0 ? chalk.yellow(` (${result.errors} errors)`) : ''),
      );
      console.log(chalk.gray(`Database: ${dbPath}`));
      console.log(chalk.gray('Run `ccr search-sqlite <query> <db>` to search all imported sessions.'));
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── get-code-session ───────────────────────────────────────────────────

program
  .command('get-code-session <sessionIdOrUrl>')
  .description(
    'Fetch a claude.ai/code session by ID or URL, save it to disk, and import ' +
    'into the SQLite DB in one step. Uses Playwright APIRequestContext to ' +
    'bypass Cloudflare. Accepts full URL, "session_..." slug, or bare ID.',
  )
  .option('-d, --db <path>', 'Path to SQLite DB', '.ccr-import.sqlite')
  .option('-o, --output <path>', 'JSON dump path (default: fetched-<id>.json)')
  .option('--no-import', 'Only fetch + save the JSON, skip the SQLite import')
  .option('--headed', 'Show the underlying browser window (default: headless)')
  .action(async (sessionIdOrUrl: string, opts) => {
    const id = normalizeCodeSessionId(sessionIdOrUrl);
    const outputPath = path.resolve(opts.output ?? `fetched-${id}.json`);
    const spinner = ora(`Fetching ${id}…`).start();
    try {
      const session = await loadSession();
      const fetched = await fetchAndDumpCodeSession(session, id, outputPath, {
        headless: !opts.headed,
      });
      spinner.succeed(
        chalk.green(
          `Fetched "${fetched.meta.title}" — ${fetched.eventCount} event(s) → ${outputPath}`,
        ),
      );
      if (opts.import !== false) {
        const importSpinner = ora(`Importing into ${opts.db}…`).start();
        const r = importCodeSession({ jsonPath: outputPath, dbPath: path.resolve(opts.db) });
        importSpinner.succeed(
          chalk.green(
            `Imported "${r.title}" — ${r.messagesInserted} message(s), ${r.contentBlocksInserted} content block(s).`,
          ),
        );
        if (r.eventsSkipped > 0) {
          const skipList = Object.entries(r.skippedTypes)
            .sort((a, b) => b[1] - a[1])
            .map(([t, c]) => `${t}=${c}`)
            .join(', ');
          console.log(chalk.gray(`  Skipped ${r.eventsSkipped} non-message event(s): ${skipList}`));
        }
      } else {
        console.log(chalk.gray('  --no-import set, leaving the JSON dump in place.'));
      }
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── import-code-session ────────────────────────────────────────────────

program
  .command('import-code-session <jsonPath>')
  .description(
    'Import a claude.ai/code session JSON (produced by scripts/fetch-code-session.ts) ' +
    'into CCR\'s SQLite DB. Additive — does not drop existing tables. ' +
    'After import, graph-build/profile/search-sqlite all work on the new data.',
  )
  .option('-d, --db <path>', 'Path to SQLite DB', '.ccr-import.sqlite')
  .action((jsonPath, opts) => {
    const spinner = ora(`Importing ${jsonPath} → ${opts.db}…`).start();
    try {
      const r = importCodeSession({
        jsonPath: path.resolve(jsonPath),
        dbPath: path.resolve(opts.db),
      });
      spinner.succeed(
        chalk.green(
          `Imported "${r.title}" (${r.sessionId.slice(0, 28)}…) — ` +
          `${r.messagesInserted} message(s), ${r.contentBlocksInserted} content block(s).`,
        ),
      );
      if (r.eventsSkipped > 0) {
        const skipList = Object.entries(r.skippedTypes)
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `${t}=${c}`)
          .join(', ');
        console.log(chalk.gray(`  Skipped ${r.eventsSkipped} non-message event(s): ${skipList}`));
      }
      console.log(chalk.gray(`\nNext steps:`));
      console.log(chalk.gray(`  npm run dev -- search-sqlite ${opts.db} "<query>"`));
      console.log(chalk.gray(`  npm run dev -- graph-build ${opts.db}`));
      console.log(chalk.gray(`  npm run dev -- profile ${opts.db}`));
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── import-sqlite ──────────────────────────────────────────────────────

program
  .command('import-sqlite <exportPath> <dbPath>')
  .description('Import Claude export JSON into a SQLite FTS5 database')
  .action((exportPath, dbPath) => {
    try {
      importConversationsToSqlite({
        exportPath: path.resolve(exportPath),
        dbPath: path.resolve(dbPath),
      });
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

program
  .command('extract-entities <dbPath>')
  .description('Extract entities from all messages in the SQLite DB')
  .action((dbPath) => {
    try {
      extractEntities(path.resolve(dbPath));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── profile ───────────────────────────────────────────────────
program
  .command('profile <dbPath>')
  .description('Build semantic profiles for all conversations (20 regex categories + structural metrics)')
  .option('--verbose', 'Print per-conversation details')
  .action((dbPath, options) => {
    try {
      const result = profileConversations(path.resolve(dbPath), { verbose: options.verbose });
      console.log(chalk.green(`Profiled ${result.totalProfiled} conversations.`));
      console.log(`  Avg technical density: ${result.avgDensity.toFixed(3)}`);
      console.log(chalk.white('  Type distribution:'));
      for (const [type, count] of Object.entries(result.typeDistribution).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${type.padEnd(10)} ${count}`);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── profile-query ─────────────────────────────────────────────
program
  .command('profile-query <dbPath>')
  .description('Query conversation profiles by type or density')
  .option('-t, --type <type>', 'Filter by primary_type (coding, devops, research, qa, general)')
  .option('-d, --min-density <n>', 'Minimum technical density (0.0–1.0)', parseFloat)
  .option('-l, --limit <n>', 'Limit results', parsePositiveInt)
  .option('--order <field>', 'Order by: technical_density, code_blocks, tool_invocations, total_words, duration_minutes', 'technical_density')
  .action((dbPath, options) => {
    try {
      const profiles = getProfiles(path.resolve(dbPath), {
        primaryType: options.type,
        minDensity: options.minDensity,
        limit: options.limit ?? 20,
        orderBy: options.order as 'technical_density' | 'code_blocks' | 'tool_invocations' | 'total_words' | 'duration_minutes',
      });
      if (profiles.length === 0) {
        console.log(chalk.yellow('No profiles found. Run `ccr profile <db>` first.'));
        return;
      }
      for (const p of profiles) {
        const name = p.conversation_name || p.conversation_uuid.slice(0, 12);
        console.log(`  ${chalk.white(name)}`);
        console.log(`    type=${chalk.cyan(p.primary_type)} density=${p.technical_density.toFixed(3)} words=${p.total_words} duration=${p.duration_minutes}m`);
        console.log(`    code_blocks=${p.code_blocks} tools=${p.tool_invocations} thinking=${p.thinking_blocks}`);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── advanced-queries: edit-history ─────────────────────────────
program
  .command('edit-history <dbPath> <messageUuid>')
  .description('Show edit history for a message (by uuid)')
  .action((dbPath, messageUuid) => {
    try {
      const rows = getEditHistory(path.resolve(dbPath), messageUuid);
      for (const row of rows) {
        console.log(`---\n[${row.created_at}] ${row.sender}: ${row.text}`);
      }
      if (rows.length === 0) console.log('No edit history found.');
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── advanced-queries: search-attachments ──────────────────────
program
  .command('search-attachments <dbPath> <query>')
  .option('-l, --limit <n>', 'Limit results', parsePositiveInt)
  .description('Search for attachments by filename or keyword')
  .action((dbPath, query, options) => {
    try {
      const rows = searchAttachments(path.resolve(dbPath), query, options.limit || 10);
      const groups = new Map<string, typeof rows>();
      for (const row of rows) {
        const uuid = row.conversation_uuid as string;
        if (!groups.has(uuid)) groups.set(uuid, []);
        groups.get(uuid)!.push(row);
      }
      if (groups.size === 0) { console.log('No attachments found.'); return; }
      for (const [convUuid, convRows] of groups) {
        const name = (convRows[0].name as string) || '(untitled)';
        const count = convRows.length;
        console.log(`---\n${chalk.white(name)}  ${chalk.yellow('(' + count + ' match' + (count !== 1 ? 'es' : '') + ')')}`);
        console.log(chalk.cyan(conversationUrl(convUuid)));
        console.log(`${chalk.gray('UUID:')} ${convUuid}`);
        for (const r of convRows.slice(0, 3)) {
          const attPreview = String(r.attachments).substring(0, 100);
          console.log(`  ${chalk.gray('[' + r.created_at + ']')} ${r.sender}: ${attPreview}`);
        }
        console.log('');
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── advanced-queries: main-branch ─────────────────────────────
program
  .command('main-branch <dbPath> <conversationUuid>')
  .description('Show the main branch (linearized) of a conversation')
  .action((dbPath, conversationUuid) => {
    try {
      const rows = getMainBranch(path.resolve(dbPath), conversationUuid);
      for (const row of rows) {
        console.log(`---\n[${row.created_at}] ${row.sender}: ${row.text}`);
      }
      if (rows.length === 0) console.log('No messages found for main branch.');
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── search-thinking ──────────────────────────────────────────
program
  .command('search-thinking <dbPath> <query>')
  .option('-l, --limit <n>', 'Limit results', parsePositiveInt)
  .description('Search Claude\'s thinking/reasoning blocks in SQLite DB')
  .action((dbPath, query, options) => {
    try {
      const results = searchThinkingGrouped(path.resolve(dbPath), query, options.limit || 10);
      for (const row of results) console.log(formatGrouped(row) + '\n');
      if (results.length === 0) console.log('No thinking blocks found.');
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── search-tools ─────────────────────────────────────────────
program
  .command('search-tools <dbPath> <toolName>')
  .option('-l, --limit <n>', 'Limit results', parsePositiveInt)
  .description('Find messages where Claude used a specific tool')
  .action((dbPath, toolName, options) => {
    try {
      const results = searchByToolNameGrouped(path.resolve(dbPath), toolName, options.limit || 10);
      for (const row of results) console.log(formatGrouped(row) + '\n');
      if (results.length === 0) console.log('No tool calls found.');
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── search-content ───────────────────────────────────────────
program
  .command('search-content <dbPath> <query>')
  .option('-t, --type <blockType>', 'Filter by block type (text, thinking, tool_use, tool_result, voice_note)')
  .option('-l, --limit <n>', 'Limit results', parsePositiveInt)
  .description('Search all content blocks with optional type filter')
  .action((dbPath, query, options) => {
    try {
      const results = searchContentGrouped(path.resolve(dbPath), query, options.type, options.limit || 10);
      for (const row of results) console.log(formatGrouped(row) + '\n');
      if (results.length === 0) console.log('No content blocks found.');
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── extract-attachments ─────────────────────────────────────
program
  .command('extract-attachments <conversation-id> [outputDir]')
  .description('Download uploaded documents from a conversation')
  .action(async (conversationId: string, outputDir?: string) => {
    const spinner = ora('Fetching conversation...').start();
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');

      const tree = await client.getConversation(orgs[0].uuid, conversationId);
      const messages = tree.chat_messages ?? [];
      const outDir = path.resolve(outputDir || './attachments');

      let count = 0;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const attachments = (msg as unknown as Record<string, unknown>).attachments as Array<{ id: string; file_name: string; file_type: string; extracted_content: string }> | undefined;
        if (!attachments || attachments.length === 0) continue;
        for (const att of attachments) {
          if (!att.extracted_content) continue;
          const ext = att.file_type || 'txt';
          const name = att.file_name || `msg${i + 1}_${att.id.slice(0, 8)}.${ext}`;
          const filePath = path.join(outDir, name || `msg${i + 1}_${count + 1}.${ext}`);
          const { mkdirSync, writeFileSync } = await import('fs');
          mkdirSync(outDir, { recursive: true });
          writeFileSync(filePath, att.extracted_content, 'utf-8');
          count++;
          console.log(`  Saved: ${filePath} (${att.file_type}, ${att.extracted_content.length} chars)`);
        }
      }

      spinner.stop();
      if (count === 0) {
        console.log(chalk.yellow('No attachments found in this conversation.'));
      } else {
        console.log(chalk.green(`\n${count} attachment(s) saved to ${outDir}`));
      }
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── extract-artifacts ───────────────────────────────────────
program
  .command('extract-artifacts <conversation-id> [outputDir]')
  .description('Export generated artifacts from a conversation to files')
  .action(async (conversationId: string, outputDir?: string) => {
    const spinner = ora('Fetching conversation...').start();
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');

      const tree = await client.getConversation(orgs[0].uuid, conversationId);
      const messages = tree.chat_messages ?? [];
      const outDir = path.resolve(outputDir || './artifacts');

      const typeToExt: Record<string, string> = {
        'text/markdown': 'md', 'text/html': 'html', 'text/css': 'css',
        'text/javascript': 'js', 'application/json': 'json', 'text/plain': 'txt',
        'text/x-python': 'py', 'text/x-typescript': 'ts', 'text/x-rust': 'rs',
        'text/x-go': 'go', 'text/x-java': 'java', 'text/x-c': 'c',
        'image/svg+xml': 'svg', 'text/csv': 'csv',
      };

      let count = 0;
      for (const msg of messages) {
        if (!msg.content) continue;
        for (const block of msg.content) {
          if (block.type !== 'tool_use' || block.name !== 'artifacts') continue;
          const input = block.input as { command?: string; title?: string; type?: string; content?: string } | undefined;
          if (!input || input.command !== 'create' || !input.content) continue;

          const ext = typeToExt[input.type || ''] || 'txt';
          const slug = (input.title || `artifact_${count + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
          const filePath = path.join(outDir, `${slug}.${ext}`);
          const { mkdirSync, writeFileSync } = await import('fs');
          mkdirSync(outDir, { recursive: true });
          writeFileSync(filePath, input.content, 'utf-8');
          count++;
          console.log(`  Saved: ${filePath} (${input.type}, "${input.title}")`);
        }
      }

      spinner.stop();
      if (count === 0) {
        console.log(chalk.yellow('No artifacts found in this conversation.'));
      } else {
        console.log(chalk.green(`\n${count} artifact(s) saved to ${outDir}`));
      }
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── stats ───────────────────────────────────────────────────
program
  .command('stats <dbPath>')
  .description('Show comprehensive usage statistics from the SQLite database')
  .action((dbPath) => {
    try {
      const s = getFullStats(path.resolve(dbPath));

      console.log(chalk.cyan('\n═══ Claude.ai Usage Statistics ═══\n'));

      console.log(chalk.white('Conversations'));
      console.log(`  Total:        ${s.conversations.total}`);
      console.log(`  Untitled:     ${s.conversations.untitled}`);
      console.log(`  Empty:        ${s.conversations.empty}`);
      console.log(`  In projects:  ${s.conversations.withProject}`);

      console.log(chalk.white('\nMessages'));
      console.log(`  Total:        ${s.messages.total}`);
      console.log(`  Human:        ${s.messages.human} (prompts)`);
      console.log(`  Assistant:    ${s.messages.assistant}`);
      console.log(`  Avg/conv:     ${s.messages.avgPerConversation}`);

      console.log(chalk.white('\nContent Blocks') + chalk.gray(` (${s.contentBlocks.total} total)`));
      for (const t of s.contentBlocks.byType) {
        console.log(`  ${t.type.padEnd(14)} ${t.count.toLocaleString()}`);
      }

      console.log(chalk.white('\nThinking'));
      console.log(`  Total blocks: ${s.thinking.total.toLocaleString()}`);
      console.log(`  Avg/response: ${s.thinking.avgPerAssistantMessage}`);

      console.log(chalk.white('\nDate Range'));
      console.log(`  First:        ${new Date(s.dateRange.first).toLocaleDateString()}`);
      console.log(`  Last:         ${new Date(s.dateRange.last).toLocaleDateString()}`);

      console.log(chalk.white('\nMonthly Activity'));
      for (const m of s.monthlyActivity) {
        const bar = '█'.repeat(Math.min(40, Math.round(m.count / 30)));
        console.log(`  ${m.month}  ${bar} ${m.count}`);
      }

      console.log(chalk.white('\nTop Conversations'));
      for (const c of s.topConversations) {
        console.log(`  ${String(c.messageCount).padStart(4)} msgs  ${c.name || '(untitled)'}`);
      }

      console.log(chalk.white('\nTop Tools'));
      for (const t of s.topTools) {
        console.log(`  ${String(t.count).padStart(6)} calls  ${t.name}`);
      }

      console.log(chalk.white('\nEntities') + chalk.gray(` (${s.entities.total.toLocaleString()} total)`));
      for (const t of s.entities.byType) {
        console.log(`  ${t.type.padEnd(8)} ${t.count.toLocaleString()}`);
      }

      console.log('');
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── projects ────────────────────────────────────────────────
program
  .command('projects [project-uuid]')
  .description('List all projects, or conversations in a specific project')
  .option('--archived', 'Include archived projects')
  .option('-n, --limit <number>', 'Max conversations to show', '20')
  .action(async (projectUuid: string | undefined, opts) => {
    const spinner = ora('Fetching...').start();
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');

      if (projectUuid) {
        // List conversations in a specific project
        const conversations = await client.listConversations(orgs[0].uuid, projectUuid);
        spinner.stop();
        if (conversations.length === 0) {
          console.log(chalk.yellow('No conversations in this project.'));
          return;
        }
        const limited = conversations.slice(0, parseInt(opts.limit, 10));
        console.log(chalk.cyan(`${conversations.length} conversations in project:\n`));
        for (const c of limited) {
          const date = new Date(c.updated_at).toLocaleDateString();
          console.log(`  ${chalk.white(c.name || '(untitled)')}  ${chalk.gray(date)}`);
          console.log(`  ${chalk.cyan(conversationUrl(c.uuid))}\n`);
        }
        if (conversations.length > limited.length) {
          console.log(chalk.gray(`  ... and ${conversations.length - limited.length} more (use -n to show more)`));
        }
      } else {
        // List all projects
        let projects = await client.listProjects(orgs[0].uuid);
        if (!opts.archived) {
          projects = projects.filter((p) => !p.archived_at);
        }
        spinner.stop();
        if (projects.length === 0) {
          console.log(chalk.yellow('No projects found.'));
          return;
        }
        console.log(chalk.cyan(`${projects.length} projects:\n`));
        for (const p of projects) {
          const starred = p.is_starred ? chalk.yellow(' *') : '';
          const archived = p.archived_at ? chalk.gray(' [archived]') : '';
          const desc = p.description ? chalk.gray(` — ${p.description.slice(0, 60)}`) : '';
          console.log(`  ${chalk.white(p.name)}${starred}${archived}${desc}`);
          console.log(`  ${chalk.cyan(projectUrl(p.uuid))}`);
          console.log(`  ${chalk.gray(`docs: ${p.docs_count} | files: ${p.files_count} | ${new Date(p.updated_at).toLocaleDateString()}`)}\n`);
        }
      }
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── cache-projects ──────────────────────────────────────────
program
  .command('cache-projects <dbPath>')
  .description('Fetch project names from Claude.ai and cache them in the local SQLite DB for richer search output')
  .action(async (dbPath) => {
    const spinner = ora('Fetching projects...').start();
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');
      const projects = await client.listProjects(orgs[0].uuid);
      const count = cacheProjects(path.resolve(dbPath), projects.map(p => ({ uuid: p.uuid, name: p.name })));
      spinner.succeed(chalk.green(`Cached ${count} project name${count !== 1 ? 's' : ''} in ${path.basename(dbPath)}`));
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── probe-project-api ────────────────────────────────────────
// Probes undocumented Claude.ai endpoints for project creation and conversation moves.
// Creates a throwaway project, moves one conversation into it, then reverses and cleans up.
program
  .command('probe-project-api')
  .description('Probe Claude.ai API for create-project and move-conversation endpoints (read-probe, cleans up after itself)')
  .action(async () => {
    const PROBE_CONV = '54db5ad6-e91b-4fd5-9650-c6ee77acfc30'; // Electrical panel identification
    const PROBE_NAME = 'CCR-PROBE-TEST';
    let probeProjectUuid: string | null = null;
    let originalProjectUuid: string | null = null;

    console.log(chalk.cyan('\n── Probe: Claude.ai Project API ──────────────────────\n'));

    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found — run login first.');
      const orgId = orgs[0].uuid;
      console.log(chalk.gray(`Org: ${orgs[0].name} (${orgId})\n`));

      // ── Step A: Create project ──────────────────────────────
      console.log(chalk.white('Step A: POST /projects'));
      try {
        const project = await client.createProject(orgId, PROBE_NAME, 'Temporary probe project — safe to delete');
        probeProjectUuid = project.uuid;
        console.log(chalk.green(`  ✓ Created: ${project.name} (${project.uuid})`));
        console.log(chalk.gray(`  Full response: ${JSON.stringify(project, null, 2)}`));
      } catch (err) {
        console.log(chalk.red(`  ✗ FAILED: ${(err as Error).message}`));
        console.log(chalk.yellow('  → create_project endpoint does not exist or returned unexpected shape.'));
        console.log(chalk.yellow('  → Cannot proceed to Step B without a project UUID.'));
        return;
      }

      // Build raw headers for alternative probes (PATCH didn't work)
      const rawHeaders = {
        Cookie: session.raw.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; '),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };
      const API = `https://claude.ai/api/organizations/${encodeURIComponent(orgId)}`;
      let moveWorked = false;

      // ── Step B: Try alternative move endpoints ──────────────
      const moveCandidates: Array<{ label: string; url: string; method: string; body: object }> = [
        {
          label: 'PATCH /chat_conversations/{id} {project_uuid}',
          url: `${API}/chat_conversations/${PROBE_CONV}`,
          method: 'PATCH',
          body: { project_uuid: probeProjectUuid },
        },
        {
          label: 'PUT /chat_conversations/{id} {project_uuid}',
          url: `${API}/chat_conversations/${PROBE_CONV}`,
          method: 'PUT',
          body: { project_uuid: probeProjectUuid },
        },
        {
          label: 'POST /projects/{id}/chat_conversations {uuid}',
          url: `${API}/projects/${probeProjectUuid}/chat_conversations`,
          method: 'POST',
          body: { uuid: PROBE_CONV },
        },
        {
          label: 'POST /projects/{id}/chat_conversations {conversation_uuid}',
          url: `${API}/projects/${probeProjectUuid}/chat_conversations`,
          method: 'POST',
          body: { conversation_uuid: PROBE_CONV },
        },
      ];

      console.log(chalk.white('\nStep B: Probing move-conversation endpoint candidates'));
      for (const c of moveCandidates) {
        process.stdout.write(`  ${c.label} ... `);
        const r = await fetch(c.url, { method: c.method, headers: rawHeaders, body: JSON.stringify(c.body) });
        if (r.ok) {
          const body = await r.text();
          console.log(chalk.green(`✓ ${r.status}`));
          console.log(chalk.gray(`    Body: ${body.slice(0, 400)}`));
          moveWorked = true;
          originalProjectUuid = null;
          // Reverse: try to move back to null
          await fetch(c.url, { method: c.method, headers: rawHeaders, body: JSON.stringify({ project_uuid: null, uuid: null, conversation_uuid: null }) }).catch(() => {});
          break;
        } else {
          const errText = await r.text();
          console.log(chalk.red(`✗ ${r.status} ${r.statusText}`));
          console.log(chalk.gray(`    ${errText.slice(0, 120)}`));
        }
      }
      if (!moveWorked) {
        console.log(chalk.yellow('\n  No move endpoint found with any candidate shape.'));
        console.log(chalk.yellow('  → Inspect Claude.ai network requests in browser DevTools to find the real endpoint.'));
      }

      // ── Step D: Delete probe project ────────────────────────
      console.log(chalk.white('\nStep D: DELETE /projects (cleanup)'));
      try {
        const session2 = await loadSession();
        const delHeaders = {
          Cookie: session2.raw.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; '),
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        };
        const delRes = await fetch(
          `https://claude.ai/api/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(probeProjectUuid!)}`,
          { method: 'DELETE', headers: delHeaders },
        );
        if (delRes.ok || delRes.status === 204) {
          console.log(chalk.green('  ✓ Probe project deleted'));
        } else {
          console.log(chalk.yellow(`  ⚠ DELETE returned ${delRes.status} — project may persist`));
          console.log(chalk.yellow(`  → Manual cleanup: https://claude.ai/project/${probeProjectUuid}`));
        }
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ Delete probe failed: ${(err as Error).message}`));
        console.log(chalk.yellow(`  → Manual cleanup: https://claude.ai/project/${probeProjectUuid}`));
      }

    } catch (err) {
      console.log(chalk.red(`\nFatal: ${(err as Error).message}`));
    }

    console.log(chalk.cyan('\n── Probe complete ────────────────────────────────────\n'));
  });

// ── delete ──────────────────────────────────────────────────
program
  .command('delete <conversation-id>')
  .option('--yes', 'Skip confirmation')
  .description('Delete a conversation from Claude.ai and local SQLite')
  .action(async (conversationId: string, opts) => {
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');

      if (!opts.yes) {
        console.log(chalk.yellow(`About to delete conversation ${conversationId} from Claude.ai.`));
        console.log(chalk.yellow('This action is irreversible. Use --yes to confirm.'));
        return;
      }

      const spinner = ora('Deleting from Claude.ai...').start();
      await client.deleteConversation(orgs[0].uuid, conversationId);
      spinner.succeed(chalk.green('Deleted from Claude.ai.'));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── delete-empty ────────────────────────────────────────────
program
  .command('delete-empty <dbPath>')
  .option('--dry-run', 'List empty conversations without deleting')
  .option('--yes', 'Skip confirmation and delete immediately')
  .option('--local-only', 'Only remove from local SQLite, do not call Claude.ai API')
  .description('Delete all empty conversations (no messages) from Claude.ai and local SQLite')
  .action(async (dbPath, opts) => {
    try {
      const resolved = path.resolve(dbPath);
      const rows = getEmptyConversations(resolved, 10000);
      if (rows.length === 0) {
        console.log(chalk.green('No empty conversations found.'));
        return;
      }

      // Always show the list first
      console.log(chalk.cyan(`${rows.length} empty conversations:\n`));
      for (const r of rows) {
        const name = r.name || '(no title)';
        console.log(`  ${conversationUrl(r.uuid)}  ${chalk.gray(name)}  ${new Date(r.updated_at).toLocaleDateString()}`);
      }

      if (opts.dryRun) {
        console.log(chalk.gray(`\n${rows.length} conversations would be deleted. Use --yes to proceed.`));
        return;
      }

      if (!opts.yes) {
        console.log(chalk.yellow(`\nThis will permanently delete ${rows.length} conversations. Use --yes to confirm.`));
        return;
      }

      if (opts.localOnly) {
        const spinner = ora(`Removing ${rows.length} conversations from local SQLite...`).start();
        for (const r of rows) {
          deleteConversationLocal(resolved, r.uuid);
        }
        spinner.succeed(chalk.green(`Removed ${rows.length} conversations from local database.`));
        return;
      }

      // Live API deletion
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');

      let deleted = 0;
      let failed = 0;
      const spinner = ora(`Deleting 0/${rows.length}...`).start();

      for (const r of rows) {
        try {
          await client.deleteConversation(orgs[0].uuid, r.uuid);
          deleteConversationLocal(resolved, r.uuid);
          deleted++;
          spinner.text = `Deleting ${deleted}/${rows.length}...`;
        } catch (err) {
          failed++;
          const status = (err as { status?: number }).status ?? 'ERR';
          console.error(chalk.gray(`\n  ✗ ${r.uuid} [${status}] ${(err as Error).message}`));
          spinner.text = `Deleting ${deleted}/${rows.length} (${failed} failed)...`;
        }
      }

      spinner.succeed(chalk.green(`Deleted ${deleted}/${rows.length} conversations.`) +
        (failed > 0 ? chalk.yellow(` ${failed} failed.`) : ''));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── audit ───────────────────────────────────────────────────
program
  .command('audit <dbPath>')
  .option('--untitled', 'List conversations with no title')
  .option('--empty', 'List conversations with no messages')
  .option('-l, --limit <n>', 'Limit results', parsePositiveInt)
  .description('Audit conversations: find untitled, empty, or show stats')
  .action((dbPath, options) => {
    try {
      const resolved = path.resolve(dbPath);
      const limit = options.limit || 50;

      if (options.untitled) {
        const rows = getUntitledConversations(resolved, limit);
        if (rows.length === 0) { console.log(chalk.green('No untitled conversations.')); return; }
        console.log(chalk.cyan(`Untitled conversations (${rows.length}):\n`));
        for (const r of rows) {
          console.log(`  ${chalk.gray(r.uuid)}  ${r.message_count} msgs  ${new Date(r.updated_at).toLocaleDateString()}`);
        }
      } else if (options.empty) {
        const rows = getEmptyConversations(resolved, limit);
        if (rows.length === 0) { console.log(chalk.green('No empty conversations.')); return; }
        console.log(chalk.cyan(`Empty conversations (${rows.length}):\n`));
        for (const r of rows) {
          const name = r.name || chalk.gray('(no title)');
          console.log(`  ${chalk.gray(r.uuid)}  ${name}  ${new Date(r.updated_at).toLocaleDateString()}`);
        }
      } else {
        // Default: show stats summary
        const stats = getConversationStats(resolved);
        console.log(chalk.cyan('Conversation audit:\n'));
        console.log(`  Total:    ${stats.total}`);
        console.log(`  Untitled: ${stats.untitled} ${stats.untitled > 0 ? chalk.yellow(`(${((stats.untitled / stats.total) * 100).toFixed(1)}%)`) : chalk.green('(0%)')}`);
        console.log(`  Empty:    ${stats.empty} ${stats.empty > 0 ? chalk.yellow(`(${((stats.empty / stats.total) * 100).toFixed(1)}%)`) : chalk.green('(0%)')}`);
        if (stats.untitled > 0 || stats.empty > 0) {
          console.log(chalk.gray('\n  Use --untitled or --empty to list them'));
        }
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── rename-local-untitled ─────────────────────────────────────
program
  .command('rename-local-untitled <dbPath>')
  .option('--dry-run', 'Preview generated titles without updating')
  .option('-l, --limit <n>', 'Max conversations to rename', parsePositiveInt)
  .description('Auto-generate titles for untitled conversations (local SQLite only — not synced to claude.ai)')
  .action((dbPath, options) => {
    try {
      const resolved = path.resolve(dbPath);
      const result = renameUntitled(resolved, {
        dryRun: options.dryRun ?? false,
        limit: options.limit ?? 0,
      });

      if (result.total === 0) {
        console.log(chalk.green('No untitled conversations found.'));
        return;
      }

      console.log(chalk.cyan(`Found ${result.total} untitled conversation${result.total === 1 ? '' : 's'}${options.dryRun ? ' (dry run)' : ''}\n`));

      for (const t of result.titles) {
        const icon = options.dryRun ? chalk.blue('~') : chalk.green('\u2713');
        const src = chalk.gray(`(${t.source})`);
        console.log(`  ${icon} ${chalk.gray(t.uuid.slice(0, 12) + '\u2026')} \u2192 ${chalk.white(`"${t.title}"`)} ${src}`);
      }

      if (result.skipped > 0) {
        console.log(chalk.gray(`\n  \u2717 ${result.skipped} skipped (no content to derive title)`));
      }

      console.log(`\n  ${options.dryRun ? 'Would rename' : 'Renamed locally'}: ${chalk.green(result.renamed)} | Skipped: ${chalk.gray(result.skipped)}` +
        (options.dryRun ? '' : chalk.gray('  (local SQLite only — not synced to claude.ai)')));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── branches ────────────────────────────────────────────────
program
  .command('branches <dbPath> <conversationUuid>')
  .description('List all threads/branches in a conversation')
  .action((dbPath, conversationUuid) => {
    try {
      const result = getConversationBranches(path.resolve(dbPath), conversationUuid);
      if (result.threads.length === 0) {
        console.log(chalk.yellow('No messages found for this conversation.'));
        return;
      }
      console.log(chalk.cyan(`${result.threads.length} thread(s), ${result.totalMessages} total messages, ${result.branchPoints} branch point(s)\n`));
      for (const t of result.threads) {
        const label = t.threadIndex === 0 ? chalk.green('(main)') : chalk.gray(`(forks at depth ${t.forkDepth})`);
        console.log(`  Thread ${t.threadIndex} ${label}: ${t.messageCount} messages, last: ${t.lastMessage}`);
      }
      if (result.threads.length > 1) {
        console.log(chalk.gray(`\nUse: ccr thread <db> <uuid> <threadIndex> to view a specific thread`));
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── thread ──────────────────────────────────────────────────
program
  .command('thread <dbPath> <conversationUuid> <threadIndex>')
  .description('Display messages from a specific thread/branch of a conversation')
  .action((dbPath, conversationUuid, threadIndex) => {
    try {
      const messages = getThread(path.resolve(dbPath), conversationUuid, parseInt(threadIndex, 10));
      if (messages.length === 0) {
        console.log(chalk.yellow('No messages found (thread index may be out of range).'));
        return;
      }
      for (const msg of messages) {
        const shared = msg.isShared ? chalk.gray(' [shared]') : '';
        console.log(`---\n[${msg.created_at}] ${msg.sender}${shared}: ${msg.text}`);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── graph-build ─────────────────────────────────────────────
program
  .command('graph-build <dbPath>')
  .description('Build knowledge graph from entities (extract → build → cluster)')
  .option('--method <type>', 'Clustering method: label-propagation or kmeans', 'label-propagation')
  .option('--k <n>', 'Number of clusters for kmeans (auto if omitted)')
  .option('--api-key <key>', 'Google API key for Gemini embeddings (or set GOOGLE_API_KEY env var)')
  .action(async (dbPath, options) => {
    try {
      const resolved = path.resolve(dbPath);
      if (options.apiKey) process.env.GOOGLE_API_KEY = options.apiKey;
      const method = options.method as 'label-propagation' | 'kmeans';
      const k = options.k ? parseInt(options.k, 10) : undefined;
      const spinner = ora('Extracting entities...').start();
      extractEntities(resolved);
      spinner.text = 'Building graph nodes and edges...';
      const buildResult = buildGraph(resolved);
      spinner.text = `Clustering communities (${method})...`;
      const clusterResult = clusterGraph(resolved, method, k);
      spinner.text = 'Categorizing conversations...';
      const catResult = await categorizeConversations(resolved);
      spinner.succeed(chalk.green('Knowledge graph built.'));
      console.log(`  Nodes: ${buildResult.nodeCount} (${buildResult.entityNodes} entities, ${buildResult.conversationNodes} conversations, ${buildResult.toolNodes} tools)`);
      console.log(`  Edges: ${buildResult.edgeCount} (${buildResult.coOccurrenceEdges} co-occurrence, ${buildResult.mentionedInEdges} mentioned-in, ${buildResult.usesToolEdges} uses-tool)`);
      const cohesionLabel = clusterResult.method === 'kmeans' ? `silhouette: ${clusterResult.avgCohesion.toFixed(3)}` : `avg cohesion: ${clusterResult.avgCohesion.toFixed(3)}`;
      console.log(`  Communities: ${clusterResult.communityCount} [${clusterResult.method}] (largest: ${clusterResult.largestCommunity}, ${cohesionLabel})`);
      console.log(`  Categories: ${catResult.k} (${catResult.totalCategorized} conversations categorized, method: ${catResult.method})`);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── categorize ──────────────────────────────────────────────
program
  .command('categorize <dbPath>')
  .description('Categorize conversations using LLM embeddings or TF-IDF fallback (run after graph-build)')
  .option('--k <n>', 'Number of categories (auto if omitted)')
  .option('--api-key <key>', 'Google API key for Gemini embeddings (or set GOOGLE_API_KEY env var)')
  .action(async (dbPath, options) => {
    try {
      const resolved = path.resolve(dbPath);
      const k = options.k ? parseInt(options.k, 10) : undefined;
      if (options.apiKey) process.env.GOOGLE_API_KEY = options.apiKey;
      const result = await categorizeConversations(resolved, k);
      console.log(chalk.green(`Categorized ${result.totalCategorized} conversations into ${result.k} categories (${result.method}).`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── graph-query ─────────────────────────────────────────────
program
  .command('graph-query <dbPath> <keyword>')
  .option('-d, --depth <n>', 'BFS traversal depth', '2')
  .description('Query the knowledge graph by keyword (BFS subgraph)')
  .action((dbPath, keyword, options) => {
    try {
      const result = queryGraph(path.resolve(dbPath), keyword, parseInt(options.depth, 10));
      if (result.nodes.length === 0) {
        console.log(chalk.yellow(`No graph nodes matching "${keyword}".`));
        return;
      }
      console.log(chalk.cyan(`Found ${result.nodes.length} nodes, ${result.edges.length} edges (seeds: ${result.seedNodes.length})\n`));
      for (const n of result.nodes) {
        const marker = result.seedNodes.includes(n.id) ? chalk.green('*') : ' ';
        console.log(`${marker} ${chalk.white(n.label)} [${n.entity_type ?? n.node_type}] degree=${n.degree} community=${n.community_id ?? '-'}`);
      }
      if (result.edges.length > 0) {
        console.log(chalk.gray(`\nEdges:`));
        for (const e of result.edges.slice(0, 20)) {
          console.log(chalk.gray(`  ${e.source_label} -[${e.relation} w=${e.weight.toFixed(1)}]-> ${e.target_label}`));
        }
        if (result.edges.length > 20) console.log(chalk.gray(`  ... and ${result.edges.length - 20} more`));
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── graph-god-nodes ─────────────────────────────────────────
program
  .command('graph-god-nodes <dbPath>')
  .option('-n, --limit <n>', 'Number of results', '10')
  .option('--bridges', 'Show bridge entities instead')
  .option('--bursts', 'Show temporal bursts instead')
  .option('--tools', 'Show tool usage stats instead')
  .description('Show the most connected entities in the knowledge graph')
  .action((dbPath, options) => {
    try {
      const resolved = path.resolve(dbPath);
      const limit = parseInt(options.limit, 10);

      if (options.tools) {
        const stats = toolUsageStats(resolved, limit);
        if (stats.topTools.length === 0) { console.log(chalk.yellow('No tool usage found.')); return; }
        console.log(chalk.cyan('Most used tools:\n'));
        for (const t of stats.topTools) {
          console.log(`  ${chalk.white(t.tool_name)} — ${t.total_calls} calls across ${t.conversation_count} conversations (degree=${t.degree})`);
        }
        if (stats.mostDiverse.length > 0) {
          console.log(chalk.cyan('\nConversations with most tool variety:\n'));
          for (const c of stats.mostDiverse) {
            const tools = JSON.parse(c.tool_names || '[]') as string[];
            console.log(`  ${chalk.white(c.conversation_name || c.conversation_uuid.slice(0, 12))} — ${c.tool_count} tools (${tools.slice(0, 5).join(', ')}${tools.length > 5 ? '...' : ''})`);
          }
        }
      } else if (options.bridges) {
        const results = bridgeEntities(resolved, limit);
        if (results.length === 0) { console.log(chalk.yellow('No bridge entities found.')); return; }
        console.log(chalk.cyan('Bridge entities (connect multiple communities):\n'));
        for (const b of results) {
          console.log(`  ${chalk.white(b.entity)} [${b.entity_type}] degree=${b.degree} bridges ${b.communities_connected} communities (${b.community_ids})`);
        }
      } else if (options.bursts) {
        const results = temporalBursts(resolved, limit);
        if (results.length === 0) { console.log(chalk.yellow('No temporal bursts found.')); return; }
        console.log(chalk.cyan('Temporal bursts (high-frequency weeks):\n'));
        for (const b of results) {
          console.log(`  ${chalk.white(b.entity)} [${b.entity_type}] ${b.week}: ${b.mentions} mentions`);
        }
      } else {
        const results = godNodes(resolved, limit);
        if (results.length === 0) { console.log(chalk.yellow('No graph nodes found. Run graph-build first.')); return; }
        console.log(chalk.cyan('Most connected entities:\n'));
        for (const n of results) {
          console.log(`  ${chalk.white(n.label)} [${n.entity_type}] degree=${n.degree} community=${n.community_id ?? '-'}`);
        }
      }

      const questions = suggestQuestions(resolved);
      if (questions.length > 0) {
        console.log(chalk.gray('\nSuggested queries:'));
        for (const q of questions) console.log(chalk.gray(`  → ${q}`));
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── graph-export ────────────────────────────────────────────
program
  .command('graph-export <dbPath> [outputPath]')
  .option('--max-nodes <n>', 'Maximum nodes to include', '50')
  .option('--seed <entity>', 'Seed entity for ego graph')
  .option('--seed-depth <n>', 'BFS depth from seed', '2')
  .option('--entity-types <types>', 'Comma-separated entity types (topic,url,uuid)')
  .option('--min-degree <n>', 'Minimum node degree')
  .option('--community <id>', 'Filter to a specific community')
  .option('--entity-only', 'Exclude conversation nodes')
  .description('Export knowledge graph as interactive HTML visualization')
  .action((dbPath, outputPath, options) => {
    try {
      const resolved = path.resolve(dbPath);
      const output = path.resolve(outputPath || 'graph.html');
      toHtml(resolved, output, {
        maxNodes: parseInt(options.maxNodes, 10),
        seedEntity: options.seed,
        seedDepth: options.seedDepth ? parseInt(options.seedDepth, 10) : undefined,
        entityTypes: options.entityTypes ? options.entityTypes.split(',') : undefined,
        minDegree: options.minDegree ? parseInt(options.minDegree, 10) : undefined,
        communityId: options.community ? parseInt(options.community, 10) : undefined,
        entityOnly: options.entityOnly,
      });
      console.log(chalk.green(`Graph exported to ${output}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── graph-path ──────────────────────────────────────────────
program
  .command('graph-path <dbPath> <from> <to>')
  .description('Find shortest path between two entities in the knowledge graph')
  .action((dbPath, from, to) => {
    try {
      const result = shortestPath(path.resolve(dbPath), from, to);
      if (!result.found) {
        console.log(chalk.yellow(`No path found between "${from}" and "${to}".`));
        return;
      }
      console.log(chalk.cyan(`Path (${result.length} hops):\n`));
      console.log(result.labels.join(chalk.gray(' → ')));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── create-project ──────────────────────────────────────────
program
  .command('create-project <name>')
  .description('Create a new Claude.ai project')
  .option('-d, --description <text>', 'Project description', '')
  .action(async (name: string, opts) => {
    const spinner = ora('Creating project...').start();
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');
      const project = await client.createProject(orgs[0].uuid, name, opts.description);
      spinner.stop();
      console.log(chalk.green(`Created project: ${chalk.white(project.name)}`));
      console.log(chalk.cyan(projectUrl(project.uuid)));
      console.log(chalk.gray(`UUID: ${project.uuid}`));
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── move-to-project ──────────────────────────────────────────
program
  .command('move-to-project <projectUuid> <conversationUuids...>')
  .description('Move one or more conversations into a Claude.ai project')
  .action(async (projectUuid: string, conversationUuids: string[]) => {
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found.');
      const orgId = orgs[0].uuid;

      let ok = 0; let fail = 0;
      for (const convId of conversationUuids) {
        const spinner = ora(`Moving ${convId.slice(0, 8)}...`).start();
        try {
          await client.moveConversationToProject(orgId, convId, projectUuid);
          spinner.succeed(`${chalk.gray(convId.slice(0, 8))} → ${chalk.cyan(projectUrl(projectUuid))}`);
          ok++;
        } catch (err) {
          spinner.fail(`${chalk.gray(convId.slice(0, 8))} ${chalk.red((err as Error).message)}`);
          fail++;
        }
      }
      console.log(`\n${chalk.green(`${ok} moved`)}${fail > 0 ? chalk.yellow(`, ${fail} failed`) : ''}`);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── probe-completion ─────────────────────────────────────────
// Discovers the Claude.ai internal API format for sending messages / getting completions.
program
  .command('probe-completion')
  .description('Probe the Claude.ai internal completion endpoint (uses existing session, no API key needed)')
  .action(async () => {
    const CONV = '61c49787-7fd9-4227-ae32-2f3c8301d7f6'; // Audio equipment manual (safe test)
    const PROBE_PROMPT = 'Reply with exactly 5 words that describe the main topic of this conversation.';

    try {
      const session = await loadSession();
      const orgs = await createClient(session).getOrganizations();
      if (!orgs.length) throw new Error('No org');
      const orgId = orgs[0].uuid;
      const base = 'https://claude.ai/api';
      const h: Record<string, string> = {
        Cookie: session.raw.map((c) => `${c.name}=${c.value}`).join('; '),
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };

      // Create a fresh empty conversation — we need a clean context for title generation
      console.log(chalk.white('\nStep 1: Create fresh conversation'));
      const newConvRes = await fetch(`${base}/organizations/${orgId}/chat_conversations`, {
        method: 'POST', headers: { ...h, Accept: 'application/json' },
        body: JSON.stringify({ name: 'CCR-PROBE-COMPLETION' }),
      });
      const newConv = await newConvRes.json() as any;
      console.log(`  Status: ${newConvRes.status} uuid: ${newConv.uuid}`);

      if (!newConv.uuid) { console.error('Could not create probe conversation'); return; }

      // Build a short self-contained title-generation prompt
      const sampleText = 'HUMAN: We need to document the VOID Acoustics rack at Nomad Toronto — V3 amps, Q2 subs, Drawmer SP2120.\nASSISTANT: Here is a full equipment list and wiring diagram for the Nomad Toronto VOID Acoustics rack.';
      const titlePrompt = `\n\nHuman: Here is a brief conversation excerpt:\n\n${sampleText}\n\nGenerate a 5-8 word title for this conversation. Reply with ONLY the title, no quotes.\n\nAssistant:`;

      // Try with claude-haiku-4-5-20251001
      console.log(chalk.white('\nStep 2: POST /completion on fresh conversation'));
      const compRes = await fetch(`${base}/organizations/${orgId}/chat_conversations/${newConv.uuid}/completion`, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          prompt: titlePrompt,
          model: 'claude-haiku-4-5-20251001',
          max_tokens_to_sample: 60,
          timezone: 'America/Toronto',
          attachments: [], files: [],
        }),
      });
      console.log(`  Status: ${compRes.status} ${compRes.statusText}`);
      const compText = await compRes.text();
      console.log(`  Body[:800]: ${compText.slice(0, 800)}`);
      if (compRes.ok) console.log(chalk.green('  ✓ Endpoint confirmed working!'));

      // Cleanup
      await fetch(`${base}/organizations/${orgId}/chat_conversations/${newConv.uuid}`, {
        method: 'DELETE', headers: h,
      });
      console.log(chalk.gray('\nProbe conversation deleted.'));

    } catch (err) {
      console.error(chalk.red((err as Error).message));
    }
  });

// ── rename-project-conversations ─────────────────────────────
program
  .command('rename-project-conversations <projectUuid>')
  .description('AI-analyse every conversation in a Claude.ai project and rename it with a descriptive title (uses your existing Claude.ai session — no API key needed)')
  .option('--dry-run', 'Print proposed titles without writing to Claude.ai')
  .option('-l, --limit <n>', 'Process at most N conversations', parsePositiveInt)
  .action(async (projectUuid: string, opts) => {
    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (orgs.length === 0) throw new Error('No organizations found — run login first.');
      const orgId = orgs[0].uuid;

      const fetchSpinner = ora('Listing project conversations...').start();
      let convs = await client.listProjectConversations(orgId, projectUuid);
      if (opts.limit) convs = convs.slice(0, opts.limit);
      fetchSpinner.succeed(`Found ${convs.length} conversation${convs.length !== 1 ? 's' : ''} in project`);

      if (convs.length === 0) {
        console.log(chalk.yellow('No conversations found in this project.'));
        return;
      }

      if (opts.dryRun) {
        console.log(chalk.gray('\n  Dry run — no changes will be made to Claude.ai\n'));
      }

      const results: Array<{ uuid: string; oldName: string; newName: string; status: 'ok' | 'failed'; error?: string }> = [];

      for (let i = 0; i < convs.length; i++) {
        const conv = convs[i];
        const prefix = chalk.gray(`[${i + 1}/${convs.length}]`);
        const spinner = ora(`${prefix} Analysing: ${chalk.white(conv.name || conv.uuid.slice(0, 8))}`).start();

        try {
          const tree = await client.getConversation(orgId, conv.uuid);
          const linear = flattenConversation(tree);

          if (linear.messages.length === 0) {
            spinner.warn(`${prefix} ${chalk.yellow('No messages — skipped')}`);
            continue;
          }

          const proposed = await generateTitle(session, orgId, linear.messages);

          if (opts.dryRun) {
            spinner.stop();
            console.log(`${prefix} ${chalk.gray(conv.name || '(untitled)')}`);
            console.log(`       ${chalk.cyan('→')} ${chalk.white(proposed)}\n`);
            results.push({ uuid: conv.uuid, oldName: conv.name || '', newName: proposed, status: 'ok' });
          } else {
            spinner.text = `${prefix} Renaming → ${chalk.cyan(proposed)}`;
            await client.renameConversation(orgId, conv.uuid, proposed);
            spinner.succeed(`${prefix} ${chalk.gray(conv.name || '(untitled)')} → ${chalk.white(proposed)}`);
            results.push({ uuid: conv.uuid, oldName: conv.name || '', newName: proposed, status: 'ok' });
          }
        } catch (err) {
          spinner.fail(`${prefix} ${chalk.red((err as Error).message)}`);
          results.push({ uuid: conv.uuid, oldName: conv.name || '', newName: '', status: 'failed', error: (err as Error).message });
        }
      }

      const ok = results.filter(r => r.status === 'ok').length;
      const failed = results.filter(r => r.status === 'failed').length;
      console.log(`\n${chalk.green(`${ok} ${opts.dryRun ? 'proposed' : 'renamed'}`)}${failed > 0 ? chalk.yellow(`, ${failed} failed`) : ''}`);
      if (!opts.dryRun && ok > 0) {
        console.log(chalk.cyan(`\nProject: ${projectUrl(projectUuid)}`));
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

// ── probe-file-download ──────────────────────────────────────
program
  .command('probe-file-download')
  .description('Probe Claude.ai file-download endpoints to find the correct URL shape')
  .action(async () => {
    // Known test file: IMG_7164.jpeg from Nomad Amp Rack Cable ID conversation
    const TEST_FILE_UUID = 'c5a2fe6a-6abf-457d-b519-321b37feb44f';
    const TEST_CONV_UUID = '81ef8190-238f-4f37-901d-ead397b7a6e1';

    try {
      const session = await loadSession();
      const orgs = await createClient(session).getOrganizations();
      if (!orgs.length) throw new Error('No org found — run login first.');
      const orgId = orgs[0].uuid;

      const rawHeaders: Record<string, string> = {
        Cookie: session.raw.map((c) => `${c.name}=${c.value}`).join('; '),
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };

      // Confirmed working patterns (probed 2026-04-26):
      // Images: /api/{orgId}/files/{uuid}/preview  → 200 image/webp
      // PDFs:   /api/{orgId}/files/{uuid}/document_pdf → 200 application/pdf
      // DOCX:   no accessible endpoint (blob kind)
      const imageVariants = ['preview', 'thumbnail'];
      const docVariants = ['document_pdf'];

      console.log(chalk.white('\nImage (IMG_7164.jpeg):'));
      for (const v of imageVariants) {
        const url = `https://claude.ai/api/${orgId}/files/${TEST_FILE_UUID}/${v}`;
        process.stdout.write(`  ${v} → `);
        const r = await fetch(url, { headers: rawHeaders });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          console.log(chalk.green(`✓ ${r.status} ${r.headers.get('content-type')} ${buf.length}b magic=${buf.slice(0, 4).toString('hex')}`));
        } else console.log(chalk.red(`✗ ${r.status}`));
      }

      // nomad system spec.pdf
      const PDF_UUID = '5ff003f6-9bcf-413b-b09a-561e60f8cf1d';
      console.log(chalk.white('\nPDF (nomad system spec.pdf):'));
      for (const v of docVariants) {
        const url = `https://claude.ai/api/${orgId}/files/${PDF_UUID}/${v}`;
        process.stdout.write(`  ${v} → `);
        const r = await fetch(url, { headers: rawHeaders });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          console.log(chalk.green(`✓ ${r.status} ${r.headers.get('content-type')} ${buf.length}b magic=${buf.slice(0, 4).toString('hex')}`));
        } else console.log(chalk.red(`✗ ${r.status}`));
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
    }
  });

// ── download-project-files ───────────────────────────────────
program
  .command('download-project-files <projectUuid> <outputDir>')
  .description('Download all files from a Claude.ai project, scaffold local folders by date/UUID, and git-init')
  .option('--dry-run', 'Print folder structure + manifest without downloading or writing')
  .option('--no-download', 'Scaffold structure and manifest only — skip file download')
  .option('--convert-images', 'Convert downloaded WebP images to JPEG (requires sharp)')
  .action(async (projectUuid: string, outputDir: string, opts) => {
    const resolved = path.resolve(outputDir);
    const doDownload = !opts.dryRun && opts.download !== false;

    try {
      const session = await loadSession();
      const client = createClient(session);
      const orgs = await client.getOrganizations();
      if (!orgs.length) throw new Error('No org found — run login first.');
      const orgId = orgs[0].uuid;

      // 1. List conversations in the project
      const fetchSpinner = ora('Listing project conversations...').start();
      const convMetas = await client.listProjectConversations(orgId, projectUuid);
      fetchSpinner.succeed(`Found ${convMetas.length} conversation${convMetas.length !== 1 ? 's' : ''}`);

      if (!convMetas.length) { console.log(chalk.yellow('No conversations found.')); return; }

      // 2. Fetch full trees (needed for file asset URLs)
      const trees: Array<{ tree: any; uuid: string; name: string }> = [];
      for (const meta of convMetas) {
        const spinner = ora(`Fetching: ${chalk.gray(meta.name || meta.uuid.slice(0, 8))}`).start();
        try {
          const tree = await client.getConversation(orgId, meta.uuid);
          trees.push({ tree, uuid: meta.uuid, name: meta.name || meta.uuid.slice(0, 8) });
          spinner.succeed(`${chalk.gray(meta.uuid.slice(0, 8))} ${chalk.white(meta.name || '(untitled)')}`);
        } catch (err) {
          spinner.fail(`${chalk.red(meta.uuid.slice(0, 8))}: ${(err as Error).message}`);
        }
      }

      // 3. Sort by conversation created_at ascending (oldest first)
      trees.sort((a, b) => {
        const da = (a.tree as any).created_at ?? '';
        const db = (b.tree as any).created_at ?? '';
        return da.localeCompare(db);
      });

      if (opts.dryRun) {
        console.log(chalk.cyan(`\nDry run — output dir: ${resolved}\n`));
        for (const { tree, uuid, name } of trees) {
          const date = ((tree as any).created_at ?? '').slice(0, 10);
          const folder = `${date}_${uuid.slice(0, 8)}_${slugify(name)}`;
          const files = (tree as any).chat_messages?.flatMap((m: any) => m.files ?? []) ?? [];
          const unique = [...new Map(files.map((f: any) => [f.file_uuid, f])).values()];
          console.log(`  ${chalk.white(folder)}/ (${unique.length} files)`);
        }
        return;
      }

      // 4. Scaffold + download
      console.log(chalk.cyan(`\nBuilding project at: ${resolved}\n`));
      const manifest = await scaffoldProject({
        outputDir: resolved,
        projectName: 'Nomad AV Rack',
        projectUuid,
        conversations: trees,
        client,
        download: doDownload,
        convertImages: !!opts.convertImages,
        onProgress: (msg) => process.stdout.write(chalk.gray(msg) + '\n'),
      });

      // 5. Git init
      const gitSpinner = ora('Initialising git repository...').start();
      const { execSync } = await import('child_process');
      execSync(`git init "${resolved}"`, { stdio: 'ignore' });
      execSync(`git -C "${resolved}" add .`, { stdio: 'ignore' });
      execSync(
        `git -C "${resolved}" commit -m "feat: Nomad Toronto AV project — ${manifest.downloaded} files from ${manifest.conversations.length} Claude.ai conversations"`,
        { stdio: 'ignore' },
      );
      gitSpinner.succeed('Git repository initialised with initial commit');

      // 6. Summary
      console.log(`\n${chalk.green('Done!')}`);
      console.log(`  Project: ${chalk.cyan(resolved)}`);
      console.log(`  Files downloaded: ${chalk.white(String(manifest.downloaded))}`);
      console.log(`  Not downloadable: ${chalk.yellow(String(manifest.not_downloadable))} (DOCX/blob)`);
      console.log(`  Manifest: ${chalk.gray(path.join(resolved, 'manifest.json'))}`);
      console.log(`  Claude.ai: ${chalk.cyan(manifest.claude_project_url)}`);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

program
  .command('extract-speaker-images <outputDir>')
  .description('Download VOID/Bias PDFs, extract cover photos and/or technical line drawings as transparent PNGs')
  .option('--save-pdfs <dir>', 'Save/cache PDF files to this directory (re-used on subsequent runs)')
  .option('--mode <mode>', 'What to extract: cover | dims | both (default: both)', 'both')
  .action(async (outputDir: string, opts: { savePdfs?: string; mode?: string }) => {
    try {
      const { mkdirSync } = await import('fs');
      const resolvedOut = path.resolve(outputDir);
      const resolvedPdf = opts.savePdfs ? path.resolve(opts.savePdfs) : null;
      const mode = (opts.mode ?? 'both') as ExtractionMode;
      if (!['cover', 'dims', 'both'].includes(mode)) {
        console.error(chalk.red(`Invalid --mode "${mode}". Use: cover | dims | both`));
        process.exitCode = 1;
        return;
      }
      mkdirSync(resolvedOut, { recursive: true });
      if (resolvedPdf) mkdirSync(resolvedPdf, { recursive: true });

      const modeLabel = mode === 'both' ? 'cover + dims' : mode;
      console.log(chalk.cyan(`\nExtracting speaker assets [${modeLabel}] → ${resolvedOut}\n`));

      for (const spec of SPEAKER_PDFS) {
        const spinner = ora(chalk.cyan(`↓ ${spec.label}`)).start();
        try {
          const result = await extractSpeakerImage(spec, resolvedOut, resolvedPdf, mode, (msg) => {
            spinner.text = chalk.cyan(`${spec.label}`) + chalk.gray(` — ${msg}`);
          });
          const outputs = [
            result.coverPath && path.basename(result.coverPath),
            result.dimsPath && path.basename(result.dimsPath),
            ...Object.values(result.viewPaths).map((p) => path.basename(p)),
          ].filter(Boolean).join(', ');
          spinner.succeed(chalk.green(`${spec.label}`) + chalk.gray(outputs ? ` → ${outputs}` : ' (skipped)'));
        } catch (err) {
          spinner.fail(chalk.red(`${spec.label}: ${(err as Error).message}`));
        }
      }

      console.log(chalk.green.bold(`\nDone — assets in ${resolvedOut}`));
      if (resolvedPdf) console.log(chalk.gray(`PDFs cached in ${resolvedPdf}`));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
  });

program.parse();
