/**
 * Current-user query key and row shape, split out of `queries.ts` so a caller that only needs the
 * already-loaded user (e.g. read its role) does not have to pull `queries.ts` — and with it
 * `login-redirect.ts → chat/md-cache` — into its chunk. `im.tsx` once imported the whole factory and
 * the added edge turned the settings chunk graph into a browser ↔ vendor-markdown import cycle
 * (chunkGuard, DESIGN.md §41.5).
 */

export type OnboardingStatus = {
  step: number;
  completedAt: string | null;
};

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: "admin" | "user";
  /** 名称还没设置（空或仍是邮箱）：进入应用前先弹「首次设置」。 */
  profileNeedsSetup?: boolean;
  /** Null means this deployment does not track onboarding, which reads as nothing to finish. */
  onboarding: OnboardingStatus | null;
};

export const authKeys = {
  all: ["auth"] as const,
  currentUser: () => [...authKeys.all, "current-user"] as const,
  providers: () => [...authKeys.all, "providers"] as const,
};
