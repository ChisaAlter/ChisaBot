import { memo } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { InLeftRail, RailParked } from "@/components/layout/rail-sidebar";
import { Sidebar, SidebarRail } from "@/components/ui/sidebar";

/**
 * 登录后的左栏：只有机器人列表（CB-099 删掉了「机器人｜Claude Code」切换，不留空切换器）。
 *
 * `parked`：在设置 / 管理里，这条左栏不卸载，只藏起来（#403）。以前换到设置时它整个卸掉、关设置时重新挂上，
 * 重挂一次要重画整份名单、重新订阅、重新拉列表（4× 降速约 30ms，落在「关闭设置」那一下）。现在外面套一层
 * `hidden`（`display:none`，不占位、不可点、不进无障碍树），`Sidebar` 自己不接返回键、不拨收起开关、手机抽屉不打开；
 * 名单、滚动位置、搜索词都原样留着。`memo`：外壳每换一次地址都重画，藏着的左栏不跟着画。
 */
export const LeftRail = memo(function LeftRail({ className, parked = false }: { className?: string; parked?: boolean }) {
  return (
    <div className={parked ? "hidden" : "contents"} data-left-rail-parked={parked ? "true" : undefined}>
      <RailParked.Provider value={parked}>
        <Sidebar className={className} collapsible="icon" parked={parked} variant="floating">
          <div className="left-rail-shell">
            <InLeftRail.Provider value={true}>
              <div className="left-rail-stack" data-testid="left-rail">
                <div className="left-rail-pane" data-active="true" data-pane="bots">
                  <AppSidebar />
                </div>
              </div>
            </InLeftRail.Provider>
          </div>
          <SidebarRail />
        </Sidebar>
      </RailParked.Provider>
    </div>
  );
});