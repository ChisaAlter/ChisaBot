import { IconKeyboard } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { AppearancePreferences } from "@/components/settings/appearance-preferences";
import { BusySendModePreference } from "@/components/settings/busy-send-mode-preference";
import { NotificationSettingsSection } from "@/components/settings/notification-settings";
import { PrivacyMaskPreference } from "@/components/settings/privacy-mask-preference";
import { SecurityAuditCard } from "@/components/settings/security-audit-card";
import { SimpleModePreference } from "@/components/settings/simple-mode-preference";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { formatHotkey, HOTKEYS, SHELL_HOTKEYS } from "@/lib/hotkeys/hotkeys";

const ALL_HOTKEYS = [...HOTKEYS, ...SHELL_HOTKEYS];

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const [keysOpen, setKeysOpen] = React.useState(false);

  return (
    <PageShell
      description={"外观与对话偏好保存在此浏览器，常驻指令跟随账号。"}
      title={"通用"}
    >
      <AppearancePreferences />
      <PageSection
        description={
          "精简双栏界面、回复发送行为与屏幕敏感信息遮罩，保存在此浏览器。"
        }
        title={"对话与隐私"}
      >
        <PageRows>
          <SimpleModePreference />
          <Separator />
          <BusySendModePreference />
          <Separator />
          <PrivacyMaskPreference />
        </PageRows>
      </PageSection>
      <StandingInstructions />
      <NotificationSettingsSection />
      <SecurityAuditCard />
      {/* 快捷键只读、不可改，收进一行，点开看全部（2026-10-12 精简）。 */}
      <PageSection description={"在 ChisaBot 任意位置可用。"} title={"快捷键"}>
        <PageRows>
          <Item data-setting-item="general.hotkeys" size="sm">
            <ItemContent>
              <ItemTitle>{"键盘快捷键"}</ItemTitle>
              <ItemDescription>{`共 ${ALL_HOTKEYS.length} 个，不可修改。`}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                onClick={() => setKeysOpen(true)}
                size="sm"
                variant="outline"
              >
                <IconKeyboard />
                {"查看"}
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      <Dialog onOpenChange={setKeysOpen} open={keysOpen}>
        <DialogContent className="glass-modal max-h-[80dvh] max-w-[480px] overflow-y-auto">
          <DialogTitle className="font-semibold text-lg">
            {"键盘快捷键"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {"在 ChisaBot 任意位置可用。"}
          </DialogDescription>
          <div className="mt-2">
            {ALL_HOTKEYS.map((hotkey, index) => (
              <React.Fragment key={hotkey.id}>
                <div className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">{hotkey.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {hotkey.description}
                    </div>
                  </div>
                  <span className="flex shrink-0 gap-1">
                    {formatHotkey(hotkey.combo).map((part) => (
                      <kbd
                        className="rounded-md border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground"
                        key={part}
                      >
                        {part}
                      </kbd>
                    ))}
                  </span>
                </div>
                {index !== ALL_HOTKEYS.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
