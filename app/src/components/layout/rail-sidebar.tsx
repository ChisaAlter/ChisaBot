import { createContext, type ComponentProps, useContext } from "react";
import { Sidebar, SidebarRail } from "@/components/ui/sidebar";

/** 在 `LeftRail`（DESIGN.md §84）里时，各自的左栏只出内容，不再各套一个 `Sidebar` 容器。 */
export const InLeftRail = createContext(false);

/** 这条左栏这会儿藏着（在设置 / 管理里留着没卸载，`LeftRail` 的 `parked`）：里面的东西别抢焦点等全局请求。 */
export const RailParked = createContext(false);

/** 左栏内容的外框：单独用（测试、别处）时就是原来的 `Sidebar`；在 `LeftRail` 里只出内容。 */
export function RailSidebar({ children, ...props }: ComponentProps<typeof Sidebar>) {
  if (useContext(InLeftRail)) return <>{children}</>;
  return <Sidebar {...props}>{children}</Sidebar>;
}

/** 同上：`LeftRail` 自己带一条边上的拖动条，里面的不再重复。 */
export function RailSidebarEdge() {
  if (useContext(InLeftRail)) return null;
  return <SidebarRail />;
}
