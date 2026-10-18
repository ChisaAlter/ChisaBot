/**
 * Synchronous admission, asynchronous draining. No work is queued or replayed.
 *
 * Every admitted action holds a lease. The lease is normally returned by the action's own `finally`,
 * but an action that never settles (a Playwright call on a browser that went half-dead, a launch
 * that never answers) used to hold it forever: `drain` then timed out on every 「接管」 and the Bot's
 * computer stayed unusable until the container restarted (2026-10-17 production incident). So each
 * lease also has a deadline. Past it the barrier gives the lease back on its own and says so through
 * `onExpired`, which is where the caller tears down whatever the action was stuck on.
 */
export type ActionLease = {
  label: string;
  admittedAt: number;
};

export type ExpiredLease = ActionLease & { heldMs: number };

type Options = {
  /** Default lease length. Zero or negative means leases never expire (tests of the old shape). */
  leaseMs?: number;
  onExpired?: (lease: ExpiredLease) => void;
  now?: () => number;
};

export const DEFAULT_ACTION_LEASE_MS = 180_000;

/** Gives the lease back; `shorten` brings its deadline forward (caller hung up). Idempotent. */
export type Release = (() => void) & { shorten(ms: number): void };

export function createActionBarrier(options: Options = {}) {
  const now = options.now ?? Date.now;
  const defaultLease = options.leaseMs ?? DEFAULT_ACTION_LEASE_MS;
  let closed = false;
  const held = new Map<symbol, ActionLease>();
  const waiters = new Set<() => void>();
  const wakeIfIdle = () => {
    if (held.size === 0) for (const wake of [...waiters]) wake();
  };
  return {
    enter(label = "action", leaseMs = defaultLease): Release {
      if (closed)
        throw new Error("Action admission is closed for this computer.");
      const key = Symbol(label);
      const lease: ActionLease = { label, admittedAt: now() };
      held.set(key, lease);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let deadline = leaseMs > 0 ? now() + leaseMs : Number.POSITIVE_INFINITY;
      const give = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (!held.delete(key)) return false;
        wakeIfIdle();
        return true;
      };
      const expire = () => {
        timer = undefined;
        if (!held.has(key)) return;
        const expired = { ...lease, heldMs: now() - lease.admittedAt };
        give();
        try {
          options.onExpired?.(expired);
        } catch {
          // Reporting must never be the reason a lease stays held.
        }
      };
      const arm = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(expire, Math.max(0, ms));
        // A stuck action must not also keep the process from exiting.
        timer.unref?.();
      };
      if (leaseMs > 0) arm(leaseMs);
      const release = (() => {
        give();
      }) as Release;
      /*
       * Bring the deadline forward (never back). Used when the caller hung up: nobody is waiting for
       * the answer any more, so an action that still has not finished a little later is treated as
       * stuck rather than given the full lease.
       */
      release.shorten = (ms: number) => {
        if (!held.has(key)) return;
        const at = now() + Math.max(0, ms);
        if (at >= deadline) return;
        deadline = at;
        arm(ms);
      };
      return release;
    },
    close() {
      closed = true;
    },
    open() {
      closed = false;
    },
    pending() {
      return held.size;
    },
    /** What is holding the barrier right now, oldest first. For logs and diagnostics. */
    holders(): ExpiredLease[] {
      const at = now();
      return [...held.values()]
        .sort((a, b) => a.admittedAt - b.admittedAt)
        .map((lease) => ({ ...lease, heldMs: at - lease.admittedAt }));
    },
    drain(timeoutMs = 30_000): Promise<void> {
      if (held.size === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(
            new Error(
              "An admitted action is still finishing; human control has not been granted. Try taking control again.",
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        waiters.add(wake);
      });
    },
  };
}
