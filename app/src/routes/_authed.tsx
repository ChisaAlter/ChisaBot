import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthedShell } from "../components/layout/authed-shell";
import { QuickSpotlight } from "../components/chat/quick-spotlight";
import { isGoingToLogin } from "../lib/auth/login-redirect";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { ProfileSetupGate } from "../components/layout/profile-dialog";
import { CopilotProvider } from "../lib/copilot/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { ScheduleNotifier } from "../components/schedules/notifier";
import { setControlAccount } from "../lib/computers/use-control";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      // The gateway's 401: the page is already on its way to /login?next=… — stay on the boot
      // screen instead of flashing the app's /sign, which the gateway does not serve.
      if (isGoingToLogin()) await new Promise<never>(() => {});
      throw redirect({ to: "/sign" });
    }
    // CB-107：多标签 control 轮询按账号隔离（锁名 / 频道名 / store）。
    setControlAccount(user.id);
    /*
     * Somebody who has not finished onboarding goes there and nowhere else. Here rather than in
     * `_app`, so admin and settings are behind the same gate; checked against the destination so
     * the onboarding route itself stays reachable.
     */
    if (needsOnboarding(user) && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" });
    }
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: () => (
    <CopilotProvider>
      <AppHotkeys />
      <QuickSpotlight />
      <ScheduleNotifier />
      <AuthedShell />
      <ProfileSetupGate />
    </CopilotProvider>
  ),
});
