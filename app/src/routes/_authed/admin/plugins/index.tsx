import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconChevronRight,
  IconDeviceDesktop,
  IconMessageReply,
  IconPlug,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { sendPromptToChat } from "@/components/chat/quick-spotlight";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import { storeMcpToken } from "@/lib/credentials/mutations";
import { pluginSummary, pluginTitle } from "@/lib/plugins/catalogue-zh";
import { addCustomServerMutationOptions } from "@/lib/plugins/mutations";
import {
  type CatalogueItem,
  connectionsQueryOptions,
  type PluginServer,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * What this deployment can reach, as one list per state.
 *
 * This screen used to be three tabs: a catalogue of what could be added, a second tab for what had
 * been, and skills. Answering one question about one vendor — is Drive available, and what can it
 * do — meant visiting two of them, and the third was a different kind of thing altogether. Two
 * lists say the same thing in one read: what is connected, and what else there is.
 *
 * Every row goes to that vendor's own page, because what a connector needs configured is not the
 * same from one vendor to the next. A token, an OAuth client, an instance hostname, and a grant per
 * tool per Bot do not fit on a row, and the previous screen's attempt to fit them made a page that
 * scrolled sideways.
 */
export const Route = createFileRoute("/_authed/admin/plugins/")({
  component: RouteComponent,
});

/**
 * A vendor's own mark where there is one, and a plug where there is not.
 *
 * The fallback covers a server an administrator added by URL, which has no catalogue entry and so no
 * mark of its own — and it would cover a catalogue vendor Tabler ships no brand for. Only Drive is in
 * the catalogue today, and Tabler has it.
 */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

const markFor = (key: string) => MARKS[key] ?? IconPlug;

/**
 * What a connected row says on the right.
 *
 * The current answer rather than the field's name, which is what the layout skill asks of a summary:
 * "4 tools · 2 Bots" tells an administrator where this vendor stands, and "Tools" would not.
 *
 * A vendor reached as the person asking is a special case worth its own words. It can be fully
 * configured — client registered, tools listed — and still answer nothing, because the thing that
 * reads anything is a grant belonging to whoever is asking. "Not connected" is about you, not about
 * the deployment.
 */
function summaryFor(
  server: PluginServer,
  /**
   * The vendor's auth kind, from the catalogue rather than the server record.
   *
   * A server row says what this deployment has stored; whose credential reaches it is a fact about
   * the vendor. Undefined for a server added by URL, which has no catalogue entry and is therefore
   * never reached as a person.
   */
  auth: CatalogueItem["auth"] | undefined,
  youConnected: boolean,
): string {
  if (auth === "user-oauth" && !youConnected) return "未连接";
  if (server.tools.length === 0) return "尚无工具";

  const tools = `${server.tools.length} 个工具`;
  if (server.autoGrantAll) return `${tools} · 全员机器人默认可用`;
  const bots = new Set(server.tools.flatMap((tool) => tool.grantedTo)).size;
  if (bots === 0) return `${tools} · 暂无机器人`;
  return `${tools} · ${bots} 个机器人`;
}

function RouteComponent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [customOpen, setCustomOpen] = React.useState(false);

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  const added = new Set((plugins.data?.servers ?? []).map((s) => s.id));
  const explore = (plugins.data?.catalogue ?? []).filter(
    (entry) => !added.has(entry.key),
  );
  /** Keyed by catalogue key, which is also the server id, so a row can ask how it is reached. */
  const authByKey = new Map(
    (plugins.data?.catalogue ?? []).map((entry) => [entry.key, entry.auth]),
  );

  return (
    <>
      <CustomMcpDialog
        onOpenChange={setCustomOpen}
        open={customOpen}
        queryClient={queryClient}
      />
      <PageShell
        action={
          <Button
            data-testid="add-custom-mcp-btn"
            onClick={() => setCustomOpen(true)}
            size="sm"
          >
            <IconPlus className="size-4" />
            {"添加自定义 MCP"}
          </Button>
        }
        description={
          "机器人能接入的外部服务和 MCP 服务器。添加后对整个部署生效；具体哪些机器人能用，在插件自己的页面里设置。"
        }
        title={"插件"}
      >
      {/* Pending, error, empty, rows — pending first, so no sentence asserts anything mid-fetch. */}
      {plugins.isPending ? <PageSkeleton /> : plugins.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          {"插件无法加载。"}
        </p>
      ) : (
        <>
          <PageSection
            description={
              "已经添加的插件。点开可以填配置、选择哪些机器人能用。"
            }
            settingItem="plugins.custom-mcp"
            title={"已连接"}
          >
            {plugins.data?.servers.length === 0 ? (
              <PageEmpty>{"尚未连接任何内容。所有可用内容如下。"}</PageEmpty>
            ) : (
              <PageRows>
                {plugins.data?.servers.map((server, index) => {
                  const Mark = markFor(server.id);
                  return (
                    <React.Fragment key={server.id}>
                      {/*
                       * A real link with no children. `useRender` merges props, and children passed
                       * here replace the row's own — the media, content and actions all vanish and
                       * the row draws empty. Its accessible name comes from the title inside it.
                       */}
                      <Item
                        data-testid={`plugin-${server.id}`}
                        render={
                          <Link
                            params={{ key: server.id }}
                            to="/admin/plugins/$key"
                          />
                        }
                        size="sm"
                      >
                        <RowMark>
                          <Mark className="size-4" />
                        </RowMark>
                        <ItemContent>
                          <ItemTitle>{pluginTitle(server.id, server.title)}</ItemTitle>
                          {/*
                           * The vendor's last failure takes the description's place when there is
                           * one. A server with no tools and no explanation reads as a server that
                           * offers nothing, which sends somebody looking in the wrong place.
                           */}
                          <ItemDescription
                            className={
                              server.lastError ? "text-destructive" : undefined
                            }
                          >
                            {server.lastError ?? pluginSummary(server.id, server.summary)}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <span className="text-muted-foreground text-xs">
                            {summaryFor(
                              server,
                              authByKey.get(server.id),
                              connected.has(server.id),
                            )}
                          </span>
                          <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </ItemActions>
                      </Item>
                      {index !== (plugins.data?.servers.length ?? 0) - 1 && (
                        <Separator />
                      )}
                    </React.Fragment>
                  );
                })}
              </PageRows>
            )}
          </PageSection>

          <PageSection
            description={"可以直接添加的官方服务。点开即可添加。"}
            title={"探索插件"}
          >
            {explore.length === 0 ? (
              <PageEmpty>{"目录中的所有内容均已连接。"}</PageEmpty>
            ) : (
              <PageRows>
                {explore.map((entry: CatalogueItem, index) => {
                  const Mark = markFor(entry.key);
                  return (
                    <React.Fragment key={entry.key}>
                      <Item
                        data-testid={`plugin-${entry.key}`}
                        render={
                          <Link
                            params={{ key: entry.key }}
                            to="/admin/plugins/$key"
                          />
                        }
                        size="sm"
                      >
                        <RowMark>
                          <Mark className="size-4" />
                        </RowMark>
                        <ItemContent>
                          <ItemTitle>{pluginTitle(entry.key, entry.title)}</ItemTitle>
                          <ItemDescription>{pluginSummary(entry.key, entry.summary)}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <span className="text-muted-foreground text-xs">
                            {"未添加"}
                          </span>
                          <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </ItemActions>
                      </Item>
                      {index !== explore.length - 1 && <Separator />}
                    </React.Fragment>
                  );
                })}
              </PageRows>
            )}
          </PageSection>

          <PageSection
            description={"通过 Composio 接入的更多应用（未逐个审查）。"}
            title={"更多应用"}
          >
            <PageRows>
              {/*
               * The row states the setting rather than hiding the feature. A deployment with no
               * Composio key still says that Composio is a thing this build can do and names the
               * variable that turns it on — a section that simply vanished would leave an
               * administrator with nothing to search for, and nothing to tell them the handful of
               * connectors above is not the whole story.
               */}
              {plugins.data?.composioConfigured ? (
                <Item
                  data-testid="plugin-composio"
                  render={<Link to="/admin/plugins/composio" />}
                  size="sm"
                >
                  <RowMark>
                    <IconPlug className="size-4" />
                  </RowMark>
                  <ItemContent>
                    <ItemTitle>{"浏览 Composio"}</ItemTitle>
                    <ItemDescription>
                      {"几百个应用，由询问者访问。每人连接自己的账号。"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              ) : (
                /* No chevron and no link: the row goes nowhere, because there is nowhere to go
                   until the key is set. */
                <Item data-testid="plugin-composio" size="sm">
                  <RowMark>
                    <IconPlug className="size-4" />
                  </RowMark>
                  <ItemContent>
                    <ItemTitle>{"Composio"}</ItemTitle>
                    <ItemDescription>
                      {
                        "填入 Composio 密钥后才能浏览它的工具目录。"
                      }
                    </ItemDescription>
                  </ItemContent>
                </Item>
              )}
            </PageRows>
          </PageSection>

          <PageSection
            description={"无需暴露公网 HTTP 端口，直接通过已配对的 PC 客户端在本地电脑上拉起 npx / uvx stdio MCP 工具。"}
            settingItem="plugins.local-stdio-mcp"
            title={"本地电脑 stdio MCP 桥接"}
          >
            <PageRows>
              <Item data-testid="plugin-local-stdio-mcp" size="sm">
                <RowMark>
                  <IconDeviceDesktop className="size-4" />
                </RowMark>
                <ItemContent>
                  <ItemTitle>{"device_mcp_call · 本地电脑 MCP 直连"}</ItemTitle>
                  <ItemDescription>
                    {"配对电脑客户端后，机器人可直接调用本地文件系统（@modelcontextprotocol/server-filesystem）、本地浏览器（@playwright/mcp）或任意自定义 stdio MCP。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="shrink-0">
                  <Button
                    data-testid="try-local-stdio-mcp-btn"
                    onClick={() =>
                      sendPromptToChat(
                        navigate,
                        "请使用 device_mcp_call 列出我本地电脑 MCP 服务器提供的工具（例如 npx -y @modelcontextprotocol/server-filesystem）",
                        "本地 stdio MCP 桥接",
                      )
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <IconMessageReply className="size-3.5" />
                    {"去对话调用"}
                  </Button>
                </ItemActions>
              </Item>
            </PageRows>
          </PageSection>
        </>
      )}
    </PageShell>
    </>
  );
}

function CustomMcpDialog({
  open,
  onOpenChange,
  queryClient,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [id, setId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const addCustom = useMutation({
    ...addCustomServerMutationOptions(queryClient),
    onSuccess: () => {
      toast.success(`已添加自定义 MCP 服务器「${title.trim() || id.trim()}」`);
      onOpenChange(false);
      setId("");
      setTitle("");
      setUrl("");
      setToken("");
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanId = id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const cleanTitle = title.trim() || cleanId;
    const cleanUrl = url.trim();
    if (!cleanId || !cleanUrl) {
      setError("请填写唯一标识（ID）和 MCP 服务器 HTTPS 地址。");
      return;
    }
    try {
      const credentialId = await storeMcpToken(cleanId, token);
      addCustom.mutate({
        id: cleanId,
        title: cleanTitle,
        url: cleanUrl,
        ...(credentialId ? { credentialId } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存令牌失败");
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg" data-testid="custom-mcp-dialog">
        <DialogHeader>
          <DialogTitle>{"添加自定义 HTTP MCP 服务器"}</DialogTitle>
          <DialogDescription>
            {"填入遵循 Model Context Protocol (Streamable HTTP) 的远程服务器地址。如果是本地 npx / uvx 命令行 MCP，无需在此添加，直接在对话中让机器人调用 device_mcp_call 即可。"}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col" onSubmit={(e) => void handleSubmit(e)}>
          <DialogBody className="im-form mt-2">
            {error ? (
              <p className="text-destructive text-xs" role="alert">
                {error}
              </p>
            ) : null}
            <label className="im-field" htmlFor="custom-mcp-title">
              <span className="im-field-l">{"显示名称"}</span>
              <Input
                id="custom-mcp-title"
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (!id) {
                    setId(
                      e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-_]/g, "-")
                        .replace(/-+/g, "-")
                        .replace(/^-|-$/g, ""),
                    );
                  }
                }}
                placeholder="例如：内部知识库 MCP / Jira MCP"
                value={title}
              />
            </label>
            <label className="im-field" htmlFor="custom-mcp-id">
              <span className="im-field-l">
                {"唯一标识（ID）"}
                <span className="im-req">{"英文小写字母、数字与连字符"}</span>
              </span>
              <Input
                id="custom-mcp-id"
                onChange={(e) => setId(e.target.value)}
                placeholder="例如：company-kb"
                value={id}
              />
            </label>
            <label className="im-field" htmlFor="custom-mcp-url">
              <span className="im-field-l">{"MCP Endpoint URL (HTTPS)"}</span>
              <Input
                id="custom-mcp-url"
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                value={url}
              />
            </label>
            <label className="im-field" htmlFor="custom-mcp-token">
              <span className="im-field-l">
                {"Bearer 令牌"}
                <span className="im-req">{"可选，加密存入密钥保险箱"}</span>
              </span>
              <Input
                id="custom-mcp-token"
                onChange={(e) => setToken(e.target.value)}
                placeholder="sk-..."
                type="password"
                value={token}
              />
            </label>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              data-testid="submit-custom-mcp-btn"
              disabled={addCustom.isPending || !id.trim() || !url.trim()}
              type="submit"
            >
              {addCustom.isPending ? "连接并读取工具…" : "添加服务器"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
