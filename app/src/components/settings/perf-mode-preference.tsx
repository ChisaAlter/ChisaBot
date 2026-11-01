import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { setPerfMode, usePerfMode } from "@/lib/perf-mode";

/**
 * 「性能模式」开关（2026-10-29，模块 11 审计）：lib/perf-mode.ts 早就有状态和样式，只是一直没有入口。
 * 开了以后不模糊、天空不跑、表情动画停下；保存在此浏览器，多个标签页同步。
 */
export function PerfModePreference() {
  const on = usePerfMode();
  return (
    <Item data-setting-item="性能模式" size="sm">
      <ItemContent>
        <ItemTitle>{"性能模式"}</ItemTitle>
        <ItemDescription>
          {
            "电脑较慢或耗电时打开：面板不再模糊、换成实色底，动态天空停在静态画面，头像表情不再动。"
          }
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label={"性能模式"}
          checked={on}
          data-testid="perf-mode-switch"
          onCheckedChange={(checked) => setPerfMode(checked)}
        />
      </ItemActions>
    </Item>
  );
}
