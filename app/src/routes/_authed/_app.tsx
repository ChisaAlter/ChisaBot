import { createFileRoute, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { rememberBotsLocation } from "@/lib/left-mode";

/** Route chunks the avatar menu leads to, fetched once the app is idle so those clicks never wait. */
const IDLE_PRELOAD = ["/_authed/settings", "/_authed/settings/connected-accounts/", "/_authed/admin"] as const;

function useIdleRoutePreload() {
  const router = useRouter();
  useEffect(() => {
    const run = () => {
      for (const id of IDLE_PRELOAD) {
        const route = (router.routesById as unknown as Record<string, unknown>)[id];
        if (route) void router.loadRouteChunk(route as Parameters<typeof router.loadRouteChunk>[0])?.catch(() => {});
      }
    };
    const idle = window.requestIdleCallback?.(run, { timeout: 4000 });
    const timer = idle === undefined ? window.setTimeout(run, 2500) : undefined;
    return () => {
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [router]);
}

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

/**
 * 机器人和 Claude Code（`/cc`）共用登录后的那一个外壳（DESIGN.md §84、§98，`AuthedShell`）：外壳、顶栏、左栏、
 * 右栏和留着的聊天都画在 `_authed`，这里只记住「机器人这边最后停在哪」和空闲时预取设置分包。
 */
function RouteComponent() {
  useIdleRoutePreload();
  const pathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  const search = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).search });
  useEffect(() => {
    rememberBotsLocation(pathname, search as Record<string, unknown>);
  }, [pathname, search]);
  return <Outlet />;
}
