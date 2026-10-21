import type { SQL } from "bun";

/** Includes acquiring a pooled connection, receiving its response, and transaction finalization. */
export const DATABASE_TIMEOUT_MS = 30_000;

export class DatabaseTimeoutError extends Error {
  readonly code = "DATABASE_TIMEOUT";
  constructor(timeoutMs: number) {
    super(`Database operation exceeded ${timeoutMs}ms. Its outcome may be unknown; it was not retried.`);
    this.name = "DatabaseTimeoutError";
  }
}

type Pending = { fail: (error: unknown) => void; cancel?: () => void };
type Generation = { client: SQL; pending: Set<Pending>; failed?: { error: unknown } };
type Scope = { open: boolean };
type Query = SQL.Query<unknown>;

function throwIfFailed(pool: Generation) {
  if (pool.failed) throw pool.failed.error;
}

function brokenConnection(error: unknown): boolean {
  let current = error as { code?: unknown; errno?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 6; depth++) {
    // Node/Bun socket errors use a numeric errno, while PostgreSQL uses a string SQLSTATE.
    // Test both fields: a numeric errno must neither throw here nor mask a useful string code.
    for (const code of [current.errno, current.code]) {
      if (typeof code === "string" && (code.startsWith("08") || code === "ERR_POSTGRES_CONNECTION_CLOSED")) return true;
    }
    current = current.cause as typeof current;
  }
  return false;
}

/**
 * Keep Bun SQL's parameter binding, result modes and transaction implementation. Only supervise its
 * public operations. A PostgreSQL statement_timeout cannot expire Bun's pool queue or a response
 * lost after COMMIT. Every database wait therefore has a wall-clock deadline as well; a transaction
 * callback's own business waits are excluded.
 *
 * A damaged generation is retired, never retried. Its outstanding queries are cancelled before the
 * pool is closed, so a queued write cannot run later when a connection frees up. New operations get
 * a new pool; transactions and lazy queries already associated with the old pool stay failed.
 */
export function recoveringSql(makeClient: () => SQL, timeoutMs = DATABASE_TIMEOUT_MS): SQL {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError("Database queryTimeoutMs must be a positive integer below 2^31.");
  }
  let closed = false;
  let current: Generation | undefined = { client: makeClient(), pending: new Set() };
  const closing = new Set<Promise<void>>();
  const closedError = () => Object.assign(new Error("Database client is closed."), { code: "DATABASE_CLOSED" });
  const generation = () => {
    if (closed) throw closedError();
    return current ??= { client: makeClient(), pending: new Set() };
  };
  const trackClose = (client: SQL, seconds: number) => {
    // Bun 1.3.14 tests `if (timeout)`: timeout:0 means graceful, and hangs on a silent socket.
    const promise = client.close({ timeout: Math.min(timeoutMs / 1000, Math.max(0.001, seconds)) }).catch(() => {});
    closing.add(promise);
    void promise.then(() => closing.delete(promise));
    return promise;
  };
  const retire = (pool: Generation, error: unknown) => {
    if (pool.failed) return;
    pool.failed = { error };
    if (current === pool) current = undefined;
    const pending = [...pool.pending];
    for (const operation of pending) {
      try { operation.cancel?.(); } catch { /* Closing the pool is the final cancellation boundary. */ }
    }
    for (const operation of pending) operation.fail(error);
    void trackClose(pool.client, 0.001);
  };
  function supervise<T>(pool: Generation, start: (clock: { pause: () => void; resume: () => void }) => PromiseLike<T>, cancel?: () => void): Promise<T> {
    if (pool.failed) return Promise.reject(pool.failed.error);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clock = {
        pause: () => { clearTimeout(timer); timer = undefined; },
        resume: () => {
          clearTimeout(timer);
          if (!done) timer = setTimeout(() => retire(pool, new DatabaseTimeoutError(timeoutMs)), timeoutMs);
        },
      };
      const finish = (action: () => void) => {
        if (done) return;
        done = true;
        clock.pause();
        pool.pending.delete(operation);
        action();
      };
      const operation: Pending = { fail: (error) => finish(() => reject(error)), cancel };
      clock.resume();
      pool.pending.add(operation);
      const fail = (error: unknown) => {
        if (brokenConnection(error)) retire(pool, error);
        else operation.fail(error);
      };
      try {
        Promise.resolve(start(clock)).then((value) => finish(() => resolve(value)), fail);
      } catch (error) { fail(error); }
    });
  }
  function queryProxy(query: Query, pool: Generation, scope?: Scope): Query {
    let running: Promise<unknown> | undefined;
    const run = () => running ??= scope && !scope.open
      ? Promise.reject(closedError())
      : supervise(pool, () => query, () => { query.cancel(); });
    const proxy = new Proxy(query, {
      get(target, key) {
        if (key === "then") return (...args: Parameters<Promise<unknown>["then"]>) => run().then(...args);
        if (key === "catch") return (...args: Parameters<Promise<unknown>["catch"]>) => run().catch(...args);
        if (key === "finally") return (...args: Parameters<Promise<unknown>["finally"]>) => run().finally(...args);
        if (key === "execute") return () => { void run().catch(() => {}); return proxy; };
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key === "values" || key === "raw" || key === "simple" || key === "cancel") {
          return (...args: unknown[]) => { Reflect.apply(value, target, args); return proxy; };
        }
        return value.bind(target);
      },
    });
    return proxy;
  }
  function clientProxy(fixed?: Generation, scopedClient?: SQL, scope?: Scope): SQL {
    const choose = () => {
      if (scope && !scope.open) throw closedError();
      const pool = fixed ?? generation();
      if (pool.failed) throw pool.failed.error;
      return { pool, client: scopedClient ?? pool.client };
    };
    // The target preserves Bun's callable SQL/SQLHelper surface; the live pool is selected per call.
    const proxy = new Proxy((..._args: unknown[]) => {}, {
      apply(_target, _thisArg, args) {
        const { pool, client } = choose();
        return wrapResult(Reflect.apply(client, client, args), pool, scope);
      },
      get(_target, key, receiver) {
        // SQL is a callable object and callers also decorate it (for example unsafe spies). Keep
        // assigned own properties observable rather than silently accepting and ignoring writes.
        if (Object.hasOwn(_target, key)) return Reflect.get(_target, key, receiver);
        if (key === "bind" || key === "call" || key === "apply") return Reflect.get(_target, key, receiver);
        if (key === "then") return undefined;
        if (!fixed && (key === "close" || key === "end" || key === Symbol.asyncDispose)) {
          return async (options?: { timeout?: number }) => {
            closed = true;
            if (current) await trackClose(current.client, options?.timeout ?? timeoutMs / 1000);
            await Promise.all([...closing]);
          };
        }
        if (key === "options") return choose().client.options;
        const methods = ["unsafe", "file", "connect", "reserve", "array", "flush", "begin", "transaction", "savepoint", "beginDistributed", "distributed", "commitDistributed", "rollbackDistributed", "close", "end", "release", Symbol.dispose, Symbol.asyncDispose];
        if (!methods.includes(key)) return undefined;
        return (...args: unknown[]) => {
          const { pool, client } = choose();
          const method = Reflect.get(client, key, client);
          if (typeof method !== "function") return method;
          if (key === "begin" || key === "transaction" || key === "savepoint" || key === "beginDistributed" || key === "distributed") {
            return supervise(pool, (clock) => {
              const callbacks = args.map((arg) => typeof arg !== "function" ? arg : async (transaction: SQL) => {
                if (pool.failed) throw pool.failed.error;
                // BEGIN/connection acquisition and COMMIT/ROLLBACK are bounded. Business code may
                // wait between statements; each statement has its own clock rather than a total
                // transaction deadline that could kill a healthy transaction during non-DB work.
                clock.pause();
                const innerScope = { open: true };
                try {
                  const result = await arg(clientProxy(pool, transaction, innerScope));
                  const resolved = Array.isArray(result) ? await Promise.all(result) : result;
                  throwIfFailed(pool);
                  return resolved;
                } finally { innerScope.open = false; clock.resume(); }
              });
              return Reflect.apply(method, client, callbacks) as PromiseLike<unknown>;
            });
          }
          if (key === "reserve") {
            return supervise<SQL>(pool, () => Reflect.apply(method, client, args))
              .then((reserved) => clientProxy(pool, reserved, { open: true }));
          }
          if (key === "connect") {
            return supervise<SQL>(pool, () => Reflect.apply(method, client, args)).then(() => proxy);
          }
          if (scope && (key === "release" || key === "close" || key === "end" || key === Symbol.dispose || key === Symbol.asyncDispose)) {
            scope.open = false;
          }
          return wrapResult(Reflect.apply(method, client, args), pool, scope);
        };
      },
    });
    return proxy as unknown as SQL;
  }
  function wrapResult(result: unknown, pool: Generation, scope?: Scope): unknown {
    if (result && typeof (result as Query).cancel === "function") return queryProxy(result as Query, pool, scope);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") return supervise(pool, () => result as PromiseLike<unknown>);
    return result;
  }
  return clientProxy();
}
