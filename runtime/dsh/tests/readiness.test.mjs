import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DshHostClient } from '../src/client.mjs';
import { inspectDshRuntime } from '../src/readiness.mjs';

test('shared readiness reads a persisted Session and rejects wrong identity, version and stopped Host', { timeout: 90000 }, async t => {
  const root = resolve('.runtime'); await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, 'readiness-'));
  await writeFile(join(home, 'chisabot.json'), JSON.stringify({ ownerUserId: 'readiness-owner', port: 0, providers: {} }));
  const child = spawn(process.execPath, ['src/start.mjs'], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, CHISABOT_DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; } });
  let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  for (let n = 0; n < 600 && !output.includes('chisabot-runtime-ready'); n++) {
    if (child.exitCode !== null) throw Error(output);
    await delay(100);
  }
  assert.match(output, /chisabot-runtime-ready/);
  const connectionFile = join(home, 'connection.json');
  const target = { ownerUserId: 'readiness-owner', connectionFile };
  const client = await DshHostClient.connect(JSON.parse(await readFile(connectionFile, 'utf8')).endpoint);
  try {
    await client.bind({ sessionId: 'health-session', runId: 'health-run', threadId: 'health-thread', botId: 'health-bot', actorId: target.ownerUserId,
      revision: 1, prompt: 'Readiness check only.', model: { primary: { provider: 'fixture', model: 'readiness' } }, tools: [] });
    await client.checkpoint('health-session');
  } finally { await client.close(); }
  const health = await inspectDshRuntime({ target, ownerUserId: target.ownerUserId, sessionIds: ['health-session'], signal: AbortSignal.timeout(8000) });
  assert.equal(health.ok, true); assert.equal(health.watermarks.length, 1); assert.equal(health.running, 0);
  await assert.rejects(inspectDshRuntime({ target, ownerUserId: 'other-owner', signal: AbortSignal.timeout(5000) }), /owner mismatch/);
  await assert.rejects(inspectDshRuntime({ target, ownerUserId: target.ownerUserId, expected: { protocol: 1, runtimeVersion: 'invalid' }, signal: AbortSignal.timeout(5000) }), /version mismatch/);
  const stopped = once(child, 'exit'); child.kill(); await stopped;
  await assert.rejects(inspectDshRuntime({ target, ownerUserId: target.ownerUserId, signal: AbortSignal.timeout(3000) }));
});
