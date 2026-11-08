import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { DshHostClient } from '../../runtime/dsh/src/client.mjs';
import { createManagedDshRuntimes } from '../../server/src/conversations/managed-runtime';
import { loadDshTargets } from '../../server/src/conversations/runtime-targets';

// Run with the API's environment and uid. Never print endpoints, owner IDs or connection tokens.
const command = process.argv[2] ?? 'health';
const kernel = process.env.CHISABOT_AGENT_KERNEL?.trim().toLowerCase();
const db = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 10 });
try {
  const [table] = await db`select to_regclass('public.chisabot_runtime_bindings') as name`;
  const bindings = table?.name ? await db`select owner_user_id, session_id from chisabot_runtime_bindings where kernel='dsh'` : [];
  if (command === 'bindings') {
    console.log(bindings.length);
  } else if (command === 'enabled') {
    console.log(kernel === 'dsh' || bindings.length > 0 ? '1' : '0');
  } else if (kernel !== 'dsh' && bindings.length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'No DSH bindings or selected DSH kernel' }));
  } else if (command === 'compatibility') {
    console.log(await readFile(new URL('./runtime-compat.json', import.meta.url), 'utf8'));
  } else if (command === 'busy') {
    const [row] = await db`select
      (select count(*) from chisabot_dsh_runs where status in ('admitting','observing','projecting')) +
      (select count(*) from openbot_local_threads where lock_expires_at > now()) as count`;
    console.log(row.count);
  } else if (command === 'health' || command === 'snapshot') {
    const root = resolve(process.env.CHISABOT_DSH_ROOT ?? '.data/dsh');
    const external = process.env.CHISABOT_DSH_TARGETS_FILE;
    if (command === 'snapshot' && external) throw new Error('External DSH targets require a coordinated snapshot of their own Session storage.');
    if (!external) await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
    const targetFor = external ? await loadDshTargets(external) : createManagedDshRuntimes({ root,
      gatewayUrl: `http://127.0.0.1:${process.env.SERVER_PORT ?? process.env.PORT ?? '3001'}/api/internal/dsh-tools`,
    }).targetFor;
    const owners = [...new Set(bindings.map(row => row.owner_user_id as string))];
    // A new install has no conversation yet. Its private probe opens a Host without running a model.
    if (!owners.length && !external) owners.push('__deployment_readiness__');
    if (!owners.length && external) {
      const targets = JSON.parse(await readFile(external, 'utf8'));
      for (const target of targets) owners.push(target.ownerUserId);
      if (!owners.length) throw new Error('The DSH targets list is empty.');
    }
    const expected = JSON.parse(await readFile(new URL('./runtime-compat.json', import.meta.url), 'utf8'));
    const watermarks: { sessionId: string; cursor: number }[] = [];
    let running = 0;
    for (const owner of owners) {
      const target = await targetFor(owner);
      const address = JSON.parse(await readFile(target.connectionFile, 'utf8'));
      const client = await DshHostClient.connect(address.endpoint, { signal: AbortSignal.timeout(5000) });
      try {
        const health = await client.health(AbortSignal.timeout(5000));
        if (!health.ok || health.ownerUserId !== owner || health.protocol !== expected.protocol || health.version !== expected.runtimeVersion) {
          throw new Error('DSH readiness identity, protocol or runtime version mismatch.');
        }
        running += health.sessions.filter(session => session.state !== 'idle').length;
        for (const binding of bindings.filter(row => row.owner_user_id === owner)) {
          const history = await client.events(binding.session_id, { maxMessages: 1 }, AbortSignal.timeout(10000));
          watermarks.push({ sessionId: binding.session_id, cursor: history.cursor });
        }
      } finally { await client.close(); }
    }
    if (command === 'snapshot' && running) throw new Error('A DSH Session is still running; snapshot not ready.');
    const [projection] = await db`select coalesce(max(sequence),0)::text as cursor from openbot_local_events`;
    console.log(JSON.stringify({ status: 'ok', ...expected, runtimes: owners.length, sessions: watermarks.length, running,
      ...(command === 'snapshot' ? { capturedAt: new Date().toISOString(), projectionCursor: projection.cursor, watermarks } : {}),
    }));
  } else throw new Error('Unknown DSH maintenance command.');
} catch {
  // Exceptions may include private endpoints. The caller gets a failure without exporting them.
  console.error(`DSH ${command} failed; inspect the private runtime and database diagnostics.`);
  process.exitCode = 1;
} finally { await db.end({ timeout: 5 }); }
