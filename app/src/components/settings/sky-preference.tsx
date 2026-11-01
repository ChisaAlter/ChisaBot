import { Fragment, useEffect } from "react";
import { PageRows } from "@/components/layout/page-shell";
import {
  setSkyEnabled,
  setSkyPreview,
  useSkyState,
} from "@/components/sky-background";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
/** 「背景随时间变化」开关（预览时间滑块已于 2026-10-12 移除）。 */
export function SkyPreference({ bare = false }: { bare?: boolean } = {}) {
  const Wrap = bare ? Fragment : PageRows;
  const { enabled } = useSkyState();

  // Leaving the settings screen drops the preview; the sky goes back to the clock.
  useEffect(() => () => setSkyPreview(null), []);


  return (
    <Wrap>
      <Item data-setting-item="general.sky" size="sm">
        <ItemContent>
          <ItemTitle>{"背景随时间变化"}</ItemTitle>
          <ItemDescription>
            {
              "天空颜色跟随本机时间平滑变化：黎明、白天、傍晚、夜晚。关闭后使用固定的蓝天。"
            }
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label={"背景随时间变化"}
            checked={enabled}
            onCheckedChange={(checked) => {
              setSkyEnabled(checked);
              if (!checked) setSkyPreview(null);
            }}
          />
        </ItemActions>
      </Item>
    </Wrap>
  );
}
