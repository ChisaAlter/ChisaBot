import { useQuery } from "@tanstack/react-query";
import {
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useMemo,
  useState,
} from "react";
import { useExternalConnection, useIdleTask } from "@/hooks";
import { ToolRendererProvider, useRenderTool } from "@/lib/chat/renderers";
import { ConversationSessionProvider } from "@/lib/chat/session-client";
import { objectConnectionKey } from "@/lib/connection-key";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { ActiveBotProvider } from "./active-bot";
import { ChatFileTools } from "./chat-file-tools";
import { ComputerTools } from "./computer-tools";
import { GalleryTools } from "./gallery-tools";
import { LocalAgentTool } from "./local-agent-tool";
import { SandboxedTools } from "./sandboxed-tools";
import { SkillTools } from "./skill-tools";
import { WorkerTool } from "./worker-tool";

/*
 * 重型 / 低频工具卡片渲染体按需 React.lazy：
 * 聊天首屏仅同步注册轻量工具名占位元数据，避免把 json-render/catalog、personal-sources、
 * github-connection、bot-factory、vault、pages、schedule、sign-in 等代码拖入首屏预载。
 * 消息流实际出现对应工具调用时立即激活加载并由 RenderRegistry 无缝切到真实渲染器。
 */
const LazyRenderUiTool = lazy(() =>
  import("./render-ui-tool").then((m) => ({ default: m.RenderUiTool })),
);
const LazyPersonalSourcesTool = lazy(() =>
  import("./personal-sources-tool").then((m) => ({
    default: m.PersonalSourcesTool,
  })),
);
const LazyGithubTool = lazy(() =>
  import("./github-tool").then((m) => ({ default: m.GithubTool })),
);
const LazyVaultTool = lazy(() =>
  import("./vault-tool").then((m) => ({ default: m.VaultTool })),
);
const LazyPagesTool = lazy(() =>
  import("./pages-tool").then((m) => ({ default: m.PagesTool })),
);
const LazyScheduleTool = lazy(() =>
  import("./schedule-tool").then((m) => ({ default: m.ScheduleTool })),
);
const LazyBotFactoryTool = lazy(() =>
  import("./bot-factory-tool").then((m) => ({ default: m.BotFactoryTool })),
);
const LazyHandoffTool = lazy(() =>
  import("./handoff-tool").then((m) => ({ default: m.HandoffTool })),
);
const LazyEscalationTool = lazy(() =>
  import("./escalation-tool").then((m) => ({ default: m.EscalationTool })),
);
const LazySignInTool = lazy(() =>
  import("./sign-in-tool").then((m) => ({ default: m.SignInTool })),
);

type LazyToolGroupId =
  | "render-ui"
  | "personal-sources"
  | "github"
  | "vault"
  | "pages"
  | "schedule"
  | "bot-factory"
  | "handoff"
  | "escalation"
  | "sign-in";

const LAZY_TOOL_NAMES: Record<LazyToolGroupId, readonly string[]> = {
  "render-ui": ["render_ui"],
  "personal-sources": [
    "calendar_connect",
    "email_connect",
    "notify_webhook_connect",
  ],
  github: [
    "github_create_issue",
    "github_comment",
    "github_create_pr",
    "github_connect",
  ],
  vault: ["vault_request_secret"],
  pages: ["page_create", "page_update", "page_publish"],
  schedule: ["schedule_create"],
  "bot-factory": [
    "create_bot",
    "list_managed_bots",
    "update_bot",
    "disable_bot",
  ],
  handoff: ["message_bot"],
  escalation: ["ask_person"],
  "sign-in": ["computer_request_sign_in"],
};

function LazyToolTrigger({ onActivate }: { onActivate: () => void }) {
  useExternalConnection(objectConnectionKey(onActivate), () => {
    onActivate();
  });
  return null;
}

const LazyToolNameStub = memo(function LazyToolNameStub({
  name,
  onActivate,
}: {
  name: string;
  onActivate: () => void;
}) {
  const render = useCallback(
    () => <LazyToolTrigger onActivate={onActivate} />,
    [onActivate],
  );
  useRenderTool({
    name,
    placeholder: true,
    render,
  });
  return null;
});

function LazyToolGroupStubs({
  group,
  onActivate,
}: {
  group: LazyToolGroupId;
  onActivate: (group: LazyToolGroupId) => void;
}) {
  const activate = useCallback(() => onActivate(group), [group, onActivate]);
  return (
    <>
      {LAZY_TOOL_NAMES[group].map((name) => (
        <LazyToolNameStub key={name} name={name} onActivate={activate} />
      ))}
    </>
  );
}

/** 首屏画完且浏览器空闲后汇报页面 origin（供服务器拼出页面完整链接），避免同步拉入 pages 模块。 */
function ReportPageOriginWhenIdle() {
  const [done, setDone] = useState(false);
  useIdleTask(
    () => {
      setDone(true);
      void import("@/lib/pages")
        .then((m) => m.reportPageOrigin())
        .catch(() => {});
    },
    !done,
    3000,
  );
  return null;
}

/** Registers conversation surfaces and tool result renderers around the authenticated chat. */
export const ConversationToolsProvider = memo(
  function ConversationToolsProvider({ children }: { children: ReactNode }) {
    const { data: capabilities } = useQuery(
      deploymentCapabilitiesQueryOptions(),
    );
    const [activated, setActivated] = useState<ReadonlySet<LazyToolGroupId>>(
      () => new Set(),
    );
    const activateGroup = useCallback((group: LazyToolGroupId) => {
      setActivated((current) => {
        if (current.has(group)) return current;
        const next = new Set(current);
        next.add(group);
        return next;
      });
    }, []);

    const activeGroups = useMemo(() => activated, [activated]);
    const generativeUi = Boolean(capabilities?.generativeUi);

    return (
      /* Computer tools target the Bot declared by the mounted surface. */
      <ConversationSessionProvider>
        <ToolRendererProvider>
          <ActiveBotProvider>
            <ReportPageOriginWhenIdle />
            <ComputerTools />
            {/* 后台任务卡片（DESIGN.md §38.2）：`delegate_task` 在服务器上执行，这里只画。 */}
            <WorkerTool />
            {/* 本地 agent 任务卡片（docs/local-agents.md）：`device_agent_run` 在服务器上执行，这里只画。 */}
            <LocalAgentTool />
            {/* 图片生成 / 修改的结果、机器人交给用户的文件卡（DESIGN.md §56）：工具在服务器上执行，这里只画。 */}
            <ChatFileTools />
            {/* 轻量工具名注册占位：消息真正命中该工具时再加载对应重型渲染模块。 */}
            {generativeUi ? (
              <LazyToolGroupStubs
                group="render-ui"
                onActivate={activateGroup}
              />
            ) : null}
            <LazyToolGroupStubs group="sign-in" onActivate={activateGroup} />
            <LazyToolGroupStubs group="vault" onActivate={activateGroup} />
            <LazyToolGroupStubs group="github" onActivate={activateGroup} />
            <LazyToolGroupStubs
              group="personal-sources"
              onActivate={activateGroup}
            />
            <LazyToolGroupStubs group="pages" onActivate={activateGroup} />
            <LazyToolGroupStubs group="schedule" onActivate={activateGroup} />
            <LazyToolGroupStubs group="handoff" onActivate={activateGroup} />
            <LazyToolGroupStubs
              group="bot-factory"
              onActivate={activateGroup}
            />
            <LazyToolGroupStubs group="escalation" onActivate={activateGroup} />
            <Suspense fallback={null}>
              {generativeUi && activeGroups.has("render-ui") ? (
                <LazyRenderUiTool />
              ) : null}
              {activeGroups.has("sign-in") ? <LazySignInTool /> : null}
              {activeGroups.has("vault") ? <LazyVaultTool /> : null}
              {activeGroups.has("github") ? <LazyGithubTool /> : null}
              {activeGroups.has("personal-sources") ? (
                <LazyPersonalSourcesTool />
              ) : null}
              {activeGroups.has("pages") ? <LazyPagesTool /> : null}
              {activeGroups.has("schedule") ? <LazyScheduleTool /> : null}
              {activeGroups.has("handoff") ? <LazyHandoffTool /> : null}
              {activeGroups.has("bot-factory") ? <LazyBotFactoryTool /> : null}
              {activeGroups.has("escalation") ? <LazyEscalationTool /> : null}
            </Suspense>
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
    );
  },
);
