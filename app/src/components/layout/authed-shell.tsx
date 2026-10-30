import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { memo, useEffect } from "react";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { GlassShell, scopeOfPath } from "@/components/layout/glass-shell";
import { LeftRail } from "@/components/layout/left-rail";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { PanelRail } from "@/components/panels/panel-rail";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { CHANNEL_ROUTE_ID, ChannelPage } from "@/components/channels/channel-page";
import { useLanding } from "@/lib/agents/landing";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { clearPendingBot } from "@/lib/chat/pending-switch";
import { memo, useDeferredValue, useEffect, useMemo } from "react";

/**
 * 登录之后的那一个外壳（DESIGN.md §98）。
 *
 * 以前聊天（`_app`）、设置、管理各自画一个 `GlassShell`：从设置回聊天 = 整个外壳卸载再装一遍，聊天跟着卸载，
 * 回来时重新接入、回放、读历史，发送键闪成「停止」、气泡重排、右栏重载——用户看到的「切回来总要刷新一次」。
 *
 * 现在外壳只有一个，挂在 `_authed`：换页面只换左栏内容（聊天 / 设置 / 管理）、顶栏的 scope 和右栏是否显示。
 * 聊天由 `KeptChat` 画在主区里，离开时不卸载，只是藏起来（不可见、不可点、尺寸冻住不重排），回来时原样出现。
 * 没有外壳的页面（引导、登录授权）照旧直接画。
 */
export function AuthedShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname === "/onboarding" || pathname.startsWith("/sign-in")) return <Outlet />;
  return <ShellFrame pathname={pathname} />;
}

/*
 * 藏着的右栏 / 聊天在进出设置时不重画（jank P1-6）：地址变了只是 `visible` 翻一下，
 * 其余 props 都没变，memo 让它们整棵跳过。
 */
const KeptPanelRail = memo(PanelRail);
const KeptChannelPage = memo(ChannelPage);

/** 空闲时把设置页的代码块先取好（jank P1-6）：设置路由没有 loader，所以只下载 JS，不发 `/api/settings/*`。 */
function useIdleSettingsPrefetch(scope: string) {
  const router = useRouter();
  useEffect(() => {
    if (scope !== "app") return;
    const run = () => void router.preloadRoute({ to: "/settings" }).catch(() => undefined);
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 2000);
    return () => window.clearTimeout(id);
  }, [router, scope]);
}

function ShellFrame({ pathname }: { pathname: string }) {
  useChannelEvents();
  const scope = scopeOfPath(pathname);
  useIdleSettingsPrefetch(scope);
  const sidebar =
    scope === "settings" ? (
      <SettingsSidebar className="glass-sidebar-container" />
    ) : scope === "admin" ? (
      <AdminSidebar className="glass-sidebar-container" />
    ) : (
      <LeftRail className="glass-sidebar-container" />
    );
  return (
    <GlassShell
      banner={scope === "app" ? <SelfHostBanner /> : undefined}
      // 右栏面板卡只属于机器人；在设置 / 管理里藏起来而不是卸载，回来不重载。
      right={<KeptPanelRail />}
      rightHidden={scope !== "app"}
      scope={scope}
      sidebar={sidebar}
    >
      <ChatStage pathname={pathname} />
    </GlassShell>
  );
}

type ChatAddress = { channelId: string; settings?: boolean; watch?: boolean };

/** 当前地址是不是一段聊天（`/channel/:id`），是的话它的参数。 */
function useChatAddress(): ChatAddress | null {
  const key = useRouterState({
    select: (s) => {
      const match = s.matches.find((m) => m.routeId === CHANNEL_ROUTE_ID);
      if (!match) return "";
      const search = match.search as { settings?: boolean; watch?: boolean };
      return JSON.stringify([
        (match.params as { channelId: string }).channelId,
        search.settings === true,
        search.watch === true ? true : search.watch === false ? false : null,
      ]);
    },
  });
  // 同一个地址给同一个对象：`useDeferredValue` 按引用比，每次新对象会白跑一遍延后渲染。
  return useMemo(() => {
    if (!key) return null;
    const [channelId, settings, watch] = JSON.parse(key) as [
      string,
      boolean,
      boolean | null,
    ];
    return {
      channelId,
      ...(settings ? { settings: true } : {}),
      ...(watch === null ? {} : { watch }),
    };
  }, [key]);
}

const sameAddress = (a: ChatAddress, b: ChatAddress) =>
  a.channelId === b.channelId && a.settings === b.settings && a.watch === b.watch;

/** 地址没换时（延后渲染还没跟上的那一次、左栏高亮那一次）不重画整段对话。 */
const KeptChannelPage = memo(ChannelPage);

/** 主区：留着的聊天 + 当前路由（`KeepAliveStage`，DESIGN.md §98）。`/` 正在跳到聊天时，留着的聊天照样露着。 */
function ChatStage({ pathname }: { pathname: string }) {
  const routeAddress = useChatAddress();
  /*
   * 切会话即时反馈（FIX-PLAN F0 / P1-1）：从一段对话换到另一段时，整段对话的重新挂载放进延后渲染
   * （`useDeferredValue`，可被打断、不算在点击那一帧里）。这一帧只画左栏高亮，旧对话半透明留着（`data-switching`），
   * 新对话画好了再一次换上，不留白。从设置等别的页面回到对话不延后（那时没有旧对话可留）。
   */
  const deferredAddress = useDeferredValue(routeAddress);
  const switching =
    routeAddress !== null &&
    deferredAddress !== null &&
    routeAddress.channelId !== deferredAddress.channelId;
  const address = switching ? deferredAddress : routeAddress;
  // 地址变了、新对话也换上了（它登记的机器人控件已经到位）才清掉左栏的「正在切过去」，
  // 不然延后渲染那一段旧对话的机器人会跟着又亮起来。
  useEffect(() => {
    if (!switching) clearPendingBot();
  }, [switching, pathname]);
  // `/` 正在跳的那段（最近的对话）正是留着的这段时才先露着；跳向别的机器人 / 空聊天时不露，免得闪一下别人的对话。
  const landing = useLanding();
  const landingChannel =
    landing.state === "ready" && landing.target.to === "/channel/$channelId" ? landing.target.params.channelId : null;
  return (
    <KeepAliveStage
      address={address}
      switching={switching}
      idleVisible={(kept) => pathname === "/" && (landing.state === "loading" || landingChannel === kept.channelId)}
      renderKept={(kept, { visible, epoch }) => (
        <KeptChannelPage
          channelId={kept.channelId}
          epoch={epoch}
          /*
           * 换一段对话就是换一页（2026-10-22）：`ChannelPage` 自己也有「这段对话的」状态——历史对话弹窗开着没有、
           * 计算机自动切标签上一个机器人是不是在干活。不按 channelId 分开的话，从左栏换机器人时那两样都跟着过去了
           * （弹窗突然开在新机器人上）。聊天本身由下面 `ChannelBody` 的 `key={channel.id}` 换，这里只是把壳也换掉。
           */
          key={kept.channelId}
          settings={kept.settings}
          visible={visible}
          watch={kept.watch}
        />
      )}
      same={sameAddress}
    >
      <Outlet />
    </KeepAliveStage>
  );
}
