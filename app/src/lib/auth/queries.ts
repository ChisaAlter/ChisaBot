import { queryOptions } from "@tanstack/react-query";
import { goToLogin, isGatewayLoginRequired } from "@/lib/auth/login-redirect";
import { client, tryClient } from "@/lib/client";

/**
 * Where this person is in first-run onboarding.
 *
 * On the user rather than its own query, so the `_authed` gate learns it from the request it
 * already makes. A null `completedAt` is what sends the app to /onboarding.
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

/** Whether the gate holds: there is an onboarding to do and this person has not finished it. */
export function needsOnboarding(user: AuthenticatedUser): boolean {
  return user.onboarding !== null && user.onboarding.completedAt === null;
}

export const authKeys = {
  all: ["auth"] as const,
  currentUser: () => [...authKeys.all, "current-user"] as const,
  providers: () => [...authKeys.all, "providers"] as const,
};

/** An identity provider this deployment can sign somebody in with. */
export type AuthProviderId = "google" | "microsoft" | "okta";

/** What the sign-in screen may offer, answered by the process that knows. */
export type SignInOptions = {
  providers: AuthProviderId[];
};

async function signInOptions(): Promise<SignInOptions> {
  // The whole body, so both fields arrive together. Reading a field off the Response `client`
  // returns without a key quietly yields undefined: the screen would say no provider is configured
  // while the server was saying it has one.
  const body = (await (
    await client("/api/capabilities", { fallback: "无法加载登录" })
  ).json()) as {
    authProviders?: AuthProviderId[];
  };

  return {
    providers: body.authProviders ?? [],
  };
}

/**
 * Which providers the sign-in screen may offer.
 *
 * From the server rather than from the build. The image is built once with no deployment
 * environment, so a list compiled into the bundle can only ever describe the build machine.
 */
export function authProvidersQueryOptions() {
  return queryOptions({
    queryKey: authKeys.providers(),
    queryFn: signInOptions,
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

async function currentUser({ signal }: { signal: AbortSignal }): Promise<AuthenticatedUser | null> {
  const request = new AbortController();
  const forwardCancellation = () => request.abort(signal.reason);
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onRequestAbort = () => rejectAborted(request.signal.reason);
  request.signal.addEventListener("abort", onRequestAbort, { once: true });
  signal.addEventListener("abort", forwardCancellation, { once: true });
  if (signal.aborted) forwardCancellation();
  const deadline = setTimeout(() => {
    request.abort(new Error("登录检查超时，请稍后重试。"));
  }, 15_000);

  try {
    // Cover both response headers and JSON decoding: receiving headers alone must not leave the
    // authentication route waiting forever. The transport also receives the abort signal.
    return await Promise.race([
      (async () => {
        /* A 401 is the signed-out state, rather than a failed request. */
        const response = await tryClient("/api/me", { signal: request.signal });
        if (response.status === 401) {
          // Behind the public gateway its own /login is the sign-in page: go there with the way
          // back, rather than to the app's /sign (main.tsx installs the same check for every fetch).
          if (typeof window !== "undefined" && (await isGatewayLoginRequired(response))) goToLogin();
          return null;
        }
        if (!response.ok) throw new Error(`无法加载当前用户 (${response.status})`);
        const body = (await response.json()) as { user: AuthenticatedUser };
        return body.user;
      })(),
      aborted,
    ]);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", forwardCancellation);
    request.signal.removeEventListener("abort", onRequestAbort);
  }
}

export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: authKeys.currentUser(),
    queryFn: currentUser,
    staleTime: 60_000,
    retry: false,
  });
}
