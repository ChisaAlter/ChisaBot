import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthedShell } from "../components/layout/authed-shell";
import { QuickSpotlight } from "../components/chat/quick-spotlight";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { ProfileSetupGate } from "../components/layout/profile-dialog";
import { CopilotProvider } from "../lib/copilot/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { ScheduleNotifier } from "../components/schedules/notifier";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
    }
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
