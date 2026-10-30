import {
  IconAdjustments,
  IconPencil,
  IconPlugConnected,
  IconPuzzle,
  IconUser,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { DeleteBotDialog } from "@/components/agents/delete-bot-dialog";
import { IdentityCard } from "@/components/bot-profile/profile";
import { BotModelSelector } from "@/components/agents/bot-model-selector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  duplicateAgentMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPinnedMutationOptions,
} from "@/lib/agents/mutations";
import { useOpenBotChat } from "@/lib/channels/open-bot-chat";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { readToolName } from "@/lib/plugins/tool-name";

/**
 * A coworker, in a dialog with its own sidebar.
 *
 * The agents screen used to slide this in as a side panel; a profile carries enough distinct
 * concerns — who it is, where it runs, what it may hand work to, and what can be done to it — that
 * a single scrolling column buried the later ones. Each concern is a section here, and the sidebar
 * is the map.
 */
export function AgentDialog({
  agentId,
  open,
  onClose,
}: {
  /** Which coworker to show. Null renders nothing but keeps the dialog mounted for its exit. */
  agentId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      {/* p-0/overflow-hidden hands the popup's rounding to the sidebar; wider than the default
          dialog because it holds a two-pane layout, which is the stated reason to deviate. */}
      {/* Tall enough that General's rows and its Delete sit on screen together; the popup's own
          max-h-[85svh] still caps it on a short display, where the main pane scrolls. */}
      <DialogContent className="overflow-hidden p-0 md:max-h-[680px] md:max-w-[700px] lg:max-w-[800px]">
        {/* Keyed by coworker so the section and edit state never carry over from another one. */}
        {agentId ? <AgentDialogBody agentId={agentId} key={agentId} /> : null}
      </DialogContent>
    </Dialog>
  );
}

const SECTIONS = [
  { id: "general", name: "通用", icon: IconUser },
  { id: "access", name: "权限", icon: IconPuzzle },
  { id: "connection", name: "连接", icon: IconPlugConnected },
  { id: "manage", name: "管理", icon: IconAdjustments },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function AgentDialogBody({ agentId }: { agentId: string }) {
  const [section, setSection] = useState<SectionId>("general");
  const agent = useQuery(agentQueryOptions(agentId));

  if (agent.isPending) {
    return (
      <div className="flex h-[640px] max-h-[80svh] flex-col gap-4 p-6">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (agent.error || !agent.data) {
    return (
      <p className="p-6 text-sm text-destructive" role="alert">
        {"无法加载这个机器人。"}
      </p>
    );
  }
  const profile = agent.data;
  const active = SECTIONS.find((candidate) => candidate.id === section);

  return (
    <>
      <DialogTitle className="sr-only">{profile.name}</DialogTitle>
      {/* min-h-full overrides the provider's own min-h-svh, which is sized for a page. */}
      <SidebarProvider className="min-h-full items-start">
        <Sidebar className="hidden md:flex" collapsible="none">
          {/* Who this dialog is about, said once here rather than repeated per section. */}
          <SidebarHeader className="flex-row items-center gap-3 p-4">
            <AbstractAvatar agentId={profile.id}
              name={profile.name}
              seed={profile.avatarSeed}
              size={36}
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">
                {profile.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {profile.title}
              </span>
            </div>
          </SidebarHeader>
          <SidebarContent className="mt-2">
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu className="gap-px">
                  {SECTIONS.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={item.id === section}
                        onClick={() => setSection(item.id)}
                      >
                        <item.icon />
                        <span>{item.name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <main className="flex h-[640px] max-h-[80svh] flex-1 flex-col overflow-hidden">
          {/*
           * The sidebar hides below md, and without this strip that left the sections unreachable
           * on a phone: the dialog opened on General and nothing could leave it. A scrollable row
           * of the same sections, shown only where the sidebar is not. The identity the sidebar
           * header carries rides along, with room kept for the popup's close button.
           */}
          <div className="flex shrink-0 flex-col gap-2 border-b border-border p-3 pr-12 md:hidden">
            <div className="flex items-center gap-2">
              <AbstractAvatar agentId={profile.id}
                name={profile.name}
                seed={profile.avatarSeed}
                size={28}
              />
              <span className="truncate text-sm font-medium">
                {profile.name}
              </span>
            </div>
            <div className="flex gap-1 overflow-x-auto">
              {SECTIONS.map((item) => (
                <Button
                  className="shrink-0"
                  key={item.id}
                  onClick={() => setSection(item.id)}
                  size="sm"
                  variant={item.id === section ? "secondary" : "ghost"}
                >
                  <item.icon />
                  {item.name}
                </Button>
              ))}
            </div>
          </div>
          <header className="flex h-14 shrink-0 items-center gap-2 px-6">
            <h2 className="text-sm font-medium">{active?.name}</h2>
          </header>
          <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
            {section === "general" ? (
              <GeneralSection agentId={agentId} profile={profile} />
            ) : section === "access" ? (
              <AccessSection agentId={agentId} />
            ) : section === "connection" ? (
              <ConnectionSection agentId={agentId} profile={profile} />
            ) : (
              <ManageSection agentId={agentId} profile={profile} />
            )}
          </div>
        </main>
      </SidebarProvider>
    </>
  );
}

function GeneralSection({
  agentId,
  profile,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  const openBotChat = useOpenBotChat();
  const [editingIdentity, setEditingIdentity] = useState(false);
  const identityFieldRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      {/* Each stands on its own — muted, not bg-card, which is invisible against a popup — and
          each edits in place: the field somebody wants to change is the only one that opens. */}
      <div className="flex flex-col gap-2">
        {/* 和新建、资料页同一张表（头像 · 名称 · 职责 · 它做什么，DESIGN.md §81）；以前这里叫「标题」「角色」，一格一格改。 */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{"资料"}</span>
          {profile.canManage && !editingIdentity ? (
            <Button onClick={() => setEditingIdentity(true)} size="xs" variant="ghost">
              {"编辑"}
            </Button>
          ) : null}
        </div>
        <IdentityCard
          agent={profile}
          editing={editingIdentity}
          firstFieldRef={identityFieldRef}
          key={`${profile.name}\u0000${profile.title}\u0000${profile.roleDescription}`}
          setEditing={setEditingIdentity}
        />
        <Item variant="muted"><ItemContent><ItemTitle>模型设置</ItemTitle><BotModelSelector agentId={agentId} /></ItemContent></Item>
        {profile.systemOwned ? (
          <Item variant="muted">
            <ItemContent>
              <ItemTitle>{"系统拥有"}</ItemTitle>
              <ItemDescription>
                {"此部署随附，而不是属于某人。"}
              </ItemDescription>
            </ItemContent>
          </Item>
        ) : null}
      </div>

      <Item variant="muted">
        <ItemContent>
          <ItemTitle>{"和它聊天"}</ItemTitle>
          <ItemDescription>{"打开和这个机器人的对话。"}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            onClick={() =>
              void openBotChat(agentId)
            }
            size="sm"
          >
            {"去聊天"}
          </Button>
        </ItemActions>
      </Item>
    </>
  );
}

/** "google-drive" as "Google Drive": the connector key, said the way a person would. */
function connectorName(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * What this coworker may reach when it works: its granted connectors, one row each, and its skills.
 *
 * Read from the same snapshot the runtime offers the Bot, so this shows what a run would actually
 * hold rather than a second opinion. Read-only on purpose — granting is an administrator's, made on
 * the Plugins screens, and a row of switches here would be a second place for the same decision.
 */
function AccessSection({ agentId }: { agentId: string }) {
  const plugins = useQuery(agentPluginsQueryOptions(agentId));

  if (plugins.isPending) return null;
  if (plugins.error || !plugins.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {"这个机器人可以访问的内容无法加载。"}
      </p>
    );
  }

  /* One row per connector, carrying what a person recognises: the tools' names, not their count. */
  const connectors = new Map<string, string[]>();
  for (const tool of plugins.data.tools) {
    const key = tool.ref.split("/")[0] ?? tool.ref;
    let label = readToolName(tool.toolName).label;
    /*
     * Vendors prefix every tool with their own name — "Notion create pages" — which next to a row
     * already titled Notion reads as a stutter. Stripped only as a leading word, and re-cased, so
     * "Notion search" becomes "Search" while "Search notion pages" is left alone.
     */
    const prefix = `${key.toLowerCase()} `;
    if (label.toLowerCase().startsWith(prefix)) {
      const rest = label.slice(prefix.length);
      label = rest ? rest[0]?.toUpperCase() + rest.slice(1) : label;
    }
    const labels = connectors.get(key) ?? [];
    labels.push(label);
    connectors.set(key, labels);
  }
  const skills = plugins.data.skills;

  if (connectors.size === 0 && skills.length === 0) {
    return (
      <Empty className="h-[180px] border border-dashed">
        <EmptyHeader>
          <EmptyTitle className="text-muted-foreground">
            {"尚未授权"}
          </EmptyTitle>
          <EmptyDescription>
            {
              "管理员从插件屏幕授予连接器和技能。在此之前，这个机器人只能对话。"
            }
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {
          "这个机器人在工作时可以访问的内容。由管理员在插件页面授予；未列出的任何内容在调用时被拒绝。"
        }
      </p>
      <div className="flex flex-col gap-2">
        {[...connectors.entries()].map(([key, labels]) => (
          <Item key={key} variant="muted">
            <ItemContent>
              <ItemTitle>{connectorName(key)}</ItemTitle>
              <ItemDescription>
                {labels.slice(0, 4).join(", ")}
                {labels.length > 4 ? `以及 ${labels.length - 4} 更多` : ""}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-sm text-muted-foreground tabular-nums">
                {labels.length} {labels.length === 1 ? "工具" : "工具"}
              </span>
            </ItemActions>
          </Item>
        ))}
        {skills.map((skill) => (
          <Item key={skill.slug} variant="muted">
            <ItemContent>
              <ItemTitle>{skill.title}</ItemTitle>
              <ItemDescription>{skill.summary}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-sm text-muted-foreground">{"技能"}</span>
            </ItemActions>
          </Item>
        ))}
      </div>
    </>
  );
}

function ConnectionSection({
  profile,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  /*
   * A built-in coworker is done the moment it exists: it runs on the deployment's own Bot, whose
   * process already holds the deployment's tool credential, so its tool calls authenticate with no
   * setup. Showing it the endpoint and the callback-token panel told the person the opposite —
   * an internal address they never typed, and a credential they were never supposed to need.
   */
  if (!profile.endpoint || profile.builtIn) {
    return (
      <p className="text-sm text-muted-foreground">
        {
          "在此部署的自身机器人上运行。无需连接和认证：其工具调用由部署自身的凭证覆盖。"
        }
      </p>
    );
  }
  return (
    <>
      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {"端点"}
        </h2>
        <p className="break-all font-mono text-sm">{profile.endpoint}</p>
      </section>
    </>
  );
}

function ManageSection({
  agentId,
  profile,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const setPinned = useMutation(setAgentPinnedMutationOptions(queryClient));
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicateAgent = useMutation(
    duplicateAgentMutationOptions(queryClient),
  );
  const actionError =
    setPinned.error ?? setHidden.error ?? duplicateAgent.error;

  return (
    <>
      {/* The same gap the General items keep, so the two screens read as one list style. */}
      <div className="flex flex-col gap-2">
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>{profile.pinned ? "已固定" : "固定"}</ItemTitle>
            <ItemDescription>
              {profile.pinned
                ? "在你的代理列表顶部。这对其他人没有任何影响。"
                : "将其保持在您的代理列表顶部。这对其他人没有任何改变。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={setPinned.isPending}
              onClick={() =>
                setPinned.mutate({ agentId, pinned: !profile.pinned })
              }
              size="sm"
              variant="outline"
            >
              {setPinned.isPending
                ? profile.pinned
                  ? "取消固定中…"
                  : "正在固定…"
                : profile.pinned
                  ? "取消固定"
                  : "固定"}
            </Button>
          </ItemActions>
        </Item>

        <Item variant="muted">
          <ItemContent>
            <ItemTitle>{profile.hidden ? "隐藏" : "隐藏"}</ItemTitle>
            <ItemDescription>
              {profile.hidden
                ? "从你的代理列表隐藏。这对其他人无影响"
                : "将其从您的代理列表中移除。这对其他人没有任何影响。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={setHidden.isPending}
              onClick={async () => {
                await setHidden.mutateAsync({
                  agentId,
                  hidden: !profile.hidden,
                });
                if (!profile.hidden)
                  await navigate({ search: {}, to: "/agents" });
              }}
              size="sm"
              variant="outline"
            >
              {setHidden.isPending
                ? profile.hidden
                  ? "取消隐藏中…"
                  : "正在隐藏…"
                : profile.hidden
                  ? "取消隐藏"
                  : "隐藏"}
            </Button>
          </ItemActions>
        </Item>

        <Item variant="muted">
          <ItemContent>
            <ItemTitle>{"复制"}</ItemTitle>
            <ItemDescription>
              {"你自己的副本，没有密钥也没有通道。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button mutation={duplicateAgent}
              feedback="copy"
              onClick={async () => {
                const copy = await duplicateAgent.mutateAsync(agentId);
                await navigate({ search: { agent: copy.id }, to: "/agents" });
              }}
              size="sm"
              variant="outline"
            >
              {"复制"}
            </Button>
          </ItemActions>
        </Item>

        {(profile.canDelete ?? profile.canManage) ? (
          <Item variant="muted">
            <ItemContent>
              <ItemTitle>{"删除机器人"}</ItemTitle>
              <ItemDescription>
                {"彻底删除它，以及你与它的私人会话、记忆、定时任务和面板。此操作无法撤消。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                onClick={() => setConfirmingDelete(true)}
                size="sm"
                variant="destructive"
              >
                {"删除"}
              </Button>
            </ItemActions>
          </Item>
        ) : null}
      </div>

      {actionError ? (
        <p className="text-sm text-destructive" role="alert">
          {actionError.message}
        </p>
      ) : null}

      {/* Stacked over the agent dialog: destroying something deserves its own moment, and the
          question keeps the name in it so the wrong tab cannot delete the wrong coworker. */}
      <DeleteBotDialog
        bot={{ id: agentId, name: profile.name }}
        onOpenChange={setConfirmingDelete}
        open={confirmingDelete}
      />
    </>
  );
}
