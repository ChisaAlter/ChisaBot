import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * What this deployment can do, as the server is willing to say it.
 *
 * A projection, not the runtime. `/api/capabilities` is reachable before anybody has signed in, so
 * only fields somebody may know unauthenticated appear on it; the Intelligence contract and every
 * deployment secret stay on the server. See server/src/app.ts.
 */
export type DeploymentCapabilities = {
  mode?: "local" | "intelligence";
  durableHistory?: boolean;
  learning?: boolean;
  /**
   * Whether a Bot may answer with an interface it wrote itself.
   *
   * Read by the browser because the browser owns half of this capability: the SDK's provider is what
   * offers the model the tool that generates one. A deployment that turned the server half off while
   * the browser kept offering the tool would have Bots writing whole interfaces that nothing draws,
   * so both halves read this one answer.
   */
  generativeUi: boolean;
  /**
   * Whether to show the banner offering help self-hosting ChisaBot. A fork that runs ChisaBot for its
   * own organization turns it off with CHISABOT_SELF_HOST_BANNER=false, and the server answers false
   * for a deployment on a paid Intelligence plan.
   */
  selfHostBanner: boolean;
  /** 设置 → 管理 →「账号」入口（朋友账号，CB-040）。默认隐藏：多用户以后再做（2026-10-15）。 */
  accountsUi?: boolean;
  /** 功能精简（DESIGN.md §74）：默认隐藏、这台部署用 CHISABOT_EXTRAS 重新打开的功能。 */
  extras: string[];
  transcription?: boolean;
};

export const deploymentKeys = {
  all: ["deployment"] as const,
  capabilities: () => ["deployment", "capabilities"] as const,
};

/**
 * What this deployment can do.
 *
 * From the server rather than from the build, like the sign-in options beside it: the container image
 * is built once and knows nothing about the deployment that will run it, so a capability compiled
 * into the bundle can only ever describe the build machine.
 *
 * Absent fields read as off. A server too old to answer, or one that failed to, is a server this app
 * should not assume a capability of — and for generated interfaces the fail-closed direction is the
 * safe one, because claiming it wrongly is what makes a Bot generate something nothing renders.
 */
export function deploymentCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: deploymentKeys.capabilities(),
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<DeploymentCapabilities> => {
      /*
       * The whole body, then one field off it. `/api/capabilities` answers with a bare object rather
       * than the envelope most endpoints use, which is why this reads the Response itself instead of
       * naming a key — the same shape the sign-in query uses.
       */
      const body = (await (
        await client("/api/capabilities", {
          fallback: "此部署的能力无法加载。",
        })
      ).json()) as {
        mode?: "local" | "intelligence";
        durableHistory?: boolean;
        learning?: boolean;
        generativeUi?: boolean;
        selfHostBanner?: boolean;
        accountsUi?: boolean;
        extras?: unknown;
        transcription?: boolean;
      };

      return {
        mode:
          body.mode === "local" || body.mode === "intelligence"
            ? body.mode
            : undefined,
        durableHistory: body.durableHistory === true,
        learning:
          typeof body.learning === "boolean" ? body.learning : undefined,
        generativeUi: body.generativeUi === true,
        selfHostBanner: body.selfHostBanner === true,
        accountsUi: body.accountsUi === true,
        extras: Array.isArray(body.extras)
          ? body.extras.filter((extra): extra is string => typeof extra === "string")
          : [],
        transcription: body.transcription === true,
      };
    },
  });
}
