export const PRIMARY_AGENT_ID_MAX_LENGTH = 128;

export type PrimaryAgentErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "AGENT_NOT_FOUND"
  | "AGENT_PAUSED"
  | "NO_AVAILABLE_AGENT"
  | "STORAGE_UNAVAILABLE";

export type PrimaryAgentResolutionStatus =
  | "configured"
  | "fallback_roster"
  | "fallback_seeded"
  | "none";

export type PrimaryAgentFallbackReason =
  | "NOT_CONFIGURED"
  | "DELETED_OR_MISSING"
  | "FORBIDDEN"
  | "HIDDEN"
  | "PAUSED";

export type PrimaryAgentResolution = {
  status: PrimaryAgentResolutionStatus;
  fallbackUsed: boolean;
  reason?: PrimaryAgentFallbackReason;
};

export type PrimaryAgentEnvelope<TAgent> = {
  configuredAgentId: string | null;
  isPaused: boolean;
  primaryAgent: TAgent | null;
  resolution: PrimaryAgentResolution;
};

/** Rejects blank/padded IDs, path delimiters, and ASCII control chars without excluding system/package IDs. */
export function isValidPrimaryAgentId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > PRIMARY_AGENT_ID_MAX_LENGTH)
    return false;
  if (value.trim() !== value) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
    if (
      value[i] === "/" ||
      value[i] === "\\" ||
      value[i] === "?" ||
      value[i] === "#"
    ) {
      return false;
    }
  }
  return true;
}
