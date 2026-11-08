import type { IntelligenceSettings } from "../config";
import { z } from "zod";

export type LegacyThread = {
  id: string;
  agentId?: string;
  name?: string | null;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};
export type LegacyHistoryMessage = {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: (
    | { id: string; name: string; args: unknown }
    | {
        id: string;
        type?: string;
        function: { name: string; arguments: unknown };
      }
  )[];
  toolCallId?: string;
  [key: string]: unknown;
};
export type RuntimeEntitlementResponse =
  | {
      status: "ready";
      entitlement: {
        active: boolean;
        source:
          | "managedOrgSubscription"
          | "selfHostedDeploymentLicense"
          | "awsMarketplaceDeploymentLicense";
        features: Record<string, boolean>;
        limits: Record<string, number>;
        planCode?: string;
        entitlementSource?: string;
      };
    }
  | {
      status: "degraded" | "misconfigured" | "unavailable";
      error: { code: string; message: string; retryable: boolean };
    };

export class IntelligenceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlatformRequestError";
  }
}

const entitlementSchema = z.object({
  active: z.boolean(),
  source: z.enum([
    "managedOrgSubscription",
    "selfHostedDeploymentLicense",
    "awsMarketplaceDeploymentLicense",
  ]),
  features: z.record(z.string(), z.boolean()),
  limits: z.record(z.string(), z.number()),
  planCode: z.string().optional(),
  entitlementSource: z.string().optional(),
});
const entitlementResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), entitlement: entitlementSchema }),
  z.object({
    status: z.enum(["degraded", "misconfigured", "unavailable"]),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    }),
  }),
]);

/** The migration reader uses the existing REST ownership contract, without starting an old runtime. */
export class IntelligenceHistoryClient {
  constructor(
    private readonly settings: Pick<IntelligenceSettings, "apiUrl" | "apiKey">,
  ) {}

  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(
      `${this.settings.apiUrl.replace(/\/$/, "")}${path}`,
      {
        headers: {
          authorization: `Bearer ${this.settings.apiKey}`,
          "content-type": "application/json",
        },
        redirect: "error",
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new IntelligenceRequestError(
        `Intelligence history request failed (${response.status}).`,
        response.status,
      );
    }
    return response.json() as Promise<T>;
  }

  async getThread(input: {
    threadId: string;
    userId: string;
  }): Promise<LegacyThread> {
    return (
      await this.request<{ thread: LegacyThread }>(
        `/api/threads/${encodeURIComponent(input.threadId)}?${new URLSearchParams({ userId: input.userId })}`,
      )
    ).thread;
  }

  getThreadMessages(input: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: LegacyHistoryMessage[] }> {
    return this.request(
      `/api/threads/${encodeURIComponent(input.threadId)}/messages?${new URLSearchParams({ userId: input.userId })}`,
    );
  }

  listThreads(input: {
    userId: string;
    agentId: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{ threads: LegacyThread[]; nextCursor?: string | null }> {
    const query = new URLSearchParams({
      userId: input.userId,
      agentId: input.agentId,
    });
    if (input.includeArchived) query.set("includeArchived", "true");
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.cursor) query.set("cursor", input.cursor);
    return this.request(`/api/threads?${query}`);
  }

  async getRuntimeEntitlements(): Promise<RuntimeEntitlementResponse> {
    const body = await this.request<unknown>(
      "/api/entitlements/runtime",
      AbortSignal.timeout(1500),
    );
    const current = entitlementResponseSchema.safeParse(body);
    if (current.success) return current.data;
    const legacy = entitlementSchema
      .extend({ organizationId: z.string() })
      .safeParse(body);
    if (!legacy.success)
      throw new IntelligenceRequestError(
        "Intelligence entitlement response was malformed.",
        502,
      );
    const { organizationId: _organizationId, ...entitlement } = legacy.data;
    return { status: "ready", entitlement };
  }

  getThreadEvents(input: {
    threadId: string;
  }): Promise<{
    events: Record<string, unknown>[];
    decodeErrorRowIds: string[];
    truncated: boolean;
  }> {
    return this.request(
      `/api/_inspect/threads/${encodeURIComponent(input.threadId)}/events`,
    );
  }

  getThreadState(input: {
    threadId: string;
  }): Promise<
    | { kind: "no-snapshot" | "snapshot-decode-error" }
    | { kind: "snapshot"; state: unknown; skippedDeltas: number }
  > {
    return this.request(
      `/api/_inspect/threads/${encodeURIComponent(input.threadId)}/state`,
    );
  }
}
