/**
 * @file profile-one.mjs
 * @description Time-bounded profile of a single conversation. Bypasses the
 *   `DELETE FROM conversation_profiles` wipe in profileConversations() so it
 *   doesn't touch the other 600 profile rows. Used to isolate whether the
 *   profile-hang issue is the wipe-all behavior or a per-conversation regex
 *   catastrophe.
 *   Usage: node scripts/profile-one.mjs <conversation_uuid> [dbPath]
 * @version 1.0.0
 * @created 2026-05-28T22:30:00Z
 * @lastUpdated 2026-05-28T22:30:00Z
 */
const { profileConversations } = await import('../dist/importers/conversation-profiler.js')
  .catch(async () => {
    // Fallback to tsx if dist isn't built
    const { register } = await import('tsx/esm/api');
    register();
    return await import('../src/importers/conversation-profiler.ts');
  });

const uuid = process.argv[2];
const dbPath = process.argv[3] || '.ccr-import.sqlite';

if (!uuid) {
  console.error('Usage: node scripts/profile-one.mjs <uuid> [dbPath]');
  process.exit(1);
}

console.log(`Profiling single conversation: ${uuid}`);
console.log(`DB: ${dbPath}`);
const t0 = Date.now();

// Force-exit timer — if anything hangs for more than 60s, abort with details
const watchdog = setTimeout(() => {
  console.error(`\n⏱  Watchdog tripped after 60s — profile is hung. Aborting.`);
  console.error(`Most likely cause: regex backtracking on a very long text blob.`);
  process.exit(2);
}, 60_000);

try {
  const result = profileConversations(dbPath, { conversationUuids: [uuid], verbose: true });
  clearTimeout(watchdog);
  const ms = Date.now() - t0;
  console.log(`\nDone in ${ms}ms`);
  console.log(`totalProfiled: ${result.totalProfiled}`);
  console.log(`avgDensity:    ${result.avgDensity.toFixed(4)}`);
  console.log(`typeDist:      ${JSON.stringify(result.typeDistribution)}`);
} catch (err) {
  clearTimeout(watchdog);
  console.error('Failed:', err.message);
  process.exit(1);
}
