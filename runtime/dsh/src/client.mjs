import { Context } from '@deepseek-ai/cordis';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import * as Typert from '@deepseek-ai/dsh-typert-registry/client';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote';
import WebSocket from 'ws';
import { expandAssistantStream } from '@deepseek-ai/dsh-llm';

const unwrap = async result => {
  const value = await result;
  if (!value.ok) throw value.error;
  return value.value;
};

/** Authenticated Host client. Reopening it restores observation, never resubmits prompts. */
export class DshHostClient {
  static async connect(endpoint, { signal = AbortSignal.timeout(15_000) } = {}) {
    const launch = new URL(endpoint);
    const origin = launch.origin;
    const exchange = new URL('/connect', origin);
    exchange.searchParams.set('token', launch.searchParams.get('token') ?? '');
    exchange.searchParams.set('interactions', 'none');
    const response = await fetch(exchange, { redirect: 'manual', signal });
    if (response.status !== 302) throw new Error(`DSH authentication failed (${response.status}).`);
    const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    if (!cookie) throw new Error('DSH did not issue an API session.');
    const ctx = new Context();
    const client = new DshHostClient(ctx, origin, cookie);
    try {
      await ctx.plugin({ apply: scope => installConnection(scope, {
        interactions: 'none',
        transport: {
          streamBaseUrl: origin,
          fetch: (path, init) => client.fetch(path, init),
          createWebSocket: url => {
            const socket = new WebSocket(url, { headers: { cookie }, handshakeTimeout: 15_000 });
            client.socket = socket;
            return socket;
          },
        },
      }) });
      await ctx.plugin(Typert);
      await ctx.plugin(Gateway);
      await ctx.remote.$mount(sessionRemote);
      await client.health(signal);
      return client;
    } catch (error) { await client.close(); throw error; }
  }

  constructor(ctx, origin, cookie) { this.ctx = ctx; this.origin = origin; this.cookie = cookie; }

  fetch(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('cookie', this.cookie);
    return fetch(new URL(path, `${this.origin}/`), { ...init, headers, redirect: 'error' });
  }

  async request(path, body, signal) {
    const response = await this.fetch(`/api/chisabot/${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `DSH ${path} failed (${response.status}).`);
    return result;
  }

  health(signal) { return this.request('health', undefined, signal); }
  bind(binding, signal) { return this.request('bind', binding, signal); }
  reattach(binding, signal) { return this.request('reattach', binding, signal); }
  receipt(sessionId, runId, requestId, signal) { return this.request('receipt', { sessionId, runId, requestId }, signal); }
  stop(sessionId, runId, signal) { return this.request('stop', { sessionId, runId }, signal); }
  release(sessionId, runId, signal) { return this.request('release', { sessionId, runId }, signal); }
  checkpoint(sessionId, signal) { return this.request('checkpoint', { sessionId }, signal); }
  prompt(request, signal) { return unwrap(this.ctx.remote.session.prompt(request, signal)); }
  state(sessionId, signal) { return unwrap(this.ctx.remote.session.state({ sessionId }, signal)); }
  wait(sessionId, options = {}, signal) { return unwrap(this.ctx.remote.session.wait({ sessionId, ...options }, signal)); }
  readEvents(sessionId, options = {}, signal) {
    return unwrap(this.ctx.remote.session.events({ address: { kind: 'session', sessionId }, ...options }, signal));
  }
  async events(sessionId, options = {}, signal) {
    const { cursor } = await this.checkpoint(sessionId, signal);
    if (options.throughSeq !== undefined && options.throughSeq > cursor) throw new Error('DSH durable source is behind the observed cursor; this binding requires recovery.');
    return this.readEvents(sessionId, { ...options, throughSeq: options.throughSeq ?? cursor }, signal);
  }
  /** Page backward at a fixed durable cut; return only the uncovered contiguous suffix. */
  async eventsAfter(sessionId, afterSeq = -1, throughSeq, signal) {
    const checkpoint = await this.checkpoint(sessionId, signal);
    if (afterSeq > checkpoint.cursor || throughSeq !== undefined && throughSeq > checkpoint.cursor) throw new Error('DSH durable source is behind the observed cursor; this binding requires recovery.');
    let page = await this.readEvents(sessionId, { maxMessages: 100, throughSeq: throughSeq ?? checkpoint.cursor }, signal);
    const cursor = page.cursor;
    const pages = [];
    while (true) {
      pages.unshift(page.records.filter(record => record.event.seq > afterSeq));
      const first = page.records[0]?.event.seq;
      if (!page.hasMore || first === undefined || first <= afterSeq + 1) break;
      page = await this.readEvents(sessionId, { maxMessages: 100, throughSeq: cursor, beforeSeq: first }, signal);
    }
    return { cursor, records: pages.flat() };
  }
  follow(sessionId, signal) {
    return this.ctx.remote.session.follow({ address: { kind: 'session', sessionId }, assistantStream: true }, signal);
  }
  async close() { await this.ctx.fiber.dispose(); }
}

export function expandActiveAttempt(baseline) {
  const active = baseline?.activeAttempt;
  if (!active) return undefined;
  return { ...active, chunks: expandAssistantStream(active.stream).map(record => record.chunk) };
}
