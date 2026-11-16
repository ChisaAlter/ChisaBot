/** Durable, request-scoped browser handoff shared by the computer, API, and app. */
export type HandoffStatus =
  | "waiting"
  | "taken"
  | "completed"
  | "cancelled"
  | "expired"
  | "interrupted";
export type HandoffSource =
  | "model"
  | "cloudflare"
  | "visible-challenge"
  | "cn-captcha"
  | "human-takeover"
  | "manual";

export const HANDOFF_SOURCES = [
  "model",
  "cloudflare",
  "visible-challenge",
  "cn-captcha",
  "human-takeover",
  "manual",
] as const satisfies readonly HandoffSource[];

export function isHandoffSource(value: unknown): value is HandoffSource {
  return (
    typeof value === "string" &&
    (HANDOFF_SOURCES as readonly string[]).includes(value)
  );
}
export type HandoffRequest = {
  id: string;
  toolCallId?: string;
  reason: string;
  source: HandoffSource;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  finishedAt?: string;
  interruption?: string;
};
export type ComputerControlState = {
  holder: "bot" | "human";
  since: string;
  requested: boolean;
  reason?: string;
  request?: HandoffRequest;
  transitioning: boolean;
  resumeSnapshotRequired: boolean;
  secretWanted?: string;
  secretRef?: string;
  secretSnapshotId?: number;
};
export type RequestHelpInput = {
  reason: string;
  toolCallId?: string;
  source?: HandoffSource;
};
export type ControlRequestInput = { requestId: string };
export type BrowserChallengeKind =
  | "cloudflare"
  | "visible-challenge"
  | "cn-captcha";
export const BROWSER_CHALLENGE_KINDS = [
  "cloudflare",
  "visible-challenge",
  "cn-captcha",
] as const satisfies readonly BrowserChallengeKind[];
export function isBrowserChallengeKind(
  value: unknown,
): value is BrowserChallengeKind {
  return (
    typeof value === "string" &&
    (BROWSER_CHALLENGE_KINDS as readonly string[]).includes(value)
  );
}
export type BrowserChallenge = {
  kind: BrowserChallengeKind;
  reason: string;
  requestId: string;
};
