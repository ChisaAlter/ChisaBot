import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconCheck,
  IconChevronRight,
  IconPlug,
  IconPuzzle,
  IconSearch,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import {
  PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { GithubConnectionSection } from "@/components/settings/github-connection";
import { PersonalSourcesSection } from "@/components/settings/personal-sources";
import { SavedLoginsSection } from "@/components/settings/saved-logins";
import { VaultSection } from "@/routes/_authed/settings/vault";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { pluginSummary, pluginTitle } from "@/lib/plugins/catalogue-zh";
import { useSegmentedKeys } from "@/components/ui/segmented";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  connectionsQueryOptions,
  type PluginServer,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * The services a Bot reads as you.
 *
 * Yours, not the deployment's. An administrator decides which vendors this deployment may reach at
 * all; this is the other half of that decision, and it is one nobody can make for you — there is no
 * endpoint for an administrator to connect an account on somebody's behalf. A Bot calling one of
 * these runs on your own grant, so it sees exactly what you can see and nothing else.
 */
export type ConnectedAccountsTab = "all" | "connections" | "logins" | "api-keys";

export const CONNECTED_ACCOUNTS_TABS: readonly { id: ConnectedAccountsTab; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "connections", label: "连接" },
  { id: "logins", label: "登录信息" },
  { id: "api-keys", label: "密钥" },
];

export function normalizeConnectedAccountsTab(raw: unknown): ConnectedAccountsTab {
  if (raw === "connections" || raw === "logins" || raw === "api-keys") return raw;
  return "all";
}

export const Route = createFileRoute("/_authed/settings/connected-accounts/")({
  component: RouteComponent,
  /*
   * `?connected=` is how the OAuth callback reports back, carrying a server key on success and
   * `failed` otherwise. `?tab=` (CB-095) remembers which filter tab is active (`all` | `connections` | `logins` | `api-keys`).
   *
   * Keys are omitted rather than set to undefined so `search` is never a required prop on Links to this route.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { connected?: string; tab?: ConnectedAccountsTab } => {
    const out: { connected?: string; tab?: ConnectedAccountsTab } = {};
    if (typeof search.connected === "string") out.connected = search.connected;
    if (
      search.tab === "all" ||
      search.tab === "connections" ||
      search.tab === "logins" ||
      search.tab === "api-keys"
    ) {
      out.tab = search.tab;
    }
    return out;
  },
});

/** The same marks the admin connector list uses: these are the same vendors seen from your side. */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

const markFor = (key: string) => MARKS[key] ?? IconPlug;

/**
 * The brokered apps this page lists, which is not every brokered row.
 *
 * Exported as a function rather than left inline in the render, for the reason `matchingApps` on the
 * Composio picker is: the rule is the thing worth pinning and pinning it needs no DOM, no router and
 * no query client. See its one clause below.
 */
export function brokeredAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      server.provenance === "composio" && server.authScheme !== "NO_AUTH",
  );
}

function RouteComponent() {
  const { connected: outcome, tab: searchTab } = Route.useSearch();
  const navigate = useNavigate();
  const activeTab = normalizeConnectedAccountsTab(searchTab);
  const tabValues = React.useMemo(
    () => CONNECTED_ACCOUNTS_TABS.map((t) => t.id),
    [],
  );
  const setTab = React.useCallback(
    (next: ConnectedAccountsTab) => {
      void navigate({
        to: "/settings/connected-accounts",
        search: {
          connected: outcome,
          tab: next === "all" ? undefined : next,
        },
        replace: true,
      });
    },
    [navigate, outcome],
  );
  const segKeys = useSegmentedKeys<ConnectedAccountsTab>({
    value: activeTab,
    values: tabValues,
    onChange: setTab,
  });
  const showConnections = activeTab === "all" || activeTab === "connections";
  const showLogins = activeTab === "all" || activeTab === "logins";
  const showApiKeys = activeTab === "all" || activeTab === "api-keys";
  const [search, setSearch] = React.useState("");
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  const added = new Set((plugins.data?.servers ?? []).map((s) => s.id));

  /*
   * Only vendors reached as a person, and only ones an administrator has enabled.
   *
   * A vendor with a shared token has nothing for you to decide: it answers the same for everybody,
   * so listing it here would offer a choice you do not have. And a vendor nobody has enabled cannot
   * be connected at all, because there is no OAuth client to consent against.
   */
  const yours = (plugins.data?.catalogue ?? []).filter(
    (entry) => entry.auth === "user-oauth" && added.has(entry.key),
  );
  const explore = (plugins.data?.catalogue ?? []).filter(
    (entry) => !added.has(entry.key),
  );

  /*
   * Brokered apps belong here for the same reason the OAuth ones do: they answer as you.
   *
   * The filter above names the catalogue's `user-oauth` kind, which a brokered row cannot have
   * because it has no catalogue entry at all — so the one connector that is nothing but per-person
   * accounts was the one this page never listed.
   *
   * EXCEPT THE ONES THAT NEED NO ACCOUNT, WHICH IS THE SAME RULE THE `user-oauth` FILTER ABOVE IS.
   * That one keeps out a vendor with a shared token because it "has nothing for you to decide"; a
   * Composio `NO_AUTH` app has exactly as little, one layer further in. There is no account to make:
   * `/servers/:id/connect` refuses to create one and the call gate lets it through with no row, so
   * a row for it here can never turn green. What an admin enabling Hacker News put on every
   * person's page was a permanently grey "Not connected" that reads as an unfinished task, opening
   * a page that says the app needs no account and draws no button — the list and the page it opens
   * contradicting each other, with the list the more believable of the two.
   *
   * ASKED OF THE RECORDED SCHEME, which this read already carries and the detail route already
   * consumes. Anything that is not the vendor's `NO_AUTH` is an app somebody connects, an
   * unrecorded scheme included: a row whose column was never written is far likelier to be a key or
   * consent app, and dropping it here would hide a connection somebody does have.
   */
  const brokered = brokeredAccountsListedOn(plugins.data?.servers ?? []);
  const enabledNonOauthServers = (plugins.data?.servers ?? []).filter(
    (s) =>
      s.provenance !== "composio" &&
      !yours.some((y) => y.key === s.id),
  );
  const accounts = [
    ...yours.map((entry) => {
      const Mark = markFor(entry.key);
      return {
        key: entry.key,
        title: pluginTitle(entry.key, entry.title),
        summary: pluginSummary(entry.key, entry.summary),
        mark: <Mark className="size-4" />,
      };
    }),
    ...brokered.map((server) => ({
      key: server.id,
      title: pluginTitle(server.id, server.title),
      summary: pluginSummary(
        server.id,
        server.summary || `连接您的 ${server.title} 账号。`,
      ),
      mark: <PluginLogo logo={server.logo} />,
    })),
  ];
  const query = search.trim().toLocaleLowerCase();
  const matching = accounts.filter((account) =>
    `${account.title} ${account.summary}`.toLocaleLowerCase().includes(query),
  );
  const connectedCount = accounts.filter((account) =>
    connected.has(account.key),
  ).length;
  const sections = [
    {
      title: "已连接",
      accounts: matching.filter((account) => connected.has(account.key)),
    },
    {
      title: "未连接",
      accounts: matching.filter((account) => !connected.has(account.key)),
    },
  ];

  return (
    <PageShell
      className="max-w-4xl @container"
      description={"GitHub、机器人代表你使用的应用、你保存的网站登录，以及服务器加密保存的 API 密钥。"}
      title={"账号连接"}
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div
          aria-label={"账号连接分类"}
          className="sg-segmented"
          data-testid="connected-accounts-tabs"
          ref={segKeys.groupRef}
          role="radiogroup"
          {...segKeys.groupProps}
        >
          {CONNECTED_ACCOUNTS_TABS.map((item) => (
            <button
              aria-checked={activeTab === item.id}
              className="sg-segmented-item"
              data-testid={`connected-accounts-tab-${item.id}`}
              key={item.id}
              onClick={() => setTab(item.id)}
              role="radio"
              tabIndex={segKeys.itemTabIndex(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {showConnections ? (
        <>
          {/* GitHub（DESIGN.md §53）：自己的连接，不依赖管理员启用的连接器，所以放在最上面、总是显示。 */}
          <GithubConnectionSection />
          <div className="mt-8">
            <PersonalSourcesSection />
          </div>
          {/*
           * Only the failure is worth saying. A success needs no sentence: the row it came back to now
           * reads "Connected", which is the same news told by the thing it is news about.
           */}
          {outcome === "failed" ? (
            <p className="text-destructive text-sm" role="alert">
              {"无法连接该帐户。未保存任何内容——请重试。"}
            </p>
          ) : null}
          {plugins.isPending || connections.isPending ? <PageSkeleton /> : plugins.error ||
            connections.error ? (
            <p className="mt-12 text-destructive text-sm" role="alert">
              {
                "连接列表暂时读不到，刷新一下再试。"
              }
            </p>
          ) : (
            <>
              {accounts.length > 0 ? (
                <>
                  <p className="mt-5 text-xs text-muted-foreground">
                    {connectedCount} {"已连接 ·"}
                    {accounts.length} {"可用"}
                  </p>
                  <InputGroup className="mt-3 h-9 border-transparent bg-muted/60 shadow-none dark:bg-muted/60">
                    <InputGroupAddon>
                      <IconSearch aria-hidden="true" className="size-4" />
                    </InputGroupAddon>
                    <InputGroupInput
                      aria-label={"搜索应用"}
                      placeholder={"搜索应用"}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </InputGroup>
                  {matching.length === 0 ? (
                    <p className="mt-8 text-sm text-muted-foreground" role="status">
                      {"没有应用匹配“"}
                      {search.trim()}”.
                    </p>
                  ) : (
                    sections
                      .filter((section) => section.accounts.length > 0)
                      .map((section) => (
                        <section
                          className="mt-8"
                          key={section.title}
                          aria-label={section.title}
                        >
                          <h2 className="mb-3 px-2 text-xs font-medium text-muted-foreground">
                            {section.title}
                          </h2>
                          <div className="grid grid-cols-1 gap-x-6 gap-y-2 @min-[36rem]:grid-cols-2">
                            {section.accounts.map((account) => (
                              <Item
                                key={account.key}
                                className="min-w-0 flex-nowrap gap-3 px-2 py-3"
                                data-testid={`account-${account.key}`}
                                render={
                                  <Link
                                    params={{ key: account.key }}
                                    to="/settings/connected-accounts/$key"
                                  />
                                }
                                size="sm"
                              >
                                <RowMark className="size-9">{account.mark}</RowMark>
                                <ItemContent className="min-w-0 gap-0.5">
                                  <ItemTitle className="block w-auto truncate">
                                    {account.title}
                                  </ItemTitle>
                                  <ItemDescription
                                    className="line-clamp-1 break-all text-xs"
                                    title={account.summary}
                                  >
                                    {account.summary}
                                  </ItemDescription>
                                </ItemContent>
                                <ItemActions className="shrink-0">
                                  {connected.has(account.key) ? (
                                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                      <IconCheck
                                        aria-hidden="true"
                                        className="size-3.5 text-emerald-600 dark:text-emerald-400"
                                      />
                                      {"已连接"}
                                    </span>
                                  ) : (
                                    <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
                                      {"连接"}
                                    </span>
                                  )}
                                </ItemActions>
                              </Item>
                            ))}
                          </div>
                        </section>
                      ))
                  )}
                </>
              ) : null}

              <section className="mt-8" aria-label="插件与官方连接器">
                <div className="mb-3 flex items-center justify-between gap-3 px-2">
                  <div className="min-w-0">
                    <h2 className="text-sm font-medium">
                      {"外部服务与 MCP 连接器"}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {"开启 Notion、Google Drive、Parallel Search 或自定义 MCP 服务器；也可以在对话里直接让机器人帮你开启。"}
                    </p>
                  </div>
                  <Link
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-xs font-medium hover:bg-muted/80"
                    to="/admin/plugins"
                  >
                    <IconPuzzle className="size-3.5" />
                    {"管理插件与 MCP"}
                    <IconChevronRight className="size-3.5 text-muted-foreground" />
                  </Link>
                </div>
                {enabledNonOauthServers.length > 0 || explore.length > 0 ? (
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2 @min-[36rem]:grid-cols-2">
                    {enabledNonOauthServers.map((server) => {
                      const Mark = markFor(server.id);
                      const title = pluginTitle(server.id, server.title);
                      const summary = pluginSummary(server.id, server.summary);
                      return (
                        <Item
                          key={server.id}
                          className="min-w-0 flex-nowrap gap-3 px-2 py-3"
                          data-testid={`enabled-connector-${server.id}`}
                          render={
                            <Link
                              params={{ key: server.id }}
                              to="/admin/plugins/$key"
                            />
                          }
                          size="sm"
                        >
                          <RowMark className="size-9">
                            <Mark className="size-4" />
                          </RowMark>
                          <ItemContent className="min-w-0 gap-0.5">
                            <ItemTitle className="block w-auto truncate">
                              {title}
                            </ItemTitle>
                            <ItemDescription
                              className="line-clamp-1 break-all text-xs"
                              title={summary}
                            >
                              {summary}
                            </ItemDescription>
                          </ItemContent>
                          <ItemActions className="shrink-0">
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <IconCheck
                                aria-hidden="true"
                                className="size-3.5 text-emerald-600 dark:text-emerald-400"
                              />
                              {"已启用"}
                            </span>
                          </ItemActions>
                        </Item>
                      );
                    })}
                    {explore.map((entry) => {
                      const Mark = markFor(entry.key);
                      const title = pluginTitle(entry.key, entry.title);
                      const summary = pluginSummary(entry.key, entry.summary);
                      return (
                        <Item
                          key={entry.key}
                          className="min-w-0 flex-nowrap gap-3 px-2 py-3"
                          data-testid={`explore-connector-${entry.key}`}
                          render={
                            <Link
                              params={{ key: entry.key }}
                              to="/admin/plugins/$key"
                            />
                          }
                          size="sm"
                        >
                          <RowMark className="size-9">
                            <Mark className="size-4" />
                          </RowMark>
                          <ItemContent className="min-w-0 gap-0.5">
                            <ItemTitle className="block w-auto truncate">
                              {title}
                            </ItemTitle>
                            <ItemDescription
                              className="line-clamp-1 break-all text-xs"
                              title={summary}
                            >
                              {summary}
                            </ItemDescription>
                          </ItemContent>
                          <ItemActions className="shrink-0">
                            <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
                              {"去开启"}
                            </span>
                          </ItemActions>
                        </Item>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            </>
          )}
        </>
      ) : null}
      {showLogins ? (
        <div className={showConnections ? "mt-10" : "mt-2"}>
          <SavedLoginsSection />
        </div>
      ) : null}
      {showApiKeys ? <VaultSection embedded /> : null}
    </PageShell>
  );
}
