import {
  IconArrowUpRight,
  IconChevronRight,
  IconExternalLink,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  BrokeredAccountRow,
  useBrokeredAccount,
} from "@/components/plugins/brokered-account-row";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { pluginSummary, pluginTitle } from "@/lib/plugins/catalogue-zh";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { grantRoster } from "@/lib/agents/grant-roster";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { storeMcpToken } from "@/lib/credentials/mutations";
import {
  addCuratedServerMutationOptions,
  connectAccountMutationOptions,
  grantPlugin,
  invalidatePlugins,
  refreshPluginServerMutationOptions,
  registerOAuthClientMutationOptions,
  removePluginServerMutationOptions,
  setServerAutoGrantAllMutationOptions,
} from "@/lib/plugins/mutations";
import {
  type CatalogueItem,
  connectionsQueryOptions,
  type PluginServer,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One vendor: what it needs from this deployment, and which Bots hold its tools.
 *
 * Its own page because what a connector needs configured differs by vendor and does not fit on a
 * row. A token for one, an OAuth client and a redirect URI for another, an instance hostname for a
 * third, and then a grant per tool per Bot. The screen this replaced tried to hold all of that in a
 * list and grew a column per Bot, which is how a grant goes unread.
 */
export const Route = createFileRoute("/_authed/admin/plugins/$key")({
  component: RouteComponent,
});

/** Which of the four dialogs is open, or none. */
type OpenDialog = "token" | "client" | "instance" | "grant" | null;

/** The set with one member toggled, as a new set so React sees the change. */
function toggled(
  set: ReadonlySet<string>,
  member: string,
): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(member)) next.add(member);
  return next;
}

/**
 * How widely a tool is granted, in words rather than a fraction.
 *
 * "0/3" needs decoding and reads as a score. The two ends are the ones worth recognising without
 * reading — nothing holds this, or everything does — so they are named, and the middle is the only
 * case that gets a number.
 */
function grantSummary(held: number, total: number): string {
  if (held === 0) return "暂无机器人";
  if (held === total) return total === 1 ? "1 Bot" : "全部机器人";
  return `${held} / ${total} 个机器人`;
}

/**
 * How much of this vendor one Bot holds, in the same voice as {@link grantSummary}.
 *
 * The same decision counted the other way round, for the rows that open a Bot's own page against
 * this app. Named ends rather than a fraction, for the reason recorded above: "0/167" reads as a
 * score, and the two answers worth recognising without reading are none of it and all of it.
 */
function heldSummary(held: number, total: number): string {
  if (held === 0) return "暂无工具";
  if (held === total) return total === 1 ? "1 tool" : "全部工具";
  return `${held} 个 ${total} 工具`;
}

/**
 * How this vendor is reached, from whichever record we have.
 *
 * The row's own provenance is asked first because it is a fact this deployment recorded when the
 * app was enabled, not an inference: a brokered app is reached through Composio whatever the
 * catalogue does or does not say about it.
 *
 * That order matters because the catalogue has nothing to say about a brokered app — it is not a
 * curated entry — and what stood here was `entry?.auth ?? "deployment-bearer"`: a guess, and the
 * one guess that is wrong for the one row shape that cannot hold a token. The page then offered
 * "one credential, used for everybody" to the connector whose whole point is that each person
 * connects their own account, and would have stored a token nothing ever reads.
 *
 * A server an administrator added by URL is still the fallback's case, and still correct there:
 * nothing about it is reached as a person, so it gets the shared-token shape.
 */
export function connectionKindFor(
  server: PluginServer | undefined,
  auth: CatalogueItem["auth"] | undefined,
): CatalogueItem["auth"] | "brokered" {
  if (server?.provenance === "composio") return "brokered";
  return auth ?? "deployment-bearer";
}

/**
 * A row whose whole content is connection state, standing in for it when it could not be read.
 *
 * DRAWN BY BOTH ROWS THAT READ `/api/plugins/connections` — the brokered account and the
 * `user-oauth` one — because the defaulting they suffer from is the same and so is the honest
 * answer to it. Neither is drawn on a deployment-token server, which has no connection state to
 * fail on.
 *
 * IN THE ROW'S OWN PLACE, so the card keeps its shape and the sentence sits where the thing it is
 * about would have been. What it must not say is anything about whether an account exists: the
 * whole defect is that a failed read defaulted to "not connected", and a second sentence guessing
 * in the other direction would be the same mistake with better manners.
 *
 * `role="alert"` rather than plain text, because this appears in place of a row that carried
 * buttons — somebody reading with a screen reader has to be told the controls are gone and why,
 * not left to notice their absence.
 */
function ConnectionStateUnreadable() {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{"你的账号"}</ItemTitle>
        <ItemDescription role="alert">
          {
            "账户连接状态无法加载，因此未显示任何内容。可能存在问题。重新加载页面，如果仍然存在，请检查此部署的日志。"
          }
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

function RouteComponent() {
  const { key } = useParams({ from: "/_authed/admin/plugins/$key" });
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  /*
   * The administrator's OWN connections, not the deployment's.
   *
   * On an admin screen that is a deliberate mixture, and it is the useful one: setting a per-person
   * connector up and finding out whether it works are two different questions, and the second has no
   * answer anywhere on this page without it. Nobody else's connection is readable here — the endpoint
   * only ever returns the caller's, so this cannot become a list of who has connected what.
   */
  const connections = useQuery(connectionsQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a grant one of them holds is still on this page. */
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));
  /*
   * The row itself rather than whether there is one, because the brokered row below wants what the
   * last re-check found and that is written on this same row. Asking a second time for it would be
   * a second answer to a question this read already carried.
   */
  const connection = (connections.data?.connections ?? []).find(
    (row) => row.serverId === key,
  );
  const youConnected = connection !== undefined;
  /*
   * A CONNECTIONS READ THAT FAILED IS SAID RATHER THAN DEFAULTED, AND ONLY WHERE IT IS READ.
   *
   * Nothing read `connections.error` at all, so a 500 from `/api/plugins/connections` degraded an
   * account whose last check did not come back clean to "not connected" — dropping the sentence and
   * withdrawing both Re-check and Disconnect — with no error text anywhere on the page.
   *
   * WITHHELD PER ROW RATHER THAN PER PAGE, which is the difference between this screen and the
   * personal one. There, the page's entire content IS connection state, so drawing nothing is the
   * honest whole answer. Here the page also carries the tools, the grants, Refresh and Remove, none
   * of which touch this read — and a deployment-token server has no connection state on it at all.
   * Collapsing the page on this error took an administrator's Remove button away at the exact
   * moment something was failing, for every plugin in the deployment rather than only the two kinds
   * that read this.
   *
   * BOTH KINDS THAT READ IT, not just the brokered one: the `user-oauth` "Your account" row derives
   * its whole sentence and its Connect button from {@link youConnected}, which is the same defaulted
   * `false` the brokered row was getting.
   */
  const connectionsUnreadable = connections.error !== null;

  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [token, setToken] = useState("");
  const [instanceHost, setInstanceHost] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  /** Who gets the tools, and which, while the grant dialog is open. */
  const [selectedBots, setSelectedBots] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedRefs, setSelectedRefs] = useState<ReadonlySet<string>>(
    new Set(),
  );
  /**
   * How far through a batch of grants we are, or null when none is running.
   *
   * A count rather than a boolean because a bulk grant is honestly N writes: a Bot times twelve
   * tools is twelve requests, and a button that says only "Granting…" for the length of them gives
   * an administrator no way to tell a slow batch from a stuck one.
   */
  const [granting, setGranting] = useState<{
    done: number;
    total: number;
  } | null>(null);

  /* Every write reports into one banner rather than each growing its own handler. */
  const report = { onError: (thrown: Error) => setError(thrown.message) };
  const addCurated = useMutation({
    ...addCuratedServerMutationOptions(queryClient),
    ...report,
  });
  const registerClient = useMutation({
    ...registerOAuthClientMutationOptions(queryClient),
    ...report,
  });
  const refresh = useMutation({
    ...refreshPluginServerMutationOptions(queryClient),
    ...report,
  });
  const remove = useMutation({
    ...removePluginServerMutationOptions(queryClient),
    ...report,
  });
  const setAutoGrantAll = useMutation({
    ...setServerAutoGrantAllMutationOptions(queryClient),
    ...report,
  });
  const connectSelf = useMutation({
    // Back to this page afterwards, not to the personal settings screen.
    ...connectAccountMutationOptions("admin"),
    ...report,
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be
     * shown to this person in their own browser; there is deliberately nothing here that could
     * complete it for them, and nothing about being an administrator changes that.
     */
    onSuccess: (authorizationUrl) => {
      /*
       * A 200 with no url on it is not a url to follow. This press is on a `user-oauth` catalogue
       * entry, whose half of that route always mints one or refuses, so this is the server having
       * answered something this page does not understand. Assigning it navigated to a page called
       * `undefined` on this deployment's own origin. See `connectAccountMutationOptions`.
       */
      if (authorizationUrl === null) {
        setError(
          "此部署回答时没有同意链接，因此没有地方发送给你且未连接任何内容。重试，如果持续存在请检查此连接器的设置。",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });
  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const server = plugins.data?.servers.find((item) => item.id === key);
  /*
   * Everybody on the roster, and anybody hidden from it who holds one of this app's grants,
   * withdrawn ones included: see `grantRoster`. Named from the roster rows themselves, because the
   * id-to-name lookup other admin screens use is built from the visible roster alone.
   */
  const bots = grantRoster({
    roster: agents ?? [],
    hidden: hiddenAgents ?? [],
    holders: [
      ...(server?.tools ?? []).flatMap((tool) => tool.grantedTo),
      ...(server?.withdrawn ?? []).flatMap((held) => held.grantedTo),
    ],
  }).map((agent) => ({
    id: agent.id,
    name: agent.name,
    hidden: agent.hidden,
  }));

  const auth = connectionKindFor(server, entry?.auth);
  const title = pluginTitle(key, entry?.title ?? server?.title ?? key);

  /* Bound once because the brokered row below is told it twice — once inside the whole
     disconnected sentence and once on its own — and two copies of it would drift. */
  const reassurance =
    "不连它也能把这个应用配好；它只读得到你的文档。";

  /*
   * Everything the brokered row below reads and does, shared with the personal connected-accounts
   * screen that draws the same row. See `brokered-account-row.tsx`.
   *
   * `connectSelf` above stays: it is the `user-oauth` row's Connect, which is a different row with
   * no Disconnect beside it and nothing brokered to confirm.
   */
  const brokeredAccount = useBrokeredAccount({
    authScheme: server?.authScheme ?? null,
    brokered: auth === "brokered",
    configured: plugins.data?.composioConfigured ?? false,
    recorded: youConnected,
    report: setError,
    // Back to this page afterwards, not to the personal settings screen.
    returnTo: "admin",
    serverId: key,
    /*
     * Absent where this person has never connected the app, and false rather than asserted: with no
     * row there is nothing that could have been checked, which is exactly what the server's own
     * columns default to. The three are optional on the type because that endpoint concatenates two
     * reads and only a brokered row carries them.
     */
    verified: connection?.verified ?? false,
    verifiedAt: connection?.verifiedAt ?? null,
    /*
     * AND THIS ONE IS NOT FLATTENED, for the reason the personal screen gives: the two above fall
     * back on the server's own column defaults, while a null here is the server's record that the
     * last check spent nothing — not the absence of a record. The row draws a different sentence
     * for each, so the difference has to reach it.
     */
    probe: connection?.probe,
    /*
     * WHILE THIS ONE IS, for the reason that screen gives too: it is the Re-check button's gate and
     * not a sentence. The record above says what was spent and this says whether the app has
     * anything to spend today — asking the record the second question is what left a key nothing
     * was tried on with no way to ever have anything tried on it. Absent and false are the same
     * closed gate, so the fallback costs nothing here.
     */
    checkable: connection?.checkable ?? false,
  });

  /** Adding is two writes when a token was typed: the credential, then the record pointing at it. */
  const add = async () => {
    setError(null);
    try {
      const credentialId =
        auth === "deployment-bearer"
          ? await storeMcpToken(key, token || undefined)
          : undefined;
      await addCurated.mutateAsync({
        key,
        instanceHost: instanceHost || undefined,
        credentialId,
      });
      if (auth === "user-oauth" && client.clientId && client.clientSecret) {
        await registerClient.mutateAsync({ serverId: key, ...client });
      }
      setToken("");
      setClient({ clientId: "", clientSecret: "" });
      setDialog(null);
    } catch (thrown) {
      setError((thrown as Error).message);
    }
  };

  /*
   * One write per grant, in selection order. The server records each grant as its own audit row, so
   * a bulk action here is honestly N decisions; a refusal stops the rest and leaves the dialog open
   * with the banner saying why.
   *
   * One refetch for the batch, at the end. Going through the grant mutation invalidated every plugin
   * query after each write and awaited it, so a batch of twenty grants was twenty round trips
   * interleaved with twenty refetches of a list nobody could see behind the dialog — most of the
   * wait, for nothing anybody read. It is invalidated even when a grant is refused, because the ones
   * before it landed and the screen behind is now stale about them.
   */
  const grantSelected = async () => {
    setError(null);
    const total = selectedBots.size * selectedRefs.size;
    setGranting({ done: 0, total });
    let done = 0;
    try {
      for (const agentId of selectedBots) {
        for (const ref of selectedRefs) {
          await grantPlugin({ agentId, kind: "mcp", ref });
          done += 1;
          setGranting({ done, total });
        }
      }
      setDialog(null);
    } catch (thrown) {
      setError((thrown as Error).message);
    } finally {
      await invalidatePlugins(queryClient);
      setGranting(null);
    }
  };

  /*
   * Nothing rather than a placeholder, so no sentence asserts anything while the fetch is open —
   * AND BOTH READS ARE WAITED FOR. `recorded`, `verified`, `verifiedAt`, `probe` and `checkable`
   * all come off the connections read and this gated on `plugins` alone, so a connections read
   * still in flight drew the brokered row with the whole of its state defaulted to "you have never
   * connected this". The personal screen had the identical gap; see its own note.
   */
  if (plugins.isPending || connections.isPending) {
    return <PageShell title={"插件"}>{null}</PageShell>;
  }
  /*
   * Gated on the plugin list having ARRIVED, the guard the per-Bot grant screen already keeps
   * (`plugins.data && !server`). `isPending` goes false on a failed fetch exactly as it does on a
   * successful one, so `!(entry || server)` alone cannot tell "this deployment has no plugin by
   * that name" apart from "the plugin list could not be read", and a request that never came back
   * is no evidence for the first. Nothing on this page survives the failure: the title, the tools
   * and the grants are all that one response.
   */
  if (!plugins.data) {
    return (
      <PageShell
        backButton={{ label: "插件", linkProps: { to: "/admin/plugins" } }}
        title={"插件"}
      >
        <p className="mt-12 text-destructive text-sm" role="alert">
          {"插件无法加载。"}
        </p>
      </PageShell>
    );
  }
  if (!(entry || server)) {
    return (
      <PageShell
        backButton={{ label: "插件", linkProps: { to: "/admin/plugins" } }}
        description={"此部署没有名为该名称的插件，目录也没有提供。"}
        title={"不是插件"}
      >
        <PageEmpty>{"无需配置。"}</PageEmpty>
      </PageShell>
    );
  }

  /* The grant dialog's two halves of the tool list, split by what a boundary would see. */
  const reads = server?.tools.filter((tool) => tool.effect !== "write") ?? [];
  const writes = server?.tools.filter((tool) => tool.effect === "write") ?? [];
  const chosenWrites = writes.filter((tool) =>
    selectedRefs.has(tool.ref),
  ).length;
  const chosenNames = bots
    .filter((bot) => selectedBots.has(bot.id))
    .map((bot) => bot.name);

  return (
    <PageShell
      backButton={{ label: "插件", linkProps: { to: "/admin/plugins" } }}
      description={pluginSummary(key, entry?.summary ?? server?.summary)}
      title={title}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {/*
       * No section heading. This is one decision, and a heading over a single row that repeats the
       * row's own title tells a reader nothing they cannot already see.
       */}
      <PageSection>
        <PageRows className="mt-0">
          {/*
           * Binary and immediate, which is what the layout skill reserves a Switch for: it takes
           * effect when switched and there is no save. It replaces an "Add to deployment" button and
           * a destructive "Remove" row that were the same decision drawn twice, in two places, one of
           * them looking far more dangerous than the other.
           *
           * The description states the consequence in the present tense, in both directions, because
           * switching this off deletes every grant on the vendor's tools and that is not recoverable
           * by switching it back on.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{"为此部署启用"}</ItemTitle>
              <ItemDescription>
                {server
                  ? "机器人可以被授予工具。关闭此开关会移除它和所有授予的工具。"
                  : "没有机器人可以访问此供应商。打开它以配置并授予其工具。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={`为此部署启用 ${title}`}
                checked={server !== undefined}
                onCheckedChange={(next) => {
                  setError(null);
                  if (next) void add();
                  else remove.mutate(key);
                }}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {server ? (
        <PageSection
          description={
            auth === "user-oauth"
              ? "此供应商以询问者身份回答。部署注册 OAuth 客户端，每个人连接自己的账号，因此机器人只看到该人能看到的内容。"
              : auth === "builtin"
                ? "内置于此部署中。无需联系供应商，也无需持有凭证——调用以请求者身份运行。"
                : auth === "brokered"
                  ? /* The row below says how, at length. This says whose account it is, which is the part that decides what an administrator has to do here — which is nothing. */
                    "通过 Composio 访问，Composio 持有每个人的账户。"
                  : "此部署呈现给供应商的内容。一种凭据，供所有人使用。"
          }
          title={"连接"}
        >
          {/*
           * Rows that DO something, and nothing else — with two admitted exceptions. The layout
           * skill's third row kind — a value with no chevron and nothing to click — earns its
           * place on a screen full of them, but among four actionable rows a dead one reads as a
           * control that has stopped working. The redirect URI is prose under the card instead.
           *
           * The first exception is the OAuth client row for a vendor with a dynamic client: there
           * is a real fact to state — this deployment registers itself, nobody configures it —
           * right where the actionable client row would otherwise sit. Leaving that slot empty
           * would read as a missing setup step, not as nothing to do.
           *
           * The second is the whole Connection card for a builtin server: there is nothing to
           * configure, but a card of nothing under a "Connection" heading reads as a missing setup
           * step rather than as the answer. The row states that plainly instead of leaving the
           * card empty — and being first, it also gives the docsUrl row below something other than
           * the card's own top border to sit its leading separator against.
           *
           * The third is the brokered row, for the same reason as the second and one more: an
           * administrator looking at a Connection card with only somebody's personal account on it
           * will reasonably look for the deployment's half of the arrangement. There is one, it is
           * just not theirs to type, and saying so is the only way this card is not read as
           * half-configured.
           */}
          <PageRows>
            {auth === "builtin" ? (
              /*
               * Nothing to click. A builtin server runs inside this deployment, on tables it
               * already owns — there is no vendor to authenticate to and no credential to store.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{"连接"}</ItemTitle>
                  <ItemDescription>
                    {"无需配置。这些工具在此部署内运行，在它已拥有的表上。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {"内置"}
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "brokered" ? (
              /*
               * Nothing to click. The deployment's half of a brokered app is one key held once,
               * for Composio rather than for this vendor, and it is set where every brokered app
               * reads it from — not here, per app, by hand.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{"如何达成"}</ItemTitle>
                  <ItemDescription>
                    {
                      "此应用通过 Composio 访问，Composio 持有账户。此部署发送一个密钥和询问者的名称，因此每个人连接自己的，机器人只能看到该人可见的内容。无需粘贴令牌。"
                    }
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {"通过 Composio"}
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "deployment-bearer" ? (
              <Item
                render={
                  <button onClick={() => setDialog("token")} type="button" />
                }
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>{"访问令牌"}</ItemTitle>
                  <ItemDescription>
                    {"作为此供应商每次调用的持有者令牌发送。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {server?.hasCredential ? "已持有" : "未设置"}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            ) : null}

            {auth === "user-oauth" && server?.dynamicClient ? (
              /*
               * Nothing to click. This deployment registers its own OAuth client with the
               * vendor (RFC 7591) the first time anybody connects, so there is no client id
               * or secret for an administrator to hold, let alone paste.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{"OAuth 客户端"}</ItemTitle>
                  <ItemDescription>
                    {"此部署在首次连接时向供应商注册。没有什么可粘贴的。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {"自注册"}
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "user-oauth" && !server?.dynamicClient ? (
              <Item
                render={
                  <button onClick={() => setDialog("client")} type="button" />
                }
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>{"OAuth 客户端"}</ItemTitle>
                  <ItemDescription>
                    {"将此部署标识给供应商。它不会自行访问任何人的文档"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {server?.hasCredential ? "已注册" : "未注册"}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            ) : null}

            {/*
             * The administrator's own account, on the setup screen.
             *
             * Setting a connector up and knowing whether it works are different questions, and the
             * second used to have no answer here: an administrator finished configuring Drive and
             * had to go to their personal settings to find out whether any of it was right. This row
             * answers it in place, and stays honest about being personal — it is this person's
             * connection, not deployment state, and it reaches their documents and nobody else's.
             *
             * It is NOT part of setup. The connector is fully configured without it, which is why it
             * sits below the client and says so rather than reading as the next required step.
             *
             * Shown once a client exists, because there is nothing to consent against before
             * that: a Connect button with no OAuth client behind it can only fail. A vendor with a
             * dynamic client is the exception — there is no client to register in advance, so
             * Connect is shown right away and is itself what creates one.
             *
             * A brokered app is shown right away too, and for the same reason: there is nothing
             * for an administrator to configure first, so there is no state in which connecting
             * could only fail. It is the one row on this card that is not optional in practice —
             * a brokered app reaches nobody until somebody connects — but it is still personal,
             * and still this person's account and nobody else's.
             *
             * The two are drawn by different things, which is the honest arrangement rather than
             * one row branching on `auth` in five places. A brokered account is ended from here as
             * well as begun, and says so; an OAuth one is withdrawn at the vendor and this page
             * offers no button pretending otherwise.
             */}
            {auth === "brokered" ? (
              <>
                <Separator />
                {connectionsUnreadable ? (
                  <ConnectionStateUnreadable />
                ) : (
                  <BrokeredAccountRow
                    account={brokeredAccount}
                    /* Said beside the button rather than after it: disconnecting ends the account
                       at Composio, so what it undoes is not the row here but the grant on this
                       person's mailbox, and connecting again is a fresh consent. */
                    connectedDescription={`已连接：被授予这些工具的机器人会以你的身份读 ${title}。断开连接会连 Composio 那边的账号一起断掉，不只是这里的这一行。`}
                    disconnectedDescription={`连上你自己的账号就能试这个连接器。${reassurance}`}
                    /* The half of the line above that is true whichever way this app connects.
                       An app whose key somebody types gets a different first sentence from the
                       row — pressing Connect opens a form rather than leaving for a consent
                       screen — and an administrator still has to be told they are not the step
                       that finishes the connector. */
                    disconnectedReassurance={reassurance}
                    title={title}
                  />
                )}
              </>
            ) : null}

            {auth === "user-oauth" &&
            (server?.hasCredential || server?.dynamicClient) ? (
              <>
                <Separator />
                {connectionsUnreadable ? (
                  <ConnectionStateUnreadable />
                ) : (
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{"你的账号"}</ItemTitle>
                      <ItemDescription>
                        {youConnected
                          ? `已连接：拿到这些工具的机器人会用你的 ${title} 账号。`
                          : "连上你的账号试试这个连接器。不连也能完成设置；它只会访问你自己的内容。"}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {youConnected ? (
                        <>
                          {/* Decorative: the word beside it already says which. */}
                          <span
                            aria-hidden="true"
                            className="size-1.5 rounded-full bg-emerald-500"
                          />
                          <span className="text-muted-foreground text-xs">
                            {"已连接"}
                          </span>
                        </>
                      ) : (
                        /* The arrow says this leaves OpenBot for the vendor's consent page. It does. */
                        <Button
                          disabled={connectSelf.isPending}
                          onClick={() => {
                            setError(null);
                            connectSelf.mutate(key);
                          }}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {"连接"}
                          <IconArrowUpRight />
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                )}
              </>
            ) : null}

            {entry?.perInstance ? (
              <>
                <Separator />
                <Item
                  render={
                    <button
                      onClick={() => setDialog("instance")}
                      type="button"
                    />
                  }
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>{"实例主机"}</ItemTitle>
                    <ItemDescription>
                      {
                        "此供应商为每个客户提供自己的主机名，在存储任何内容之前检查其模式。"
                      }
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-xs">
                      {server?.url ?? "未设置"}
                    </span>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </>
            ) : null}

            {entry?.docsUrl ? (
              <>
                <Separator />
                <Item
                  render={
                    <a href={entry.docsUrl} rel="noreferrer" target="_blank" />
                  }
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>
                      {auth === "builtin" ? "文档" : "供应商文档"}
                    </ItemTitle>
                    <ItemDescription>
                      {auth === "builtin"
                        ? "这些工具提供什么，由维护它们的人提供。"
                        : "此服务器提供什么，由维护它的人提供。"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconExternalLink className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </>
            ) : null}
          </PageRows>

          {auth === "user-oauth" ? (
            <div className="mt-3 p-3">
              {server?.dynamicClient ? (
                <p className="text-muted-foreground text-sm">
                  {"部署自身注册其重定向URI，因此无需在供应商处添加。"}
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {
                    "将此添加到供应商的客户端授权重定向 URI 中，精确如上。一处字符错误就会失败，那里的消息不会提到 ChisaBot。"
                  }
                </p>
              )}
              {!plugins.data?.redirectUri ? (
                <p className="mt-3 text-destructive text-sm" role="alert">
                  {
                    "此部署没有公共 URL，因此没有人可以完成同意流程。请设置 OPENBOT_PUBLIC_URL。"
                  }
                </p>
              ) : server?.dynamicClient ? null : (
                /* Selectable and monospaced: it is copied by hand into somebody else's console. */
                <code className="mt-3 block select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {plugins.data.redirectUri}
                </code>
              )}
            </div>
          ) : null}
        </PageSection>
      ) : null}

      {server ? (
        <PageSection
          /*
           * Beside the heading rather than on the page's own baseline. Refreshing is about this list
           * and nothing else on the screen — it asks the vendor what it offers now — so it belongs
           * where the list is named. Ghost, because it is a maintenance action rather than the thing
           * an administrator came here to do.
           */
          action={
            <div className="flex gap-1.5">
              <Button
                feedback="refresh"
                mutation={refresh}
                onClick={() => refresh.mutate(key)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {"刷新工具"}
              </Button>
              {/*
               * Outline where refresh is ghost: granting is the thing an administrator came to
               * this section to do. Hidden rather than disabled with nothing to grant — a dialog
               * over an empty list could only explain its own emptiness.
               */}
              {server.tools.length > 0 && bots.length > 0 ? (
                <Button
                  onClick={() => {
                    setSelectedBots(new Set());
                    setSelectedRefs(new Set());
                    setDialog("grant");
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {"授权工具…"}
                </Button>
              ) : null}
            </div>
          }
          description={
            "机器人仅在持有工具时被告知关于该工具。每次调用在发生时再次决定，因此移除授权在下一次调用时生效。"
          }
          title={"工具"}
        >
          <PageRows className="mb-3">
            <Item size="sm">
              <ItemContent>
                <ItemTitle>{"全员默认开启"}</ItemTitle>
                <ItemDescription>
                  {server.autoGrantAll
                    ? "所有成员的机器人都可直接使用此服务器的全部工具，包括以后新增的工具。关闭后立即收回。"
                    : "没有逐个授予的机器人不能使用它。打开后所有成员的机器人自动获得全部工具（仅限按人授权或无需凭据的服务器）。"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label={`全员默认开启 ${title}`}
                  checked={Boolean(server.autoGrantAll)}
                  disabled={setAutoGrantAll.isPending}
                  onCheckedChange={(checked) => {
                    setError(null);
                    setAutoGrantAll.mutate({ serverId: server.id, enabled: Boolean(checked) });
                  }}
                />
              </ItemActions>
            </Item>
          </PageRows>
          {server.tools.length === 0 ? (
            <PageEmpty>
              {server.lastError ?? "未列出工具。刷新以再次询问供应商。"}
            </PageEmpty>
          ) : (
            <PageRows>
              {server.tools.map((tool, index) => (
                <React.Fragment key={tool.ref}>
                  {/* A real link with no children: children passed to `render` replace the row's own. */}
                  <Item
                    render={
                      <Link
                        params={{ key, tool: tool.name }}
                        to="/admin/plugins/$key/tools/$tool"
                      />
                    }
                    size="sm"
                  >
                    <ItemContent>
                      <ItemTitle className="font-mono text-xs">
                        {tool.name}
                      </ItemTitle>
                      <ItemDescription>{tool.description}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * How many Bots hold it, not which. The names were here as a chip each and
                       * turned every row into a wrapping cluster of controls — twenty-four of them
                       * across this list — with the tool's own name losing the fight for attention.
                       * A count is what a reader scanning for "what is exposed, and how widely" is
                       * actually asking, and the names are one click away where they can be switched
                       * one at a time.
                       */}
                      <span className="text-muted-foreground text-xs">
                        {grantSummary(tool.grantedTo.length, bots.length)}
                      </span>
                      {/*
                       * The effect, not a description. It is what a boundary written about writes
                       * evaluates, and an operator writing that rule has no other way to know.
                       */}
                      <span
                        className={
                          tool.effect === "write"
                            ? "text-amber-600 text-xs dark:text-amber-500"
                            : "text-muted-foreground text-xs"
                        }
                      >
                        {tool.effect === "write" ? "更改事物" : "读取"}
                      </span>
                      <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </ItemActions>
                  </Item>
                  {index !== server.tools.length - 1 && <Separator />}
                </React.Fragment>
              ))}
            </PageRows>
          )}

          {/*
           * The same grants, from the Bot's end.
           *
           * In this section rather than one of its own, because it is not a second subject: the
           * list above is one action and every Bot, and these rows are one Bot and every action.
           * Which way round somebody wants it depends on what they came here to do — write a rule
           * about an action, or set a Bot up — and an app of a hundred and sixty-seven actions is
           * only approachable from this end.
           */}
          {server.tools.length > 0 && bots.length > 0 ? (
            <>
              <p className="mt-8 font-medium text-sm">{"由机器人"}</p>
              <PageRows>
                {bots.map((bot, index) => (
                  <React.Fragment key={bot.id}>
                    {/* A real link with no children: children passed to `render` replace the row's own. */}
                    <Item
                      render={
                        <Link
                          params={{ agentId: bot.id, key }}
                          to="/admin/plugins/$key/bots/$agentId"
                        />
                      }
                      size="sm"
                    >
                      <ItemContent>
                        <ItemTitle>{bot.name}</ItemTitle>
                        <ItemDescription>
                          {bot.hidden
                            ? "从你的名册隐藏。此应用提供的每个操作，逐一切换"
                            : "此应用提供的每个操作，一次切换一个。"}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <span className="text-muted-foreground text-xs">
                          {heldSummary(
                            server.tools.filter((tool) =>
                              tool.grantedTo.includes(bot.id),
                            ).length,
                            server.tools.length,
                          )}
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </ItemActions>
                    </Item>
                    {index !== bots.length - 1 && <Separator />}
                  </React.Fragment>
                ))}
              </PageRows>
            </>
          ) : null}
        </PageSection>
      ) : null}

      {/*
       * Only when there is something to say. An empty section here would teach a reader to scroll past
       * a heading that is usually blank, which is the opposite of the point.
       *
       * Its own section rather than rows inside Tools, because these are not tools: they are not
       * listed by the vendor, there is no page to open for one, and putting them in the same list
       * would make the count above it wrong.
       */}
      {server && server.withdrawn.length > 0 ? (
        <PageSection
          description={
            "此供应商不再列出这些，因此没有机器人被告知它们，也没有模型可以调用一个。授权仍被记录，如果供应商开始列出它，工具将被再次提供。如果这不是你想要的，请从机器人的页面撤销。"
          }
          title={"已持有但未提供"}
        >
          <PageRows>
            {server.withdrawn.map((held, index) => (
              <React.Fragment key={held.ref}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle className="font-mono text-xs">
                      {held.name}
                    </ItemTitle>
                    <ItemDescription>
                      {"未列出"}
                      {title}
                      {server.toolsRefreshedAt ? "截至上次刷新" : ""}.
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-xs">
                      {grantSummary(held.grantedTo.length, bots.length)}
                    </span>
                  </ItemActions>
                </Item>
                {index !== server.withdrawn.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}

      <Dialog
        onOpenChange={(open) => setDialog(open ? dialog : null)}
        open={dialog !== null && dialog !== "grant"}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "client"
                ? `OAuth 客户端用于 ${title}`
                : dialog === "instance"
                  ? ` ${title} 的实例主机`
                  : `访问 ${title} 的访问令牌`}
            </DialogTitle>
            <DialogDescription>
              {dialog === "client"
                ? "来自供应商控制台。该密钥存储在此部署的密钥库中，从不读取回。"
                : dialog === "instance"
                  ? "你自己在这个服务商的主机名。保存前会按服务商的格式检查。"
                  : "存储在此部署的保险库中，从不读取回来。"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              {dialog === "client" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="client-id">{"客户端 ID"}</FieldLabel>
                    <Input
                      id="client-id"
                      onChange={(event) =>
                        setClient((c) => ({
                          ...c,
                          clientId: event.target.value,
                        }))
                      }
                      value={client.clientId}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="client-secret">
                      {"客户端密钥"}
                    </FieldLabel>
                    <Input
                      id="client-secret"
                      onChange={(event) =>
                        setClient((c) => ({
                          ...c,
                          clientSecret: event.target.value,
                        }))
                      }
                      type="password"
                      value={client.clientSecret}
                    />
                  </Field>
                </>
              ) : dialog === "instance" ? (
                <Field>
                  <FieldLabel htmlFor="instance-host">{"实例主机"}</FieldLabel>
                  <Input
                    id="instance-host"
                    onChange={(event) => setInstanceHost(event.target.value)}
                    placeholder="https://your-instance.service-now.com"
                    value={instanceHost}
                  />
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="access-token">{"访问令牌"}</FieldLabel>
                  <Input
                    id="access-token"
                    onChange={(event) => setToken(event.target.value)}
                    type="password"
                    value={token}
                  />
                </Field>
              )}
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setDialog(null)} size="sm" variant="ghost">
              {"取消"}
            </Button>
            <Button
              onClick={() => {
                if (!server) {
                  void add();
                  return;
                }
                if (dialog === "client") {
                  registerClient.mutate({ serverId: key, ...client });
                }
                setDialog(null);
              }}
              size="sm"
            >
              {"保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
       * Who first, then what: the decision arrives as "set this Bot up", not as a list of tools
       * looking for an owner. Both groups get a select-all; the amber heading and the footer's
       * "N of which change things" are what keep a bulk write grant a read decision, not a blind one.
       */}
      {server ? (
        <Dialog
          onOpenChange={(open) => setDialog(open ? dialog : null)}
          open={dialog === "grant"}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{"授权工具"}</DialogTitle>
              <DialogDescription>
                {
                  "每个授权都是审计轨迹上的独立条目，授予的写入仍然在每次调用时根据权限规则检查。"
                }
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-4 space-y-5">
              {/*
               * Each set of tickboxes is a group named by its own heading, so a screen reader
               * reaching a bare tool name is told which list it is in. "Changes things" is the whole
               * warning on those, and it is a heading a sighted reader cannot miss and a listener
               * would otherwise never hear.
               *
               * A `fieldset` because that is what a group of tickboxes is, named by the heading
               * already on screen rather than by a `legend` duplicating it. `min-w-0` undoes the
               * one thing a fieldset brings that a div did not: a min-content floor that a long
               * tool name would push the dialog out to.
               */}
              <fieldset aria-labelledby="grant-to-heading" className="min-w-0">
                <p className="mb-2 font-medium text-sm" id="grant-to-heading">
                  {"至"}
                </p>
                <div className="space-y-2">
                  {bots.map((bot) => (
                    <div className="flex items-center gap-2" key={bot.id}>
                      <Checkbox
                        checked={selectedBots.has(bot.id)}
                        id={`grant-bot-${bot.id}`}
                        onCheckedChange={() =>
                          setSelectedBots((previous) =>
                            toggled(previous, bot.id),
                          )
                        }
                      />
                      <label
                        className="text-sm"
                        htmlFor={`grant-bot-${bot.id}`}
                      >
                        {bot.name}
                      </label>
                    </div>
                  ))}
                </div>
              </fieldset>
              <div className="max-h-64 space-y-5 overflow-y-auto">
                {reads.length > 0 ? (
                  <fieldset
                    aria-labelledby="grant-reads-heading"
                    className="min-w-0"
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <p
                        className="font-medium text-sm"
                        id="grant-reads-heading"
                      >
                        {"读取"}
                      </p>
                      <Button
                        onClick={() =>
                          setSelectedRefs((previous) => {
                            const next = new Set(previous);
                            for (const tool of reads) next.add(tool.ref);
                            return next;
                          })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {"全选"}
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {reads.map((tool) => (
                        <div className="flex items-center gap-2" key={tool.ref}>
                          <Checkbox
                            checked={selectedRefs.has(tool.ref)}
                            id={`grant-tool-${tool.ref}`}
                            onCheckedChange={() =>
                              setSelectedRefs((previous) =>
                                toggled(previous, tool.ref),
                              )
                            }
                          />
                          <label
                            className="font-mono text-xs"
                            htmlFor={`grant-tool-${tool.ref}`}
                          >
                            {tool.name}
                          </label>
                        </div>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
                {writes.length > 0 ? (
                  <fieldset
                    aria-labelledby="grant-writes-heading"
                    className="min-w-0"
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <p
                        className="font-medium text-amber-600 text-sm dark:text-amber-500"
                        id="grant-writes-heading"
                      >
                        {"更改事物"}
                      </p>
                      <Button
                        onClick={() =>
                          setSelectedRefs((previous) => {
                            const next = new Set(previous);
                            for (const tool of writes) next.add(tool.ref);
                            return next;
                          })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {"全选"}
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {writes.map((tool) => (
                        <div className="flex items-center gap-2" key={tool.ref}>
                          <Checkbox
                            checked={selectedRefs.has(tool.ref)}
                            id={`grant-tool-${tool.ref}`}
                            onCheckedChange={() =>
                              setSelectedRefs((previous) =>
                                toggled(previous, tool.ref),
                              )
                            }
                          />
                          <label
                            className="font-mono text-xs"
                            htmlFor={`grant-tool-${tool.ref}`}
                          >
                            {tool.name}
                          </label>
                        </div>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
              </div>
            </DialogBody>
            <DialogFooter className="mt-4 items-center">
              {/* What is about to happen, in one sentence, before it does. */}
              {selectedRefs.size > 0 && chosenNames.length > 0 ? (
                <p className="flex-1 text-muted-foreground text-xs">
                  {`授予 ${selectedRefs.size} ${selectedRefs.size === 1 ? "工具" : "工具"}${
                    chosenWrites > 0
                      ? `，其中 ${chosenWrites} 项会${chosenWrites === 1 ? "修改" : "修改"}数据，`
                      : ""
                  } 给 ${chosenNames.join(", ")}。`}
                </p>
              ) : null}
              <Button onClick={() => setDialog(null)} size="sm" variant="ghost">
                {"取消"}
              </Button>
              <Button
                disabled={
                  granting !== null ||
                  selectedBots.size === 0 ||
                  selectedRefs.size === 0
                }
                onClick={() => void grantSelected()}
                size="sm"
              >
                {/* The one in flight, not the ones finished: a count that starts at zero of twelve reads as nothing happening. */}
                {granting
                  ? `授予 ${Math.min(granting.done + 1, granting.total)} 的 ${granting.total}…`
                  : "授权"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </PageShell>
  );
}
