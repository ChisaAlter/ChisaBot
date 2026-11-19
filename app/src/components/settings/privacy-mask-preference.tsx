import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { setPrivacyMask, usePrivacyMask } from "@/lib/privacy-mask";

/**
 * 「隐私遮罩模式」一键开关（Ctrl+Shift+P / 设置 → 通用 → 外观）。
 * 开启后立即模糊账号邮箱、密钥提示、机器人名称与聊天预览等带 `data-private` 的敏感区域。
 */
export function PrivacyMaskPreference() {
  const enabled = usePrivacyMask();
  return (
    <Item data-setting-item="general.privacy-mask" size="sm">
      <ItemContent>
        <ItemTitle>{"隐私遮罩模式"}</ItemTitle>
        <ItemDescription>
          {
            "录屏、投屏或公共场合使用（快捷键 Ctrl+Shift+P）：自动模糊账号、密钥提示与机器人名称等敏感信息，悬停时轻微显露。"
          }
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label={"隐私遮罩模式"}
          checked={enabled}
          data-testid="privacy-mask-switch"
          onCheckedChange={(checked) => setPrivacyMask(checked)}
        />
      </ItemActions>
    </Item>
  );
}
