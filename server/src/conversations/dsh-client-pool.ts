import { DshHostClient } from "../../../runtime/dsh/src/client.mjs";

type PooledEntry = {
  endpoint: string;
  client: DshHostClient;
  idleTimer: ReturnType<typeof setTimeout>;
};

export const DEFAULT_DSH_POOL_MAX_IDLE_PER_ENDPOINT = 4;
export const DEFAULT_DSH_POOL_MAX_TOTAL_IDLE = 32;
export const DEFAULT_DSH_POOL_IDLE_TTL_MS = 60_000;

/**
 * Reuses live `DshHostClient` control connections across turns to the same local DSH Host
 * so successive turns skip HTTP handshake + `/health` round-trip when idle.
 */
export class DshClientPool {
  private readonly idleByEndpoint = new Map<string, PooledEntry[]>();
  private readonly idleLru = new Set<PooledEntry>();
  private readonly inUse = new WeakSet<DshHostClient>();
  private readonly connectFn: (endpoint: string) => Promise<DshHostClient>;
  private readonly maxIdlePerEndpoint: number;
  private readonly maxTotalIdle: number;
  private readonly idleTtlMs: number;
  private closed = false;

  constructor(options?: {
    connect?: (endpoint: string) => Promise<DshHostClient>;
    maxIdlePerEndpoint?: number;
    maxTotalIdle?: number;
    idleTtlMs?: number;
  }) {
    this.connectFn =
      options?.connect ?? ((endpoint) => DshHostClient.connect(endpoint));
    this.maxIdlePerEndpoint =
      options?.maxIdlePerEndpoint ?? DEFAULT_DSH_POOL_MAX_IDLE_PER_ENDPOINT;
    this.maxTotalIdle =
      options?.maxTotalIdle ?? DEFAULT_DSH_POOL_MAX_TOTAL_IDLE;
    this.idleTtlMs = options?.idleTtlMs ?? DEFAULT_DSH_POOL_IDLE_TTL_MS;
  }

  private evictEntry(entry: PooledEntry): void {
    this.idleLru.delete(entry);
    clearTimeout(entry.idleTimer);
    const list = this.idleByEndpoint.get(entry.endpoint);
    if (list) {
      const index = list.indexOf(entry);
      if (index !== -1) list.splice(index, 1);
      if (list.length === 0) this.idleByEndpoint.delete(entry.endpoint);
    }
    void entry.client.close().catch(() => {});
  }

  async acquire(endpoint: string): Promise<DshHostClient> {
    if (this.closed) {
      return this.connectFn(endpoint);
    }
    const bucket = this.idleByEndpoint.get(endpoint);
    while (bucket?.length) {
      const entry = bucket.pop();
      if (!entry) break;
      this.idleLru.delete(entry);
      clearTimeout(entry.idleTimer);
      if (bucket.length === 0) this.idleByEndpoint.delete(endpoint);
      if ("isConnected" in entry.client && entry.client.isConnected === false) {
        void entry.client.close().catch(() => {});
        continue;
      }
      this.inUse.add(entry.client);
      return entry.client;
    }
    const client = await this.connectFn(endpoint);
    this.inUse.add(client);
    return client;
  }

  release(endpoint: string, client: DshHostClient): void {
    this.inUse.delete(client);
    if (
      this.closed ||
      this.maxTotalIdle <= 0 ||
      this.maxIdlePerEndpoint <= 0 ||
      ("isConnected" in client && client.isConnected === false)
    ) {
      void client.close().catch(() => {});
      return;
    }
    const bucket = this.idleByEndpoint.get(endpoint) ?? [];
    if (bucket.length >= this.maxIdlePerEndpoint) {
      void client.close().catch(() => {});
      return;
    }
    const entry: PooledEntry = {
      endpoint,
      client,
      idleTimer: setTimeout(() => {
        if (!this.idleLru.has(entry)) return;
        this.evictEntry(entry);
      }, this.idleTtlMs),
    };
    entry.idleTimer.unref?.();
    bucket.push(entry);
    this.idleByEndpoint.set(endpoint, bucket);
    this.idleLru.add(entry);
    while (this.idleLru.size > this.maxTotalIdle) {
      const oldest = this.idleLru.values().next().value;
      if (!oldest) break;
      this.evictEntry(oldest);
    }
  }

  async invalidate(client: DshHostClient | undefined): Promise<void> {
    if (!client) return;
    this.inUse.delete(client);
    for (const [endpoint, list] of this.idleByEndpoint) {
      const index = list.findIndex((entry) => entry.client === client);
      if (index !== -1) {
        const [removed] = list.splice(index, 1);
        if (removed) {
          this.idleLru.delete(removed);
          clearTimeout(removed.idleTimer);
        }
        if (list.length === 0) this.idleByEndpoint.delete(endpoint);
      }
    }
    await client.close().catch(() => {});
  }

  idleCount(endpoint?: string): number {
    if (endpoint !== undefined) {
      return this.idleByEndpoint.get(endpoint)?.length ?? 0;
    }
    return this.idleLru.size;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const closing: Promise<void>[] = [];
    for (const entry of this.idleLru) {
      clearTimeout(entry.idleTimer);
      closing.push(entry.client.close().catch(() => {}));
    }
    this.idleLru.clear();
    this.idleByEndpoint.clear();
    await Promise.all(closing);
  }
}

export const sharedDshClientPool = new DshClientPool();
