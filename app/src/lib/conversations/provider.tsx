import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ToolRendererProvider } from "@/lib/chat/renderers";
import { ConversationSessionProvider } from "@/lib/chat/session-client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { ActiveBotProvider } from "./active-bot";
import { BotFactoryTool } from "./bot-factory-tool";
import { ChatFileTools } from "./chat-file-tools";
import { ComputerTools } from "./computer-tools";
import { EscalationTool } from "./escalation-tool";
import { GalleryTools } from "./gallery-tools";
import { GithubTool } from "./github-tool";
import { HandoffTool } from "./handoff-tool";
import { LocalAgentTool } from "./local-agent-tool";
import { PagesTool } from "./pages-tool";
import { RenderUiTool } from "./render-ui-tool";
import { SandboxedTools } from "./sandboxed-tools";
import { ScheduleTool } from "./schedule-tool";
import { SignInTool } from "./sign-in-tool";
import { SkillTools } from "./skill-tools";
import { VaultTool } from "./vault-tool";
import { WorkerTool } from "./worker-tool";

/** Registers conversation surfaces and tool result renderers around the authenticated chat. */
export function ConversationToolsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());

  return (
    <>
      {/* Computer tools target the Bot declared by the mounted surface. */}
      <ConversationSessionProvider
        transport={
          capabilities?.mode === "intelligence" ? "legacy" : "commands"
        }
      >
        <ToolRendererProvider>
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
            {/*
          A Bot making / listing / changing / pausing the Bots it created (bot factory). Same deal as
          the handoff beside it: server runs the tool and the approval, here only draws the outcome.
        */}
            <BotFactoryTool />
            <EscalationTool />
            {/* Gallery tools are registered once; their handlers re-read the active Bot to avoid shadowing renderers. */}
            <GalleryTools />
            {/* Browser-authored components use the same component grants as the compiled gallery. */}
            <SandboxedTools />
            {/* Offered only on a Bot holding the skill-creator skill; see skill-tools.tsx. */}
            <SkillTools />
            {children}
          </ActiveBotProvider>
        </ToolRendererProvider>
      </ConversationSessionProvider>
    </>
  );
}
