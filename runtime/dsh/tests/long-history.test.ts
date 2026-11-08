import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DshHostClient } from '../src/client.mjs';
import { DshEventProjection } from '../../../server/src/conversations/dsh-events';

test('long Session compacts model context, preserves display history and continues unfinished work and attachment references', async () => {
  const sentinel = 'PROJECT_SENTINEL=sea-lantern';
  const unfinished = 'PENDING: compare the three remaining samples before publishing';
  const attachment = 'ATTACHMENT: /api/chat-files/saved-reference-17 (observations.csv)';
  const responses: string[] = [];
  const requests: { summary: boolean; model: string; cap: number; chars: number; input: string }[] = [];
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json();
    const input = JSON.stringify(body.messages);
    const last = body.messages.at(-1)?.content;
    const summary = typeof last === 'string' && last.includes('You are now acting as a compaction engine');
    requests.push({ summary, model: body.model, cap: body.max_tokens ?? body.max_completion_tokens, chars: input.length, input });
    const turn = summary ? 0 : responses.length + 1;
    const text = summary
      ? `## Primary Request and Intent\n${sentinel}\n## Files and Code\n${attachment}\n## Pending Jobs\n${unfinished}\n## Next Step\nContinue comparing; publish only when finished.`
      : `TURN-${turn}: ${sentinel}\n${unfinished}\n${attachment}\n${'Observation retained for display; '.repeat(180)}\nEND-${turn}`;
    if (!summary) responses.push(text);
    const chunk = (delta: unknown, reason: string | null) => `data: ${JSON.stringify({ id: `long-${requests.length}`, object: 'chat.completion.chunk', model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const cwd = resolve(import.meta.dir, '..');
  await mkdir(join(cwd, '.runtime'), { recursive: true });
  const home = await mkdtemp(join(cwd, '.runtime', 'long-history-'));
  await writeFile(join(home, 'chisabot.json'), JSON.stringify({ ownerUserId: 'long-owner', port: 0, providers: {} }));
  const host = spawn('node', ['src/start.mjs'], { cwd, windowsHide: true, env: { ...process.env, CHISABOT_DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', client: DshHostClient | undefined;
  host.stdout.on('data', data => { logs += data; }); host.stderr.on('data', data => { logs += data; });
  const bind = (runId: string, model = 'long-model') => ({ sessionId: 'long-session', threadId: 'long-thread', runId, botId: 'bot', actorId: 'long-owner', revision: 1,
    prompt: 'Preserve exact IDs and outstanding requests. Do not publish until all samples are compared.', tools: [],
    model: { primary: { provider: 'configured', model, maxTokens: 2048 }, contextWindow: 8192 },
    connection: { api: 'openai-completions', baseURL: `${upstream.url.origin}/v1`, apiKey: 'isolated-model-key',
      models: [{ id: model, contextWindow: 8192, maxTokens: 2048, input: ['text'] }] },
  });
  const inputs: { id: string; role: 'user'; content: string }[] = [];
  try {
    for (let i = 0; i < 600 && !logs.includes('chisabot-runtime-ready'); i++) {
      if (host.exitCode !== null) throw new Error(logs);
      await delay(100);
    }
    expect(logs).toContain('chisabot-runtime-ready');
    client = await DshHostClient.connect(JSON.parse(await readFile(join(home, 'connection.json'), 'utf8')).endpoint);
    for (let turn = 1; turn <= 8; turn++) {
      await client.bind(bind(`run-${turn}`));
      const input = { id: `request-${turn}`, role: 'user' as const, content: turn === 1 ? `${sentinel}\n${unfinished}\n${attachment}\nRecord observation 1.` : `Record observation ${turn}; keep the outstanding comparison.` };
      inputs.push(input);
      await client.prompt({ sessionId: 'long-session', requestId: input.id, mode: 'queue', content: [{ type: 'text', text: input.content }] });
      expect((await client.wait('long-session', { timeoutMs: 15000 })).reason).toBe('idle');
      const page = await client.eventsAfter('long-session');
      expect(page.records.filter(record => record.event.type === 'assistant/message')).toHaveLength(turn);
      expect(page.records.at(-1)?.event.data.reason?.kind, JSON.stringify(page.records.at(-1))).not.toBe('error');
      await client.release('long-session', `run-${turn}`);
    }
    const source = await client.eventsAfter('long-session');
    const summaries = source.records.filter(record => record.event.type === 'compaction/summary');
    expect(summaries.length, logs).toBeGreaterThanOrEqual(1);
    expect(source.records.some(record => typeof record.event.surfaceOp === 'object' && record.event.type === 'user/message')).toBe(true);
    const summaryRequests = requests.filter(request => request.summary);
    expect(summaryRequests.length).toBe(summaries.length);
    for (const request of summaryRequests) {
      expect(request.cap).toBe(1024);
      expect(request.input).toContain(sentinel);
      expect(request.input).toContain(unfinished);
      expect(request.input).toContain(attachment);
    }
    const resumedRequests = requests.filter(request => !request.summary && request.input.includes('<compacted-summary>'));
    expect(resumedRequests.length).toBeGreaterThan(0);
    for (const request of resumedRequests) {
      expect(request.input).toContain(sentinel);
      expect(request.input).toContain(unfinished);
      expect(request.input).toContain(attachment);
    }
    const display = new DshEventProjection('long-session', () => {}, inputs);
    for (const record of source.records) display.durable(record.event);
    expect(display.snapshot().filter(message => message.role === 'assistant').map(message => message.content)).toEqual(responses);
    expect(display.snapshot().filter(message => message.role === 'user')).toEqual(inputs);
    expect(JSON.stringify(display.snapshot())).not.toContain('<compacted-summary>');

    // Real settings change retains the existing long Session and can select a compatible
    // new model after compaction; the normal run identity test already covers refusal.
    const beforeChange = source.records;
    await client.bind(bind('changed-run', 'replacement-model'));
    await client.prompt({ sessionId: 'long-session', requestId: 'request-changed', mode: 'queue', content: [{ type: 'text', text: 'Continue on the changed model; keep pending work.' }] });
    expect((await client.wait('long-session', { timeoutMs: 15000 })).reason).toBe('idle');
    const final = await client.eventsAfter('long-session');
    expect(final.records.slice(0, beforeChange.length)).toEqual(beforeChange);
    expect(requests.at(-1)?.model).toBe('replacement-model');
    expect(requests.at(-1)?.input).toContain(unfinished);
    expect(requests.at(-1)?.input).toContain(attachment);
    expect(responses).toHaveLength(9);
    const callsBeforeRefusal = requests.length;
    const tooSmall = bind('small-window-run', 'small-window-model');
    tooSmall.model.contextWindow = 4096;
    tooSmall.connection.models[0]!.contextWindow = 4096;
    await client.release('long-session', 'changed-run');
    await client.bind(tooSmall);
    await client.prompt({ sessionId: 'long-session', requestId: 'request-too-small', mode: 'queue', content: [{ type: 'text', text: 'Keep all pending work on this smaller model.' }] });
    expect((await client.wait('long-session', { timeoutMs: 15000 })).reason).toBe('idle');
    const refused = await client.eventsAfter('long-session');
    expect(refused.records.at(-1)?.event.data.reason?.error?.code).toBe('MODEL_SWITCH_COMPACTION_FAILED');
    expect(refused.records.slice(0, final.records.length)).toEqual(final.records);
    expect(requests).toHaveLength(callsBeforeRefusal);
    console.log(JSON.stringify({ scenario: 'A01-long-history', turns: responses.length, compactions: summaries.length, summaryCaps: summaryRequests.map(request => request.cap),
      requestChars: requests.filter(request => !request.summary).map(request => request.chars), sourceEvents: final.records.length, displayRepliesBeforeModelChange: 8 }));
  } finally {
    await client?.close();
    if (host.exitCode === null && host.signalCode === null) { const stopped = once(host, 'exit'); host.kill(); await stopped; }
    upstream.stop(true);
  }
}, 150000);
