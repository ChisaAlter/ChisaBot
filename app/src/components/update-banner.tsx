import { IconRefresh, IconSparkles, IconX } from "@tabler/icons-react";
import { confirmDialog } from "@/components/ui/confirm";
import { refreshWouldInterrupt } from "@/lib/activity";
import { usePcLocal } from "@/lib/pc-bridge";
import { useNewVersion } from "@/lib/version";
import { presenceRef } from "@/lib/presence-flag";

/**
 * 「有新版本，点此刷新」（docs/online-update.md，DESIGN.md §22）。
 *
 * 顶部居中的一枚玻璃胶囊（L3），只在服务器上的构建号和这页打包时的不一样时出现；可以关掉，同一个
 * 版本关掉后不再出现。与 PC 客户端更新互斥：当 PC 客户端正在下载或已准备好桌面端更新时，不展示网页刷新条，
 * 避免网页刷新与客户端重装/更新同时触发。从不自动刷新：机器人还在回复、输入框上挂着没发出去的附件、或编辑中的消息 /
 * 审批回答还没发出去时，点了也先确认——这三样刷新都会丢 / 打断。聊天输入框里的字不算：它记在
 * localStorage 里（`lib/chat/ui-memory.ts`），刷新回来还在。
 */
export function UpdateBanner({ bundled, pollMs }: { bundled?: string; pollMs?: number } = {}) {
  const { available, dismiss } = useNewVersion({ bundled, pollMs });
  const [pcLocal] = usePcLocal();
  const pcUpdateActive =
    pcLocal?.update?.status === "downloading" || pcLocal?.update?.status === "downloaded";
  if (!available || pcUpdateActive) return null;

  async function refresh() {
    const blocker = refreshWouldInterrupt();
    if (blocker) {
      const reasons = [
        blocker.running
          ? "刷新后回复会在后台继续，回来时可以在对话里看到结果；正在显示的流式内容会重新加载。"
          : "",
        blocker.attachments > 0
          ? `还有 ${blocker.attachments} 个附件没发出去，刷新后要重新选一遍（附件只在这个页面里，不像聊天草稿会记住）。`
          : "",
        blocker.unsent
          ? "刷新会清掉正在编辑的消息和还没提交的回答；聊天输入框里的草稿会记住，回来还在。"
          : "",
      ].filter(Boolean);
      const ok = await confirmDialog({
        title: blocker.running
          ? "机器人还在回复，现在刷新？"
          : blocker.attachments > 0
            ? "还有没发出去的附件，现在刷新？"
            : "还有没发出去的内容，现在刷新？",
        description: reasons.join(" "),
        confirmLabel: "仍然刷新",
      });
      if (!ok) return;
    }
    window.location.reload();
  }

  return (
    <div className="update-banner" data-update-banner ref={presenceRef("has-update-banner")} role="status" aria-live="polite">
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
