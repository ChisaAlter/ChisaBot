import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DshHostClient } from '../src/client.mjs';
import { DshEventProjection } from '../../../server/src/conversations/dsh-events';

test.each(['unflushed', 'flushed'])('source %s tool-result tail survives or is refused at the committed cut after actual Host crash', async mode => {
  let effects = 0, modelCalls = 0;
  const receipts = new Map<string, string>();
  const bridge = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json();
    if (new URL(request.url).pathname === '/execute') {
      effects++;
      const content = 'receipt-effect-once';
      receipts.set(`${body.binding.sessionId}:${body.turn}:${body.step}:${body.callId}`, content);
      return Response.json({ content });
    }
    modelCalls++;
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'effect-call', type: 'function', function: { name: 'write_effect', arguments: '{}' } }] };
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: 'fixture', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const cwd = resolve(import.meta.dir, '..');
  await mkdir(join(cwd, '.runtime'), { recursive: true });
  const home = await mkdtemp(join(cwd, '.runtime', 'source-cut-'));
  const evidence = join(home, 'crash-evidence.json');
  const patch = join(home, 'fault.json');
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'durability-fault', name: resolve(import.meta.dir, 'support/durability-fault.mjs').replaceAll('\\', '/'), config: { mode, evidence } }] }]));
  await writeFile(join(home, 'chisabot.json'), JSON.stringify({ ownerUserId: 'cut-owner', port: 0, providers: {}, gatewayUrl: bridge.url.origin }));
  let host: ChildProcess | undefined, client: DshHostClient | undefined, logs = '';
  const boot = async (fault = false) => {
    logs = '';
    host = spawn('node', ['src/start.mjs', ...(fault ? ['--patch', patch] : [])], { cwd, windowsHide: true, env: { ...process.env, CHISABOT_DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout!.on('data', value => { logs += value; }); host.stderr!.on('data', value => { logs += value; });
    for (let at = 0; at < 600 && !logs.includes('chisabot-runtime-ready'); at++) {
      if (host.exitCode !== null) throw new Error(logs);
      await delay(100);
    }
    expect(logs).toContain('chisabot-runtime-ready');
    client = await DshHostClient.connect(JSON.parse(await readFile(join(home, 'connection.json'), 'utf8')).endpoint);
  };
  const binding = (runId: string) => ({ sessionId: 'cut-session', threadId: 'cut-thread', botId: 'bot', actorId: 'cut-owner', revision: 1, runId,
    prompt: 'Use the provided tool.', toolCapability: 'isolated-tool-capability',
    model: { primary: { provider: 'configured', model: 'fixture' } },
    connection: { api: 'openai-completions', baseURL: `${bridge.url.origin}/v1`, apiKey: 'fixture-key', models: [{ id: 'fixture', contextWindow: 32000, maxTokens: 1024, input: ['text'] }] },
    tools: [{ name: 'write_effect', description: 'Commit one effect.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
  });
  try {
    await boot(true);
    const generation = (await client!.health()).generation;
    await client!.bind(binding('cut-run'));
    const baseline = await client!.eventsAfter('cut-session');
    const observed: typeof baseline.records = [...baseline.records];
    const watchAbort = new AbortController();
    let watchingReady!: () => void;
    const watching = new Promise<void>(resolve => { watchingReady = resolve; });
    const watchingClient = client!;
    const observer = (async () => {
      try {
        for await (const frame of watchingClient.follow('cut-session', watchAbort.signal)) {
          if (frame.type === 'snapshot') { watchingReady(); continue; }
          if (frame.type !== 'event' || frame.event.seq <= (observed.at(-1)?.event.seq ?? -1)) continue;
          const prefix = await watchingClient.eventsAfter('cut-session', observed.at(-1)?.event.seq ?? -1, frame.event.seq, AbortSignal.timeout(5000));
          observed.push(...prefix.records);
        }
      } catch { /* The injected crash deliberately tears down the observer. */ }
    })();
    await watching;
    const killed = once(host!, 'exit');
    await client!.prompt({ sessionId: 'cut-session', requestId: 'cut-command', mode: 'queue', content: [{ type: 'text', text: 'Commit one effect.' }] });
    await killed;
    watchAbort.abort(); await observer;
    const crash = JSON.parse(await readFile(evidence, 'utf8'));
    expect(effects).toBe(1);
    await client!.close(); client = undefined;
    await boot();
    expect((await client!.health()).generation).not.toBe(generation);
    const durable = await client!.eventsAfter('cut-session');
    const committed = durable.records.map(record => record.event);
    expect(committed.map(event => event.seq)).toEqual(Array.from({ length: committed.length }, (_, seq) => seq));
    expect(committed.some(event => event.type === 'tool/call')).toBe(true);
    expect(committed.some(event => event.type === 'tool/result')).toBe(mode === 'flushed');
    expect(observed.at(-1)!.event.seq).toBeLessThanOrEqual(durable.cursor);
    expect(committed.slice(0, observed.length)).toEqual(observed.map(record => record.event));
    if (mode === 'unflushed') {
      expect(durable.cursor).toBeLessThan(crash.seq);
      await expect(client!.eventsAfter('cut-session', -1, crash.seq)).rejects.toThrow('durable source is behind');
    } else expect(durable.cursor).toBeGreaterThanOrEqual(crash.seq);

    // Rebuild a missing projection and an older projection from the same committed source,
    // without binding/activating the Session or dispatching another model/tool request.
    const rebuilt = new DshEventProjection('cut-session', () => {});
    for (const event of committed) rebuilt.durable(event);
    const behind = new DshEventProjection('cut-session', () => {});
    for (const { event } of baseline.records) behind.durable(event);
    for (const { event } of await client!.eventsAfter('cut-session', behind.cursor).then(page => page.records)) behind.durable(event);
    expect(behind.snapshot()).toEqual(rebuilt.snapshot());
    expect(modelCalls).toBe(1); expect(effects).toBe(1);
    const known = [...receipts.values()];
    expect(known).toEqual(['receipt-effect-once']);

    // Explicitly resume only the source, with no prompt. DSH repairs the interrupted turn;
    // the already committed prefix remains identical and no external action is replayed.
    await client!.bind(binding('explicit-recovery'));
    const repaired = await client!.eventsAfter('cut-session');
    expect(repaired.records.slice(0, committed.length)).toEqual(durable.records);
    expect(modelCalls).toBe(1); expect(effects).toBe(1);
    if (mode === 'unflushed') expect(JSON.stringify(repaired.records)).toContain('TOOL_OUTCOME_UNKNOWN');
  } finally {
    await client?.close();
    if (host && host.exitCode === null && host.signalCode === null) { const stopped = once(host, 'exit'); host.kill('SIGKILL'); await stopped; }
    bridge.stop(true);
  }
}, 150000);
