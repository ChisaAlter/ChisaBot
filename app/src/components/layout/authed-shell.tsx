import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { CHANNEL_ROUTE_ID } from "@/components/channels/chat-search";
import { GlassShell, scopeOfPath } from "@/components/layout/glass-shell";
import type { ShellScope } from "@/components/layout/glass-topbar";
import { KEPT_TTL_MS, KeepAliveStage } from "@/components/layout/keep-alive";
import { RouteSkeleton, SidebarSkeleton } from "@/components/startup-status";
import { lazyPart } from "@/components/ui/lazy-part";
import { useLanding } from "@/lib/agents/landing";
import { draftKeptTtl } from "@/lib/channels/draft-channel";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { clearPendingBot } from "@/lib/chat/pending-switch";

/*
 * 整个聊天（会话客户端、Markdown、工具卡片……）只在地址是一段聊天、或 `/` 正要跳进聊天时才下载（DESIGN.md §41.5）；
 * 直接打开设置 / 管理 / 待处理时不进首屏。地址是聊天时 index.html 里的首屏预加载已经提前把它拉下来了。
 */
const ChannelPage = lazyPart(
  () => import("@/components/channels/channel-page").then((m) => m.ChannelPage),
  <RouteSkeleton />,
);

/*
 * 会话客户端连同工具卡片按需下载（DESIGN.md §41.5）。以前它包着整个 `_authed`，
 * 直接打开设置 / 管理也要先下载、执行它，首屏卡在「正在加载 ChisaBot…」。用得到它的上下文的只有聊天这一块的主区
 * （留着的聊天、新聊天、群聊……；管理里的组件预览自己包一层），所以它只包主区，而且第一次进聊天这一块才挂上：
 * - 挂上的那一刻正好是地址从设置 / 管理换进聊天、主区内容本来就要整个换掉的时候，看不出来；
 * - 挂上以后再也不摘（`conversationMounted` 只会从 false 变 true），留着的聊天去设置再回来照旧不卸载（§98），
 *   正在跑的回合、登记过的前端工具一直在，和以前全局一个 Provider 一样只有一个实例。
 */
const ChatConversation = lazyPart(
  () =>
    import("@/lib/conversations/provider").then(
      (m) => m.ConversationToolsProvider,
    ),
  <RouteSkeleton />,
);

/* 左栏、右栏只在自己那一块（聊天 / 设置 / 管理）用到时下载；没到之前画同样形状的骨架。 */
const LeftRail = lazyPart(
  () => import("@/components/layout/left-rail").then((m) => m.LeftRail),
  <SidebarSkeleton className="glass-sidebar-container" />,
);
const SettingsSidebar = lazyPart(
  () =>
    import("@/components/settings/settings-sidebar").then(
      (m) => m.SettingsSidebar,
    ),
  <SidebarSkeleton className="glass-sidebar-container" />,
);
const AdminSidebar = lazyPart(
  () => import("@/components/admin/admin-sidebar").then((m) => m.AdminSidebar),
  <SidebarSkeleton className="glass-sidebar-container" />,
);
const PanelRail = lazyPart(() =>
  import("@/components/panels/panel-rail").then((m) => m.PanelRail),
);

/**
 * 登录之后的那个外壳（DESIGN.md §98）。
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
  if (pathname === "/onboarding" || pathname.startsWith("/sign-in"))
    return <Outlet />;
  return <ShellFrame pathname={pathname} />;
}

/*
 * 藏着的右栏在进出设置时不重画（jank P1-6；聊天的 memo 见下面 KeptChannelPage）：地址变了只是 `visible` 翻一下，
 * 其余 props 都没变，memo 让它们整棵跳过。
 */
const KeptPanelRail = memo(PanelRail);

/** 空闲时把设置页的代码块先取好（jank P1-6）：设置路由没有 loader，所以只下载 JS，不发 `/api/settings/*`。 */
function useIdleSettingsPrefetch(scope: string) {
  const router = useRouter();
  useEffect(() => {
    if (scope !== "app") return;
    const run = () =>
      void router.preloadRoute({ to: "/settings" }).catch(() => undefined);
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
  // 进过一次聊天就保持会话上下文挂载（见上面 ChatConversation）。
  const [conversationMounted, setConversationMounted] = useState(
    scope === "app",
  );
  if (scope === "app" && !conversationMounted) setConversationMounted(true);
  if (conversationMounted) {
    // 两块一起下载，不排队（index.html 的首屏预加载在地址是聊天时已经提前拉了）。
    void ChatConversation.preload();
    void ChannelPage.preload();
  }
  const sidebar = <ShellSidebar scope={scope} />;
  return (
    <GlassShell
      // 右栏面板卡只属于机器人；在设置 / 管理里藏起来而不是卸载，回来不重载。
      right={<KeptPanelRail />}
      rightHidden={scope !== "app" || pathname === "/tasks"}
      scope={scope}
      sidebar={sidebar}
    >
      {conversationMounted ? (
        <ChatConversation>
          <ChatStage pathname={pathname} />
        </ChatConversation>
      ) : (
        <ChatStage pathname={pathname} />
      )}
    </GlassShell>
  );
}

/**
 * 左栏：聊天左栏（`LeftRail`）一直挂着，在设置 / 管理里只是藏起来（`parked`），旁边换上设置 / 管理的左栏（#403）。
 * 以前按 scope 三选一，关设置 = 聊天左栏重新挂上、重画整份名单、重新拉列表。两个孩子的位置固定，换 scope 不会让
 * 聊天左栏换位置重挂；`memo`：设置里切分类（只有 pathname 变）时整块不重画。
 */
export const ShellSidebar = memo(function ShellSidebar({
  scope,
}: {
  scope: ShellScope;
}) {
  return (
    <>
      <LeftRail className="glass-sidebar-container" parked={scope !== "app"} />
      {scope === "settings" ? (
        <SettingsSidebar className="glass-sidebar-container" />
      ) : scope === "admin" ? (
        <AdminSidebar className="glass-sidebar-container" />
      ) : null}
    </>
  );
});

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
  a.channelId === b.channelId &&
  a.settings === b.settings &&
  a.watch === b.watch;

/** 地址没换时（延后渲染还没跟上的那一次、左栏高亮那一次）不重画整段对话。 */
const KeptChannelPage = memo(ChannelPage);
const chatKey = (a: ChatAddress) => a.channelId;

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 是路由切换触发器；即使 switching 仍为 false，也要清掉新地址的待切换状态。
  useEffect(() => {
    if (!switching) clearPendingBot();
  }, [switching, pathname]);
  // `/` 正在跳的那段（最近的对话）正是留着的这段时才先露着；跳向别的机器人 / 空聊天时不露，免得闪一下别人的对话。
  const landing = useLanding();
  const landingChannel =
    landing.state === "ready" && landing.target.to === "/channel/$channelId"
      ? landing.target.params.channelId
      : null;
  // 还没发过的草稿对话（A1）：只有去新话题页时藏起来就卸载（随即回收，`draft-channel.ts`）；去设置等别的页面照常留
  // 10 分钟，回来图和上传都在。
  const keptTtl = useCallback(
    (kept: ChatAddress) => draftKeptTtl(kept.channelId, pathname, KEPT_TTL_MS),
    [pathname],
  );
  return (
    <KeepAliveStage
      address={address}
      switching={switching}
      idleVisible={(kept) =>
        pathname === "/" &&
        (landing.state === "loading" || landingChannel === kept.channelId)
      }
      ttlMs={keptTtl}
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
      // 一段对话一段（LRU，§98.6）：同一段里只是 ?settings / ?watch 变了不算换一段。
      keyOf={chatKey}
      same={sameAddress}
    >
      <Outlet />
    </KeepAliveStage>
  );
}
