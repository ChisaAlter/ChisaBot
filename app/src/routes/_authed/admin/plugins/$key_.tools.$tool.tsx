import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { grantRoster } from "@/lib/agents/grant-roster";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * One tool, and which Bots hold it.
 *
 * Its own screen because a grant is a per-Bot decision and there is no upper bound on Bots. The
 * connector page used to draw a chip for every Bot inside every tool row: at three Bots and eight
 * tools that is twenty-four controls stacked in a list, wrapping onto second and third lines, where
 * the thing being decided — does THIS Bot get THIS tool — was the least legible part of it. Here each
 * Bot is one row with one switch, which is the same decision with nothing competing for it.
 *
 * `$key_` opts this route out of nesting under `$key.tsx`, so the connector page stays a page rather
 * than becoming a layout with an outlet.
 */
export const Route = createFileRoute(
  "/_authed/admin/plugins/$key_/tools/$tool",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { key, tool: toolName } = useParams({
    from: "/_authed/admin/plugins/$key_/tools/$tool",
  });
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a grant one of them holds still has its switch here. */
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));
  /*
   * Whether a call from this Bot could be authenticated at all.
   *
   * Its own issued credential, or the deployment's shared one. Separate from the grant: the switch
   * decides whether the tool is offered to the model, this decides whether the call it makes gets
   * past the front door. A Bot with the grant and neither credential produced "May call this tool"
   * beside a tool that refused every call, with no audit row, because the call never arrived.
   */
  const sharedCallback = plugins.data?.botsMayCallBack === true;
  const canCallBack = (bot: { id: string }) =>
    sharedCallback ||
    [...(agents ?? []), ...(hiddenAgents ?? [])].find(
      (one) => one.id === bot.id,
    )?.hasCallbackToken === true;
  const [error, setError] = useState<string | null>(null);

  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });

  const server = plugins.data?.servers.find((row) => row.id === key);
  const tool = server?.tools.find((row) => row.name === toolName);

  const back = {
    label: server?.title ?? "插件",
    linkProps: {
      params: { key },
      to: "/admin/plugins/$key" as const,
    },
  };

  /* Nothing rather than a placeholder, so no sentence asserts anything while the fetch is open. */
  if (plugins.isPending) {
    return <PageShell title={"工具"}>{null}</PageShell>;
  }

  /*
   * A plugin list that could not be read is said as that, not as a connector that is not enabled:
   * `isPending` goes false on a failed fetch too, and the sentence below is a claim about this
   * deployment that a request that never came back is no evidence for. The per-Bot grant screen
   * keeps the same guard.
   */
  if (!plugins.data) {
    return (
      <PageShell backButton={back} title={toolName}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          {"插件无法加载。"}
        </p>
      </PageShell>
    );
  }

  if (!tool) {
    return (
      <PageShell
        backButton={back}
        description={"此连接器未以该名称公布工具。"}
        title={toolName}
      >
        {/*
         * Says which of the two it is. A tool disappears from this list when the vendor stops
         * offering it, and that reads very differently from a mistyped address.
         */}
        <PageEmpty>
          {server
            ? "它可能在此工具列表上次刷新后已被撤回。"
            : "此部署未启用该连接器。"}
        </PageEmpty>
      </PageShell>
    );
  }

  /*
   * Everybody on the roster, and anybody hidden from it who holds this tool: see `grantRoster`.
   * Named from the roster rows themselves, because the id-to-name lookup other admin screens use is
   * built from the visible roster alone.
   */
  const bots = grantRoster({
    roster: agents ?? [],
    hidden: hiddenAgents ?? [],
    holders: tool.grantedTo,
  }).map((agent) => ({
    id: agent.id,
    name: agent.name,
    hidden: agent.hidden,
  }));

  return (
    <PageShell
      backButton={back}
      description={tool.description || "此工具没有描述。"}
      title={toolName}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        description={
          tool.effect === "write"
            ? "此工具在供应商处更改某些内容。关于写入的权限规则适用于它，当匹配时被拒绝。"
            : "此工具仅读取。关于写入的权限规则不适用于它。"
        }
        title={"它做什么"}
      >
        <PageRows>
          {/*
           * Read-only, and the layout skill's third row kind is right here: there is one of it, it is
           * the fact the section exists to state, and nothing about it is switchable. The effect
           * comes from the vendor's own classification, not from the tool's name.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{"效果"}</ItemTitle>
              <ItemDescription>
                {"由连接器决定，而非工具名称。任何未识别的内容都算作写入。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span
                className={
                  tool.effect === "write"
                    ? "text-amber-600 text-xs dark:text-amber-500"
                    : "text-muted-foreground text-xs"
                }
              >
                {tool.effect === "write" ? "更改事物" : "读取"}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description={
          "机器人仅在其开关打开时可以调用此工具。关闭一个在下一次调用时生效，没有中间缓存。"
        }
        title={"机器人"}
      >
        {bots.length === 0 ? (
          <PageEmpty>
            {"此部署还没有机器人，因此没有人可以授予此操作。"}
          </PageEmpty>
        ) : (
          <PageRows>
            {bots.map((bot, index) => {
              const held = tool.grantedTo.includes(bot.id);
              return (
                <div key={bot.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{bot.name}</ItemTitle>
                      <ItemDescription>
                        {bot.hidden ? "从你的名册隐藏" : ""}
                        {held
                          ? canCallBack(bot)
                            ? "可以调用此工具。每次调用仍需检查权限规则并记录到审计。"
                            : "已授权，但此机器人没有调用工具的凭据，因此每次调用在到达权限规则前被拒绝。在其单独页面上申请一个，或为部署设置 AGENT_TOOL_TOKEN。"
                          : "无法调用此工具。它根本不提供给模型，所以没有拒绝选项。"}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Binary and immediate, which is what a Switch is for: it takes effect when
                       * switched and there is no save. Disabled only while its own write is in
                       * flight, so switching one Bot does not freeze the rest of the list.
                       */}
                      <Switch
                        aria-label={`让 ${bot.name} 调用 ${toolName}`}
                        checked={held}
                        disabled={
                          setGrant.isPending &&
                          setGrant.variables?.agentId === bot.id
                        }
                        onCheckedChange={(next) => {
                          setError(null);
                          setGrant.mutate({
                            agentId: bot.id,
                            granted: next,
                            kind: "mcp",
                            ref: tool.ref,
                          });
                        }}
                      />
                    </ItemActions>
                  </Item>
                  {index !== bots.length - 1 && <Separator />}
                </div>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
