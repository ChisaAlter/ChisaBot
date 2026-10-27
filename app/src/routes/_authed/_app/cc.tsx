import { createFileRoute, redirect } from "@tanstack/react-router";

/** Claude Code 工作区已移除（CB-099）：旧书签 `/cc` 送回机器人首页。 */
export const Route = createFileRoute("/_authed/_app/cc")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
