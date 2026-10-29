import { PageSkeleton } from "@/components/layout/page-shell";
import { lazyPart } from "@/components/ui/lazy-part";

/**
 * 管理页里要 CopilotKit 上下文的地方（组件库预览里的工具卡片）用这个：CopilotKit 和它带的 Markdown
 * 打开那一页才下载，不跟着管理页一起上首屏（DESIGN.md §41.5）。下载那一下先画页面骨架。
 */
export const LazyCopilotProvider = lazyPart(
  () => import("./provider").then((m) => m.CopilotProvider),
  <PageSkeleton />,
);
