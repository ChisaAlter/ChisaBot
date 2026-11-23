import {
  IconBug,
  IconChevronDown,
  IconDownload,
  IconTrash,
} from "@tabler/icons-react";
import { useState, useSyncExternalStore } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { SmoothCollapse } from "@/components/ui/motion-primitives";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import {
  clientDiagnostics,
  type DiagnosticCategory,
  MAX_DIAGNOSTIC_ENTRIES,
} from "@/lib/diagnostics/ring-buffer";
import { pcBridge } from "@/lib/pc-bridge";

const CATEGORY_LABELS: Record<DiagnosticCategory, string> = {
  push: "推送",
  network: "网络",
  connection: "连接",
  bridge: "本机桥",
  agent: "代理",
  system: "系统",
};

function formatTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleTimeString("zh-CN", { hour12: false });
}

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 端侧环形诊断日志与一键排障包导出卡片。
 * 自动脱敏任何 token / cookie / Authorization 头，桌面端自动合并 PC 主进程诊断日志。
 */
export function DiagnosticsExportSection() {
  const entries = useSyncExternalStore(
    clientDiagnostics.subscribe,
    clientDiagnostics.snapshot,
    clientDiagnostics.snapshot,
  );
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);

  const counts = entries.reduce<Record<string, number>>((acc, item) => {
    acc[item.category] = (acc[item.category] ?? 0) + 1;
    return acc;
  }, {});

  const summaryParts = (Object.keys(CATEGORY_LABELS) as DiagnosticCategory[])
    .filter((cat) => (counts[cat] ?? 0) > 0)
    .map((cat) => `${CATEGORY_LABELS[cat]} ${counts[cat]}`);

  async function handleExport() {
    setExporting(true);
    try {
      const bridge = pcBridge();
      const desktop = bridge?.diagnosticsExport
        ? await bridge.diagnosticsExport().catch(() => null)
        : null;
      const runtime: Record<string, unknown> = {
        userAgent:
          typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
        language:
          typeof navigator !== "undefined" ? navigator.language : "zh-CN",
        online: typeof navigator !== "undefined" ? navigator.onLine : true,
        desktopBridgeAttached: Boolean(bridge),
      };
      const json = clientDiagnostics.exportJson({ runtime, desktop });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadTextFile(`chisabot-diagnostics-${stamp}.json`, json);
      toast.success("已导出脱敏 JSON 排障包");
    } catch {
      toast.error("导出排障包失败，请重试");
    } finally {
      setExporting(false);
    }
  }

  function handleClear() {
    clientDiagnostics.clear();
    toast.success("已清空本机诊断日志缓冲");
  }

  return (
    <PageSection
      description={`仅保存在本机内存中（环形上限 ${MAX_DIAGNOSTIC_ENTRIES} 条），导出时自动脱敏所有 Token、Cookie 与 Authorization 请求头。`}
      settingItem="updates.diagnostics"
      title="端侧诊断日志"
    >
      <PageRows>
        <Item data-setting-item="updates.diagnostics.export" size="sm">
          <ItemContent>
            <ItemTitle className="flex items-center gap-1.5">
              <IconBug className="size-4 text-muted-foreground" />
              {"推送 / 网络 / 连接排障包"}
            </ItemTitle>
            <ItemDescription>
              {entries.length > 0
                ? `当前已记录 ${entries.length} / ${MAX_DIAGNOSTIC_ENTRIES} 条（${summaryParts.join(" · ")}）。`
                : "当前暂无诊断事件记录，仍可导出包含运行环境与桌面端状态的排障包。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <div className="flex flex-wrap items-center gap-2">
              {entries.length > 0 ? (
                <Button
                  aria-expanded={expanded}
                  onClick={() => setExpanded((prev) => !prev)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <IconChevronDown
                    aria-hidden
                    className={`size-3.5 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
                  />
                  {expanded ? "收起" : "预览"}
                </Button>
              ) : null}
              <Button
                disabled={entries.length === 0}
                onClick={handleClear}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconTrash className="size-3.5" />
                {"清空"}
              </Button>
              <Button
                disabled={exporting}
                onClick={() => void handleExport()}
                size="sm"
                type="button"
                variant="default"
              >
                <IconDownload className="size-3.5" />
                {exporting ? "导出中…" : "导出 JSON"}
              </Button>
            </div>
          </ItemActions>
        </Item>

        <SmoothCollapse open={expanded && entries.length > 0} unmountOnExit>
          <Separator />
          <div
            className="max-h-60 space-y-1.5 overflow-y-auto px-4 py-3 font-mono text-xs"
            data-testid="diagnostics-preview-list"
          >
            {entries
              .slice(-20)
              .reverse()
              .map((entry) => (
                <div
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5"
                  key={entry.id}
                >
                  <div className="min-w-0 flex-1 truncate">
                    <span className="mr-1.5 text-muted-foreground">
                      {`[${CATEGORY_LABELS[entry.category]}]`}
                    </span>
                    <span className="font-medium">{entry.event}</span>
                    {entry.message ? (
                      <span className="ml-1.5 text-muted-foreground">
                        {entry.message}
                      </span>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {formatTime(entry.at)}
                  </span>
                </div>
              ))}
          </div>
        </SmoothCollapse>
      </PageRows>
    </PageSection>
  );
}
