import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DshHostClient } from '../src/client.mjs';

test('real Host: invalid auth, stale catalog, missing model, bounded exhaustion and first-output timeout', { timeout: 180_000 }, async t => {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body.model);
    if (body.model === 'slow') return; // No first byte; the owned client aborts the connection.
    const status = { invalid: 401, missing: 404, retired: 410, limited: 429, backup_limited: 429 }[body.model];
    if (status) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `${body.model} HTTP ${status}`, type: status === 401 ? 'authentication_error' : 'api_error' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'verified answer' }, null], [{}, 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  await mkdir(resolve('.runtime'), { recursive: true });
  const home = await mkdtemp(join(resolve('.runtime'), 'model-failures-'));
  const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
  const models = ['available', 'invalid', 'missing', 'retired', 'limited', 'backup_limited', 'slow'].map(id => ({ id, contextWindow: 32000, maxTokens: 1024, input: ['text'] }));
  await writeFile(join(home, 'chisabot.json'), JSON.stringify({ ownerUserId: 'model-test-owner', port: 0,
    providers: { fixture: { api: 'openai-completions', baseURL, apiKeyEnv: 'CHISABOT_FAILURE_FIXTURE_KEY', models } } }));
  const host = spawn(process.execPath, ['src/start.mjs'], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, CHISABOT_DSH_HOME: home, CHISABOT_FAILURE_FIXTURE_KEY: 'isolated-fixture' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', client;
  host.stdout.on('data', chunk => { logs += chunk; }); host.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    await client?.close();
    if (host.exitCode === null && host.signalCode === null) { const exit = once(host, 'exit'); host.kill(); await exit; }
  });
  for (let n = 0; n < 1200 && !logs.includes('chisabot-runtime-ready'); n++) {
    if (host.exitCode !== null) throw Error(logs);
    await delay(50);
  }
  assert.match(logs, /chisabot-runtime-ready/);
  const { endpoint } = JSON.parse(await readFile(join(home, 'connection.json'), 'utf8'));
  client = await DshHostClient.connect(endpoint);
  async function run(id, primary, fallback, firstOutputMs = 0) {
    const start = requests.length;
    await client.bind({ sessionId: id, threadId: id, runId: id, actorId: 'model-test-owner', botId: 'bot', revision: 1, prompt: 'Answer briefly.', tools: [],
      model: { primary: { provider: 'fixture', model: primary }, ...(fallback ? { fallbacks: [{ provider: 'fixture', model: fallback }] } : {}), firstOutputMs } });
    await client.prompt({ sessionId: id, requestId: id, mode: 'queue', content: [{ type: 'text', text: 'Answer now.' }] });
    assert.equal((await client.wait(id, { timeoutMs: 20_000 })).reason, 'idle');
    const events = (await client.events(id)).records.map(row => row.event);
    return { events, calls: requests.slice(start), text: JSON.stringify(events) };
  }
  await t.test('invalid shared credential stops without trying another model', async () => {
    const result = await run('auth', 'invalid', 'available');
    assert.deepEqual(result.calls, ['invalid']);
    assert.match(result.text, /主模型「invalid」请求失败/);
    assert.doesNotMatch(result.text, /verified answer/);
  });
  for (const primary of ['missing', 'retired']) await t.test(`HTTP ${primary} advances to a configured backup`, async () => {
    const result = await run(primary, primary, 'available');
    assert.deepEqual(result.calls, [primary, 'available']);
    assert.match(result.text, /UNKNOWN_MODEL/);
    assert.match(result.text, /verified answer/);
  });
  await t.test('stale catalog entry is skipped before transport', async () => {
    const result = await run('stale', 'not_in_catalog', 'available');
    assert.deepEqual(result.calls, ['available']);
    assert.match(result.text, /not_in_catalog/);
    assert.match(result.text, /verified answer/);
  });
  await t.test('429 exhaustion is bounded and identifies the failing backup', async () => {
    const result = await run('exhausted', 'limited', 'backup_limited');
    assert.deepEqual(result.calls, ['limited', 'backup_limited']);
    assert.match(result.text, /备用模型「backup_limited」请求失败/);
    assert.doesNotMatch(result.text, /verified answer/);
  });
  await t.test('fully stale catalog identifies the last candidate without transport', async () => {
    const result = await run('stale-exhausted', 'not_in_catalog', 'also_not_in_catalog');
    assert.deepEqual(result.calls, []);
    assert.match(result.text, /备用模型「also_not_in_catalog」请求失败/);
    assert.doesNotMatch(result.text, /verified answer/);
  });
  await t.test('first-output timeout retries once, then completes through backup', async () => {
    const result = await run('timeout', 'slow', 'available', 200);
    assert.deepEqual(result.calls, ['slow', 'slow', 'available']);
    assert.match(result.text, /TIMEOUT/);
    assert.match(result.text, /verified answer/);
  });
  await t.test('Stop remains cancellation, not timeout or fallback', async () => {
    await client.bind({ sessionId: 'stop', threadId: 'stop', runId: 'stop', actorId: 'model-test-owner', botId: 'bot', revision: 1, prompt: 'Answer.', tools: [],
      model: { primary: { provider: 'fixture', model: 'slow' }, fallbacks: [{ provider: 'fixture', model: 'available' }], firstOutputMs: 10000 } });
    const start = requests.length;
    await client.prompt({ sessionId: 'stop', requestId: 'stop', mode: 'queue', content: [{ type: 'text', text: 'Stop this.' }] });
    for (let n = 0; n < 100 && requests.length === start; n++) await delay(20);
    await client.stop('stop', 'stop');
    await client.wait('stop', { timeoutMs: 10000 });
    assert.deepEqual(requests.slice(start), ['slow']);
    assert.doesNotMatch(JSON.stringify((await client.events('stop')).records), /MODEL_FIRST_OUTPUT_TIMEOUT|TIMEOUT/);
  });
});
