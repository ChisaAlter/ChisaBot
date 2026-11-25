import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { formatHotkey, getHotkey } from "@/lib/hotkeys/hotkeys";
import { setSimpleMode, useSimpleMode } from "@/lib/simple-mode";

/**
 * 「精简模式」一键开关（账号菜单 / 设置 → 通用 / 快捷键 Ctrl+Alt+M）。
 * 开启后界面收敛为「左侧机器人列表 + 中间对话工作区」双栏，刷新记住状态并随时可切回标准模式。
 */
export function SimpleModePreference() {
  const enabled = useSimpleMode();
  const shortcut = formatHotkey(getHotkey("simple-mode").combo).join("+");

  return (
    <Item data-setting-item="general.simple-mode" size="sm">
      <ItemContent>
        <ItemTitle>{"精简模式"}</ItemTitle>
        <ItemDescription>
          {`将界面收敛为左侧机器人列表与中间对话双栏，隐藏右侧栏与非核心工具按钮（快捷键 ${shortcut}）。`}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label={"精简模式"}
          checked={enabled}
          data-testid="simple-mode-switch"
          onCheckedChange={(checked) => setSimpleMode(checked)}
        />
      </ItemActions>
    </Item>
  );
}
