import { Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import { GlassShell, scopeOfPath } from "@/components/layout/glass-shell";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { CHANNEL_ROUTE_ID } from "@/components/channels/chat-search";
import { RouteSkeleton, SidebarSkeleton } from "@/components/startup-status";
import { lazyPart } from "@/components/ui/lazy-part";
import { useLanding } from "@/lib/agents/landing";
import { useChannelEvents } from "@/lib/channels/use-channel-events";

/*
 * 整个聊天（CopilotKit 对话、Markdown、工具卡片……）只在地址是一段聊天、或 `/` 正要跳进聊天时才下载（DESIGN.md §41.5）；
 * 直接打开设置 / 管理 / 待处理时不进首屏。地址是聊天时 index.html 里的首屏预加载已经提前把它拉下来了。
 */
const ChannelPage = lazyPart(
  () => import("@/components/channels/channel-page").then((m) => m.ChannelPage),
  <RouteSkeleton />,
);

/*
 * CopilotKit 客户端连同全部工具卡片（~500KB gzip）也按需下载（DESIGN.md §41.5）。以前它包着整个 `_authed`，
 * 直接打开设置 / 管理也要先下载、执行它，首屏卡在「正在加载 ChisaBot…」。用得到它的上下文的只有聊天这一块的主区
 * （留着的聊天、新聊天、群聊……；管理里的组件预览自己包一层），所以它只包主区，而且第一次进聊天这一块才挂上：
 * - 挂上的那一刻正好是地址从设置 / 管理换进聊天、主区内容本来就要整个换掉的时候，看不出来；
 * - 挂上以后再也不摘（`copilot` 只会从 false 变 true），留着的聊天去设置再回来照旧不卸载（§98），
 *   正在跑的回合、登记过的前端工具一直在，和以前全局一个 Provider 一样只有一个实例。
 */
const ChatCopilot = lazyPart(() => import("@/lib/copilot/provider").then((m) => m.CopilotProvider), <RouteSkeleton />);

/* 左栏、右栏只在自己那一块（聊天 / 设置 / 管理）用到时下载；没到之前画同样形状的骨架。 */
const LeftRail = lazyPart(
  () => import("@/components/layout/left-rail").then((m) => m.LeftRail),
  <SidebarSkeleton className="glass-sidebar-container" />,
);
const SettingsSidebar = lazyPart(
  () => import("@/components/settings/settings-sidebar").then((m) => m.SettingsSidebar),
  <SidebarSkeleton className="glass-sidebar-container" />,
);
const AdminSidebar = lazyPart(
  () => import("@/components/admin/admin-sidebar").then((m) => m.AdminSidebar),
  <SidebarSkeleton className="glass-sidebar-container" />,
);
const PanelRail = lazyPart(() => import("@/components/panels/panel-rail").then((m) => m.PanelRail));

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

function ShellFrame({ pathname }: { pathname: string }) {
  useChannelEvents();
  const scope = scopeOfPath(pathname);
  // 进过一次聊天这一块就一直挂着 CopilotKit（见上面 ChatCopilot）。
  const [copilot, setCopilot] = useState(scope === "app");
  if (scope === "app" && !copilot) setCopilot(true);
  if (copilot) {
    // 两块一起下载，不排队（index.html 的首屏预加载在地址是聊天时已经提前拉了）。
    void ChatCopilot.preload();
    void ChannelPage.preload();
  }
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
      right={<PanelRail />}
      rightHidden={scope !== "app"}
      scope={scope}
      sidebar={sidebar}
    >
      {copilot ? (
        <ChatCopilot>
          <ChatStage pathname={pathname} />
        </ChatCopilot>
      ) : (
        <ChatStage pathname={pathname} />
      )}
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
  if (!key) return null;
  const [channelId, settings, watch] = JSON.parse(key) as [string, boolean, boolean | null];
  return { channelId, ...(settings ? { settings: true } : {}), ...(watch === null ? {} : { watch }) };
}

const sameAddress = (a: ChatAddress, b: ChatAddress) =>
  a.channelId === b.channelId && a.settings === b.settings && a.watch === b.watch;

/** 主区：留着的聊天 + 当前路由（`KeepAliveStage`，DESIGN.md §98）。`/` 正在跳到聊天时，留着的聊天照样露着。 */
function ChatStage({ pathname }: { pathname: string }) {
  const address = useChatAddress();
  // `/` 正在跳的那段（最近的对话）正是留着的这段时才先露着；跳向别的机器人 / 空聊天时不露，免得闪一下别人的对话。
  const landing = useLanding();
  const landingChannel =
    landing.state === "ready" && landing.target.to === "/channel/$channelId" ? landing.target.params.channelId : null;
  return (
    <KeepAliveStage
      address={address}
      idleVisible={(kept) => pathname === "/" && (landing.state === "loading" || landingChannel === kept.channelId)}
      renderKept={(kept, { visible, epoch }) => (
        <ChannelPage
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
