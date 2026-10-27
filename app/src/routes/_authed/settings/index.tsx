import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { SkyPreference } from "@/components/settings/sky-preference";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconKeyboard, IconMoon, IconSun } from "@tabler/icons-react";
import { formatHotkey, HOTKEYS, SHELL_HOTKEYS } from "@/lib/hotkeys/hotkeys";

const ALL_HOTKEYS = [...HOTKEYS, ...SHELL_HOTKEYS];

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();
  const [keysOpen, setKeysOpen] = React.useState(false);
  // 分段选择的键盘约定（2026-10-20）：roving tabindex + 方向键在浅色 / 深色之间换。
  const themeKeys = useSegmentedKeys<"light" | "dark">({
    value: dark ? "dark" : "light",
    values: ["light", "dark"],
    onChange: (next) => setDark(next === "dark"),
  });

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   *
   * Connected accounts used to be a section below. It is its own screen now: a connector can need
   * more from a person than one switch, and a section cannot grow a page's worth of that.
   */
  return (
    <PageShell
      description={
        "外观保存在此浏览器，常驻指令跟随账号。"
      }
      title={"通用"}
    >
      <PageSection title={"外观"}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{"主题"}</ItemTitle>
              <ItemDescription>{"浅色或深色外观，保存在此浏览器。"}</ItemDescription>
            </ItemContent>
            <ItemActions>
              {/* 分段控件 (DESIGN.md §11). 跟随系统 is not offered: the theme is stored as a boolean. */}
              <div aria-label={"主题"} className="sg-segmented" {...themeKeys.groupProps} ref={themeKeys.groupRef} role="radiogroup">
                {[
                  { on: false, label: "浅色", Icon: IconSun },
                  { on: true, label: "深色", Icon: IconMoon },
                ].map(({ on, label, Icon }) => (
                  // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
                  <button
                    aria-checked={dark === on}
                    className="sg-segmented-item"
                    key={label}
                    onClick={() => setDark(on)}
                    role="radio"
                    tabIndex={themeKeys.itemTabIndex(on ? "dark" : "light")}
                    type="button"
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </ItemActions>
          </Item>
          <Separator />
          <SkyPreference bare />
        </PageRows>
      </PageSection>
      <StandingInstructions />
      {/*
       * Drawn from the same registry the listeners match against, so this list is what the keys
       * actually do rather than what somebody remembered they did. Read-only on purpose: these
       * are not rebindable, and a row with nothing to click says so by having nothing to click.
       */}
      {/* 快捷键只读、不可改，收进一行，点开看全部（2026-10-12 精简）。 */}
      <PageSection description={"在 ChisaBot 任意位置可用。"} title={"快捷键"}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{"键盘快捷键"}</ItemTitle>
              <ItemDescription>{`共 ${ALL_HOTKEYS.length} 个，不可修改。`}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button onClick={() => setKeysOpen(true)} size="sm" variant="outline">
                <IconKeyboard />
                {"查看"}
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      <Dialog onOpenChange={setKeysOpen} open={keysOpen}>
        <DialogContent className="glass-modal max-h-[80dvh] max-w-[480px] overflow-y-auto">
          <DialogTitle className="font-semibold text-lg">{"键盘快捷键"}</DialogTitle>
          <DialogDescription className="text-xs">{"在 ChisaBot 任意位置可用。"}</DialogDescription>
          <div className="mt-2">
            {ALL_HOTKEYS.map((hotkey, index) => (
              <React.Fragment key={hotkey.id}>
                <div className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">{hotkey.label}</div>
                    <div className="text-xs text-muted-foreground">{hotkey.description}</div>
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
