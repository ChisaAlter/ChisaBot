import { IconMessageCircle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { LinkOptions } from "@tanstack/react-router";
import { useMemo } from "react";
import type * as React from "react";
import { type RailGroup, SectionRail } from "@/components/layout/section-rail";
import { SettingsFind, SettingsSearchBox, SettingsSearchResults, useSettingsSearch } from "@/components/settings/settings-search";
import type { Sidebar } from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { botsTarget } from "@/lib/bots-location";
import { navGroups, type SettingsViewer } from "@/lib/settings/registry";

/**
 * 「设置」左栏（偏好设置和管理后台共用，DESIGN.md §97 重新整合）。
 *
 * 导航和设置搜索都从 lib/settings/registry.ts 一张登记表来：
 * 通用 · 机器人（权限与审批、记忆、技能、定时任务、页面）· 电脑与设备（设备、云端工作区、云端浏览器）·
 * 账号与连接（账号连接、IM 接入、账号；「密钥」并在账号连接的标签里，只能搜到）· 模型（模型、生图与识图）· 系统（系统更新、活动记录、权限规则）· 高级（工作流、插件与 MCP）。
 * 管理员才有的页、部署开关（CHISABOT_EXTRAS / CHISABOT_ACCOUNTS_UI）关着的页不显示；一组一项都不剩就整组不显示。
 * 管理员看到的组多，桌面左栏里除「通用」外每组都能折叠（没记过开关时只展开当前页所在的组，CB-058 / §71.7）；手机抽屉照常全列。
 * 路由都没变，旧地址照常能打开；标题下面是设置搜索（Ctrl/⌘ K 或 /）。
 */
export function SettingsSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const viewer: SettingsViewer = useMemo(
    () => ({ admin: user?.role === "admin", extras: capabilities?.extras ?? [], accountsUi: capabilities?.accountsUi !== false }),
    [user?.role, capabilities?.extras, capabilities?.accountsUi],
  );
  const groups: RailGroup[] = useMemo(
    () =>
      navGroups(viewer).map(({ group, pages }) => ({
        ...(group.label ? { label: group.label } : {}),
        ...(viewer.admin && group.label
          ? { collapsible: { storageKey: `chisabot-settings-g-${group.id}`, defaultOpen: group.id === "bots", desktopOnly: true } }
          : {}),
        items: pages.map((page) => ({
          title: page.title,
          sub: page.sub,
          icon: page.icon,
          ...(page.exact ? { exact: true } : {}),
          linkOptions: { to: page.to } as LinkOptions,
        })),
      })),
    [viewer],
  );
  const search = useSettingsSearch(viewer);
  const back = botsTarget();
  return (
    <>
      <SettingsFind />
      <SectionRail
        ariaLabel={"设置分区"}
        title={"设置"}
        footerLink={{ label: "返回聊天", to: back.to, ...(back.search ? { search: back.search } : {}), icon: IconMessageCircle }}
        groups={groups}
        header={<SettingsSearchBox search={search} />}
        body={search.query.trim() ? <SettingsSearchResults search={search} /> : undefined}
        {...props}
      />
    </>
  );
}
