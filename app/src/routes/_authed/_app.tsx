import { createFileRoute, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useExternalConnection, useIdleTask } from "@/hooks";
import { rememberBotsLocation } from "@/lib/bots-location";
import { objectConnectionKey } from "@/lib/connection-key";

/** Route chunks the avatar menu leads to, fetched once the app is idle so those clicks never wait. */
const IDLE_PRELOAD = ["/_authed/settings", "/_authed/settings/connected-accounts/", "/_authed/admin"] as const;

function useIdleRoutePreload() {
  const router = useRouter();
  useIdleTask(
    () => {
      for (const id of IDLE_PRELOAD) {
        const route = (router.routesById as unknown as Record<string, unknown>)[id];
        if (route) void router.loadRouteChunk(route as Parameters<typeof router.loadRouteChunk>[0])?.catch(() => {});
      }
    },
    true,
    4000,
    objectConnectionKey(router),
  );
}

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

/**
 * 机器人页面用登录后的那一个外壳（DESIGN.md §98，`AuthedShell`）：外壳、顶栏、左栏、
 * 右栏和留着的聊天都画在 `_authed`，这里只记住「机器人这边最后停在哪」和空闲时预取设置分包。
 */
function RouteComponent() {
  useIdleRoutePreload();
  const pathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  const search = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).search });
  useExternalConnection(`${pathname}\0${JSON.stringify(search)}`, () => {
    rememberBotsLocation(pathname, search as Record<string, unknown>);
  });
  return <Outlet />;
}
