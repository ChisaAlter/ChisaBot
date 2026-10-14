import { IconRefresh, IconSparkles, IconX } from "@tabler/icons-react";
import { confirmDialog } from "@/components/ui/confirm";
import { refreshWouldInterrupt } from "@/lib/activity";
import { useNewVersion } from "@/lib/version";

/**
 * 「有新版本，点此刷新」（docs/online-update.md，DESIGN.md §22 / §36.5）。
 *
 * 顶栏下靠右的一枚玻璃胶囊（L3；手机上左右贴边成提示条），只在服务器上的构建号和这页打包时的不一
 * 样时出现；可以关掉，同一个版本关掉后不再出现。从不自动刷新：机器人还在回复、或输入框里有没发出
 * 去的字时，点了也先确认。
 */
export function UpdateBanner({ bundled, pollMs }: { bundled?: string; pollMs?: number } = {}) {
  const { available, dismiss } = useNewVersion({ bundled, pollMs });
  if (!available) return null;

  async function refresh() {
    const interrupt = refreshWouldInterrupt();
    if (interrupt) {
      const ok = await confirmDialog({
        title: interrupt === "running" ? "机器人还在回复，现在刷新？" : "输入框里还有没发送的内容，现在刷新？",
        description:
          interrupt === "running"
            ? "刷新后回复会在后台继续，回来时可以在对话里看到结果；正在显示的流式内容会重新加载。"
            : "刷新会清掉还没发送的文字。可以先发送或复制，再点「有新版本」刷新。",
        confirmLabel: "仍然刷新",
      });
      if (!ok) return;
    }
    window.location.reload();
  }

  return (
    <div className="update-banner" data-update-banner role="status" aria-live="polite">
      <button className="update-banner-main" onClick={() => void refresh()} type="button">
        <IconSparkles aria-hidden className="update-banner-ic size-4 shrink-0" />
        <span className="update-banner-t">{"有新版本，点此刷新"}</span>
        <span className="update-banner-v">{available.version}</span>
        <IconRefresh aria-hidden className="size-4 shrink-0" />
      </button>
      <button aria-label={"关闭新版本提示"} className="update-banner-x" onClick={dismiss} type="button">
        <IconX className="size-3.5" />
      </button>
    </div>
  );
}
