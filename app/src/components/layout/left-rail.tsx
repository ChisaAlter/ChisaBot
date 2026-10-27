import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { InLeftRail } from "@/components/layout/rail-sidebar";
import { Sidebar, SidebarRail } from "@/components/ui/sidebar";

/** 登录后的左栏：只有机器人列表（CB-099 删掉了「机器人｜Claude Code」切换，不留空切换器）。 */
export function LeftRail({ className }: { className?: string }) {
  return (
    <Sidebar className={className} collapsible="icon" variant="floating">
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
  );
}
