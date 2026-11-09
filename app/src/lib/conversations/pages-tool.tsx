import { useEffect } from "react";
import { z } from "zod";
import { PageCard } from "@/components/pages/page-card";
import { useRenderTool } from "@/lib/chat/renderers";
import { pageIdFromResult, reportPageOrigin } from "@/lib/pages";

/**
 * 页面工具（服务器工具，server/src/pages/service.ts）在聊天里画成页面卡片（DESIGN.md §54）。
 * RENDER ONLY。参数流式到达时先出同尺寸骨架，工具返回 ⟦page:id⟧ 后换成真卡片。
 */
const parameters = z.object({
  title: z.string().optional(),
  page: z.string().optional(),
});

function render({
  parameters: given,
  status,
  result,
}: {
  parameters?: { title?: unknown; page?: unknown };
  status: string;
  result?: unknown;
}) {
  const text = typeof result === "string" ? result : undefined;
  const id = pageIdFromResult(text);
  return (
    <PageCard
      failed={status === "complete" && !id}
      pageId={id}
      pendingTitle={typeof given?.title === "string" ? given.title : undefined}
    />
  );
}

export function PagesTool() {
  // 告诉服务器从哪个地址打开 ChisaBot，机器人回复里的页面链接才是完整地址（网关后面服务器看不到）。
  useEffect(() => reportPageOrigin(), []);
  useRenderTool({ name: "page_create", parameters, render });
  useRenderTool({ name: "page_update", parameters, render });
  useRenderTool({ name: "page_publish", parameters, render });
  return null;
}
