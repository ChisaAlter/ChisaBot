import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthedShell } from "../components/layout/authed-shell";
import { AfterIdle, lazyPart } from "../components/ui/lazy-part";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { setControlAccount } from "../lib/computers/use-control";

/*
 * 首屏用不到的三样（Alt+Space 速记带着整个 Markdown 渲染、定时任务提醒、补资料弹窗）等首屏画完、浏览器空下来再下载挂上
 * （DESIGN.md §41.5）。CopilotKit 不在这里包了：它只包聊天这一块的主区，进聊天时才下载（components/layout/authed-shell.tsx）。
 */
const QuickSpotlight = lazyPart(() => import("../components/chat/quick-spotlight").then((m) => m.QuickSpotlight));
const ScheduleNotifier = lazyPart(() => import("../components/schedules/notifier").then((m) => m.ScheduleNotifier));
const ProfileSetupGate = lazyPart(() => import("../components/layout/profile-dialog").then((m) => m.ProfileSetupGate));

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
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
  // The CopilotKit provider is mounted INSIDE the authed boundary (in AuthedShell, around the chat
  // area), not at the root: the runtime endpoint requires a session, so a provider above the sign-in
  // gate would open a run for a visitor who has not signed in yet.
  component: () => (
    <>
      <AppHotkeys />
      <AuthedShell />
      <AfterIdle>
        <QuickSpotlight />
        <ScheduleNotifier />
        <ProfileSetupGate />
      </AfterIdle>
    </>
  ),
});