import { DshHostClient } from "../../../runtime/dsh/src/client.mjs";

type PooledEntry = {
  client: DshHostClient;
  idleTimer: ReturnType<typeof setTimeout>;
};

export const DEFAULT_DSH_POOL_MAX_IDLE_PER_ENDPOINT = 4;
export const DEFAULT_DSH_POOL_IDLE_TTL_MS = 60_000;

/**
 * Reuses live `DshHostClient` control connections across turns to the same local DSH Host
 * so successive turns skip HTTP handshake + `/health` round-trip when idle.
 */
export class DshClientPool {
  private readonly idleByEndpoint = new Map<string, PooledEntry[]>();
  private readonly inUse = new WeakSet<DshHostClient>();
  private readonly connectFn: (endpoint: string) => Promise<DshHostClient>;
  private readonly maxIdlePerEndpoint: number;
  private readonly idleTtlMs: number;
  private closed = false;

  constructor(options?: {
    connect?: (endpoint: string) => Promise<DshHostClient>;
    maxIdlePerEndpoint?: number;
    idleTtlMs?: number;
  }) {
    this.connectFn =
      options?.connect ?? ((endpoint) => DshHostClient.connect(endpoint));
    this.maxIdlePerEndpoint =
      options?.maxIdlePerEndpoint ?? DEFAULT_DSH_POOL_MAX_IDLE_PER_ENDPOINT;
    this.idleTtlMs = options?.idleTtlMs ?? DEFAULT_DSH_POOL_IDLE_TTL_MS;
  }

  async acquire(endpoint: string): Promise<DshHostClient> {
    if (this.closed) {
      return this.connectFn(endpoint);
    }
    const bucket = this.idleByEndpoint.get(endpoint);
    while (bucket?.length) {
      const entry = bucket.pop();
      if (!entry) break;
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
    const idleTimer = setTimeout(() => {
      const list = this.idleByEndpoint.get(endpoint);
      if (!list) return;
      const index = list.findIndex((entry) => entry.client === client);
      if (index === -1) return;
      list.splice(index, 1);
      if (list.length === 0) this.idleByEndpoint.delete(endpoint);
      void client.close().catch(() => {});
    }, this.idleTtlMs);
    idleTimer.unref?.();
    bucket.push({ client, idleTimer });
    this.idleByEndpoint.set(endpoint, bucket);
  }

  async invalidate(client: DshHostClient | undefined): Promise<void> {
    if (!client) return;
    this.inUse.delete(client);
    for (const [endpoint, list] of this.idleByEndpoint) {
      const index = list.findIndex((entry) => entry.client === client);
      if (index !== -1) {
        const [removed] = list.splice(index, 1);
        if (removed) clearTimeout(removed.idleTimer);
        if (list.length === 0) this.idleByEndpoint.delete(endpoint);
      }
    }
    await client.close().catch(() => {});
  }

  idleCount(endpoint?: string): number {
    if (endpoint !== undefined) {
      return this.idleByEndpoint.get(endpoint)?.length ?? 0;
    }
    let total = 0;
    for (const list of this.idleByEndpoint.values()) total += list.length;
    return total;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const closing: Promise<void>[] = [];
    for (const list of this.idleByEndpoint.values()) {
      for (const entry of list) {
        clearTimeout(entry.idleTimer);
        closing.push(entry.client.close().catch(() => {}));
      }
    }
    this.idleByEndpoint.clear();
    await Promise.all(closing);
  }
}

export const sharedDshClientPool = new DshClientPool();
