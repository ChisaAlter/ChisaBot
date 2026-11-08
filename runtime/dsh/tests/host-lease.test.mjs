import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DshHostClient } from '../src/client.mjs';

test('Host home ownership ignores a copied live PID, excludes a real owner and recovers after SIGKILL', { timeout: 150000 }, async t => {
  const root = resolve('.runtime');
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, 'lease-'));
  await writeFile(join(home, 'chisabot.json'), JSON.stringify({ ownerUserId: 'lease-owner', port: 0, providers: {} }));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const children = [unrelated];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; }
    }));
  });
  await writeFile(join(home, 'host.pid'), String(unrelated.pid));
  const launch = () => {
    const child = spawn(process.execPath, ['src/start.mjs'], { cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, CHISABOT_DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    return { child, output: () => output };
  };
  const ready = async host => {
    for (let n = 0; n < 600; n++) {
      if (host.output().includes('chisabot-runtime-ready')) break;
      if (host.child.exitCode !== null) throw new Error(host.output());
      await delay(100);
    }
    assert.match(host.output(), /chisabot-runtime-ready/);
    const client = await DshHostClient.connect(JSON.parse(await readFile(join(home, 'connection.json'), 'utf8')).endpoint);
    try { return await client.health(); } finally { await client.close(); }
  };
  const first = launch();
  const initial = await ready(first);
  assert.equal(initial.ownerUserId, 'lease-owner');
  assert.equal(unrelated.exitCode, null, 'unrelated process referenced by stale PID stays alive');
  assert.equal(await readFile(join(home, 'host.pid'), 'utf8'), String(first.child.pid));
  const conflict = launch();
  const [code] = await once(conflict.child, 'exit');
  assert.notEqual(code, 0);
  assert.match(conflict.output(), /Another Host still owns/);
  assert.equal(first.child.exitCode, null);
  const killed = once(first.child, 'exit'); first.child.kill('SIGKILL'); await killed;
  // The durable PID file intentionally survives an ungraceful exit. Neither it nor a copied
  // unrelated live PID may obstruct the next kernel lease.
  await writeFile(join(home, 'host.pid'), String(unrelated.pid));
  const resumed = launch();
  const next = await ready(resumed);
  assert.notEqual(next.generation, initial.generation);
  assert.equal(next.ownerUserId, initial.ownerUserId);
  assert.equal(unrelated.exitCode, null);
});
