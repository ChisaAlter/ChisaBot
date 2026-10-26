import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { SignInTool } from "./sign-in-tool";
import { GithubTool } from "./github-tool";
import { VaultTool } from "./vault-tool";
import { PagesTool } from "./pages-tool";
import { ScheduleTool } from "./schedule-tool";
import { ChatFileTools } from "./chat-file-tools";
import { ActiveBotProvider } from "./active-bot";
import { ComputerTools } from "./computer-tools";
import { EscalationTool } from "./escalation-tool";
import { GalleryTools } from "./gallery-tools";
import { HandoffTool } from "./handoff-tool";
import { RenderUiTool } from "./render-ui-tool";
import { WorkerTool } from "./worker-tool";
import { LocalAgentTool } from "./local-agent-tool";
import { SandboxedTools } from "./sandboxed-tools";
import { SkillTools } from "./skill-tools";

/**
 * The CopilotKit client, wrapped once for the whole authenticated app.
 *
 * `credentials: "include"` is the load-bearing part. ChisaBot authenticates with a Better Auth
 * session cookie, and the runtime endpoint sits behind the same guard as every other API route, so
 * without it every run is rejected as anonymous while the rest of the app looks signed in.
 *
 * The URL is relative, like every other call in the app, so the Vite dev proxy and a single-origin
 * deployment both work without a build-time base URL to get wrong.
 *
 * There is no `publicApiKey`. The Intelligence key and licence token are deployment secrets held by
 * the server; a browser never sees them (see server/src/app.ts, where /api/capabilities projects the
 * runtime rather than returning it).
 */
/**
 * 发送失败不能静默（2026-10-13「发消息没反应了」）：服务器重启打断一轮后，那个对话的锁要等到期才放开，
 * 期间每次发送 409 却什么都不显示。现在服务器启动时会释放孤儿锁，这里再兜底：运行失败一律给一条提示。
 * 同一句话连着出现只显示一条（toast 自带去重）。
 */
export function describeCopilotError(code: string, error: Error | undefined): string | null {
  const text = error?.message ?? "";
  if (code === "agent_thread_locked" || /already running|409/i.test(text))
    return "上一条回复还没结束（可能被服务器重启打断），请先点停止或稍等几秒再发。";
  if (code === "agent_run_failed")
    return `消息没有发出去：${text ? text.slice(0, 120) : "连接服务器失败"}，请稍后重试。`;
  return null;
}

export function CopilotProvider({ children }: { children: ReactNode }) {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());

  return (
    <CopilotKitProvider
      runtimeUrl="/api/copilotkit"
      credentials="include"
      onError={({ code, error }) => {
        const message = describeCopilotError(String(code), error);
        if (message) toast.error(message);
      }}
      /*
       * 不传 `openGenerativeUI`：Open Generative UI（`generateSandboxedUi`，沙箱 iframe 自写 HTML）
       * 已停用。SDK 只要运行时声明了该能力或这里出现了这个属性就会把工具提供给 Bot；服务器已不再
       * 声明，这里也不再传，于是 json-render 的 `render_ui`（下面的 RenderUiTool）是唯一的生成式界面。
       */
    >
      {/* Computer tools target the Bot declared by the mounted surface. */}
      <ActiveBotProvider>
        <ComputerTools />
        {/*
          json-render 生成式界面（取代 A2UI）：`render_ui` 在服务器上执行并校验，这里只负责画。
          与服务器提供这个工具是同一个开关（/api/capabilities 的 generativeUi）。
        */}
        {capabilities?.generativeUi ? <RenderUiTool /> : null}
        {/* 后台任务卡片（DESIGN.md §38.2）：`delegate_task` 在服务器上执行，这里只画。 */}
        <WorkerTool />
        {/* 本地 agent 任务卡片（docs/local-agents.md）：`device_agent_run` 在服务器上执行，这里只画。 */}
        <LocalAgentTool />
        {/* The private sign-in request: a card whose form posts to the server, never to the Bot. */}
        <SignInTool />
        {/* 密钥保险箱的安全输入卡片（DESIGN.md §52）：`vault_request_secret` 在服务器上等，这里只画。 */}
        <VaultTool />
        {/* GitHub 写操作的确认卡片（DESIGN.md §53）：github_create_issue / comment / create_pr 在服务器上等，这里只画。 */}
        <GithubTool />
        {/* 页面卡片（DESIGN.md §54）：page_create / page_update / page_publish 在服务器上跑，这里只画。 */}
        <PagesTool />
        {/* 定时任务的确认卡（DESIGN.md §55）：`schedule_create` 在服务器上执行，这里只画。 */}
        <ScheduleTool />
        {/* 图片生成 / 修改的结果、机器人交给用户的文件卡（DESIGN.md §56）：工具在服务器上执行，这里只画。 */}
        <ChatFileTools />
        {/*
          Draws a Bot bringing in another Bot. Registers no tool: `message_bot` runs on the server,
          where the grant and the caps are. A hop that happens off-screen is the thing to avoid.
        */}
        <HandoffTool />
        <EscalationTool />
        {/* Gallery tools are registered once; their handlers re-read the active Bot to avoid shadowing renderers. */}
        <GalleryTools />
        {/* Browser-authored components use the same component grants as the compiled gallery. */}
        <SandboxedTools />
        {/* Offered only on a Bot holding the skill-creator skill; see skill-tools.tsx. */}
        <SkillTools />
        {children}
      </ActiveBotProvider>
    </CopilotKitProvider>
  );
}
