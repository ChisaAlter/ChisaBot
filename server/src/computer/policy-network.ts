/**
 * Getting a Bot's computer its network policy.
 *
 * The rules and their matcher are `agent-computer/src/egress.ts`. A computer refuses every connection
 * until a policy has been pushed to it. ChisaBot has no network policy screen (the upstream enterprise
 * controls were removed in slimming P6-1), so every computer gets {@link NO_NETWORK_POLICY}
 * ("allow all"), which is what upstream pushed when no organization row existed. Pushed on the way to
 * every action ({@link withPolicyPushOnWake}) and every 30 seconds to running computers
 * ({@link startEgressPolicyPush}).
 */
import type { EgressPolicy, EgressRule } from "../../../agent-computer/src/egress";
import type { ComputerProvider } from "./provider";
import { reasonWithoutStatement } from "../db/query-failure";

export type { EgressPolicy, EgressRule };

/** The only policy ChisaBot pushes: the computer reaches the network freely. */
export const NO_NETWORK_POLICY: EgressPolicy = { mode: "allow_all", rules: [] };

/** Keep every running computer on {@link NO_NETWORK_POLICY}; returns a stop function. */
export function startEgressPolicyPush(options: {
  provider?: ComputerProvider;
  token?: string;
  intervalMs?: number;
}): () => void {
  const provider = options.provider;
  if (!provider) return () => undefined;
  let pushing = false;
  const push = async () => {
    if (pushing) return;
    pushing = true;
    try {
      const report = await pushEgressPolicies({
        provider,
        ...(options.token ? { token: options.token } : {}),
        policyForBot: async () => NO_NETWORK_POLICY,
      });
      if (report.failed.length > 0)
        console.warn(
          JSON.stringify({ type: "egress-policy-push-incomplete", ...report }),
        );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "egress-policy-push-failed",
          error: String(error),
        }),
      );
    } finally {
      pushing = false;
    }
  };
  const timer = setInterval(() => void push(), options.intervalMs ?? 30_000);
  timer.unref?.();
  void push();
  return () => clearInterval(timer);
}

export type EgressPushReport = {
  pushed: string[];
  failed: { botId: string; reason: string }[];
};

/**
 * Push each running computer the policy its Bot's owner is under.
 *
 * Only running computers, read from `provider.list()`, which never wakes one. A computer that answers
 * 404 is running an agent-computer without the `/egress-policy` route and is reported, not retried
 * in a loop.
 */
export async function pushEgressPolicies(options: {
  provider: ComputerProvider;
  token?: string;
  policyForBot: (botId: string) => Promise<EgressPolicy>;
  fetchImpl?: typeof fetch;
}): Promise<EgressPushReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const report: EgressPushReport = { pushed: [], failed: [] };
  const computers = await options.provider.list();
  for (const computer of computers) {
    if (computer.status !== "running" || !computer.url) continue;
    try {
      const policy = await options.policyForBot(computer.botId);
      await pushEgressPolicy(computer.url, computer.botId, policy, {
        ...(options.token ? { token: options.token } : {}),
        fetchImpl,
      });
      report.pushed.push(computer.botId);
    } catch (error) {
      report.failed.push({
        botId: computer.botId,
        reason: reasonWithoutStatement(error),
      });
    }
  }
  return report;
}

/** Push one computer one Bot's policy. Throws with the reason when the computer does not take it. */
export async function pushEgressPolicy(
  url: string,
  botId: string,
  policy: EgressPolicy,
  options: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(
    `${url.replace(/\/$/, "")}/egress-policy`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-openbot-bot-id": botId,
        ...(options.token ? { "x-openbot-computer-token": options.token } : {}),
      },
      body: JSON.stringify({
        policy: { mode: policy.mode, rules: policy.rules },
      }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`the computer answered ${response.status}`);
}

/** Without a run to compare, how long a pushed policy is trusted before it is pushed again. */
const UNKNOWN_RUN_REPUSH_MS = 30_000;

/**
 * The provider, with each computer pushed its policy on the way to the action that woke it.
 *
 * A computer holds its policy in memory and refuses every connection until one arrives, so a
 * computer that has just started or resumed from suspension has none. The periodic push only
 * reaches computers `list()` already reports as running, which leaves the first actions after every
 * wake refused for up to its interval. `locate()` is on the path of every action, so the push
 * happens there, once per run of the computer: `sessionOf` names the run, and a new run (a wake, a
 * restart, an image move) is a filter starting empty. A provider that cannot name its run is
 * re-pushed at most every 30 seconds.
 *
 * A failed push is logged, never thrown: the computer refuses egress until a policy arrives, which
 * is the safe side, and the action still gets its computer.
 */
export function withPolicyPushOnWake(
  provider: ComputerProvider,
  options: {
    policyForBot: (
      botId: string,
    ) => Promise<EgressPolicy | undefined> | undefined;
    token?: string;
    fetchImpl?: typeof fetch;
  },
): ComputerProvider {
  const pushed = new Map<string, { run: string | undefined; at: number }>();
  const ensure = async (botId: string, url: string) => {
    const run = await provider.sessionOf?.(botId).catch(() => undefined);
    const last = pushed.get(botId);
    if (
      last &&
      (run !== undefined
        ? last.run === run
        : Date.now() - last.at < UNKNOWN_RUN_REPUSH_MS)
    )
      return;
    try {
      // Inside the try: reading the policy is a database call, and its failure is logged like a
      // failed push rather than failing the action.
      const policy = await options.policyForBot(botId);
      if (!policy) return;
      await pushEgressPolicy(url, botId, policy, {
        ...(options.token ? { token: options.token } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      pushed.set(botId, { run, at: Date.now() });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "egress-policy-push-on-wake-failed",
          botId,
          note: "The computer refuses its network connections until a policy reaches it.",
          error: reasonWithoutStatement(error),
        }),
      );
    }
  };
  return Object.assign(Object.create(provider) as ComputerProvider, {
    locate: async (botId: string) => {
      const url = await provider.locate(botId);
      await ensure(botId, url);
      return url;
    },
  });
}
