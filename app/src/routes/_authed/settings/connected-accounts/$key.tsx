import { IconArrowUpRight, IconChevronDown } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One service, and whether a Bot may read it as you.
 *
 * Its own page rather than a switch on the list, because what a connector needs from a person is not
 * fixed. Drive needs one consent and nothing else; a vendor that scopes access per workspace, or per
 * folder, or asks which of several accounts to use, needs somewhere to ask. This is that somewhere,
 * before there is anything to put in it.
 */
export const Route = createFileRoute(
  "/_authed/settings/connected-accounts/$key",
)({ component: RouteComponent });

function RouteComponent() {
  const { key } = useParams({
    from: "/_authed/settings/connected-accounts/$key",
  });
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [notice, setNotice] = useState<string | null>(null);

  const connect = useMutation({
    ...connectAccountMutationOptions(),
    onError: (thrown: Error) => setNotice(thrown.message),
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be shown
     * to you in your own browser; there is deliberately nothing here that could complete it for you.
     */
    onSuccess: (authorizationUrl) => {
      /*
       * A 200 with no url on it is not a url to follow. Every press that reaches here is on a
       * `user-oauth` catalogue entry, whose half of that route always mints one or refuses — so
       * this is the server having answered something this page does not understand, and saying so
       * is the only honest thing left. Assigning it navigated to a page called `undefined` on this
       * deployment's own origin. See `connectAccountMutationOptions`.
       */
      if (authorizationUrl === null) {
        setNotice(
          "此部署回答时没有同意链接，因此没有地方发送给你且未连接任何内容。重试，如果持续存在请告诉管理员。",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });

  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const server = (plugins.data?.servers ?? []).find((s) => s.id === key);
  const enabled = server !== undefined;
  const connection = (connections.data?.connections ?? []).find(
    (row) => row.serverId === key,
  );
  /*
   * Asked of the row rather than the catalogue, because a brokered app has no catalogue entry at
   * all: the deployment recorded how it is reached when the app was enabled, and that record is the
   * only thing here that knows.
   */
  const brokered = server?.provenance === "composio";

  /* Everything the brokered row below reads and does. See `brokered-account-row.tsx`. */
  const brokeredAccount = useBrokeredAccount({
    authScheme: server?.authScheme ?? null,
    brokered,
    configured: plugins.data?.composioConfigured ?? false,
    recorded: connection !== undefined,
    report: setNotice,
    returnTo: "settings",
    serverId: key,
    /*
     * Off the same row `recorded` is read from, and absent where you have never connected this app:
     * with no row there is nothing that could have been checked, which is what the server's own
     * columns default to. The three are optional on the type because that endpoint concatenates two
     * reads and only a brokered row carries them.
     */
    verified: connection?.verified ?? false,
    verifiedAt: connection?.verifiedAt ?? null,
    /*
     * PASSED THROUGH UNFLATTENED, unlike the two above. Their fallbacks are the server's own column
     * defaults, so an absent field and a recorded one mean the same thing; this one's null is the
     * server saying the last check of this key spent nothing, which is a different fact from having
     * been told nothing. Collapsing the two would hand the row a verdict on every page load that
     * has no record behind it.
     */
    probe: connection?.probe,
    /*
     * AND THIS ONE IS FLATTENED AGAIN, because it is a gate and not a verdict. `probe` is the
     * record of what the last check spent and this is whether the app has anything to check with
     * today — two questions, which is why they are two fields: gating the Re-check button on the
     * record left a key nothing was ever spent on unable to ever have anything spent on it. A
     * missing gate and a closed gate are the same gate, so absent collapses to false here where a
     * missing verdict above may not collapse to a null one.
     */
    checkable: connection?.checkable ?? false,
  });

  /*
   * BOTH READS ARE WAITED FOR, BECAUSE EVERY FACT THE BROKERED ROW BELOW DRAWS COMES FROM THE SECOND
   * ONE. `recorded`, `verified`, `verifiedAt`, `probe` and `checkable` are all off `connection`,
   * and this gated on `plugins` alone — so a connections read still in flight drew the row with the
   * whole of its state defaulted to "you have never connected this".
   */
  if (plugins.isPending || connections.isPending) {
    return <PageShell title={"账号"}>{null}</PageShell>;
  }

  const back = {
    label: "已连接账号",
    linkProps: { to: "/settings/connected-accounts" as const },
  };

  /*
   * AND A CONNECTIONS READ THAT FAILED IS SAID RATHER THAN DEFAULTED, WHICH IS WHAT THIS PAGE DID
   * WITH IT.
   *
   * Nothing read `connections.error`, so a 500 from `/api/plugins/connections` left `connection`
   * undefined and the row was handed `recorded: false, verified: false, probe: undefined,
   * checkable: false` — a connection nobody has made. For a brokered key app whose last check did
   * not come back clean, that is the exact state this whole feature exists to keep visible: the page
   * dropped the sentence, hid Disconnect AND Re-check, and drew Connect instead. Pressing it opens
   * the form and the route refuses the submission — "you already have an account, disconnect it
   * first" — so the only two controls that could end the state are the two the page just withdrew,
   * and no error text appears anywhere, because `connect.onError` is this route's only error branch.
   *
   * SAID BEFORE THE ROW RATHER THAN INSTEAD OF IT, and the row is not drawn at all: a row whose
   * entire content is connection state has nothing honest to say when that state could not be read.
   */
  if (connections.error) {
    return (
      <PageShell backButton={back} title={server?.title ?? key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          {
            "账户连接状态无法加载，因此未显示任何内容。可能存在问题。重新加载页面，如果仍然存在，请告诉管理员。"
          }
        </p>
      </PageShell>
    );
  }

  /*
   * The same for the plugin list. Every branch below decides what this connector is from it, and
   * without it they concluded there is none: "This is not a service you connect for yourself",
   * about a connector this person may hold right now.
   */
  if (!plugins.data) {
    return (
      <PageShell backButton={back} title={key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          {
            "此连接器无法加载，因此这里不显示任何关于它的内容，而是可能出错的内容。重新加载页面，如果持续存在，请告诉管理员。"
          }
        </p>
      </PageShell>
    );
  }

  /*
   * A brokered app, before the catalogue is consulted at all.
   *
   * It has no catalogue entry, so the branch below would find no `entry`, decide the deployment has
   * no connector by that name, and say so under the raw id — about the one connector the list on the
   * way in demonstrably drew a row for. Falling through to the `user-oauth` branch instead is no
   * better: its title and summary are the catalogue's, and there is none.
   */
  if (brokered && server) {
    /* Bound once because the row below is told it twice — once inside the whole disconnected
       sentence and once on its own — and two copies of it would drift. */
    const reassurance = "还没有机器人能以你的身份读它。";

    return (
      <PageShell
        backButton={back}
        description={
          "通过 Composio 到达，它持有账户，所以机器人只看到你能看到的内容。"
        }
        title={server.title}
      >
        {notice ? (
          <p className="text-destructive text-sm" role="alert">
            {notice}
          </p>
        ) : null}

        {/* One decision, so no heading: it would only repeat the row's own title. */}
        <PageSection>
          <PageRows className="mt-0">
            <BrokeredAccountRow
              account={brokeredAccount}
              /* Said beside the button rather than after it: disconnecting ends the account at
                 Composio, so what it undoes is not the row here but the grant on your own mailbox,
                 and connecting again is a fresh consent. */
              connectedDescription={`被授予这些工具的机器人会以你的身份读 ${server.title}。断开连接会连 Composio 那边的账号一起断掉，不只是这里的这一行。`}
              disconnectedDescription={`${reassurance}点「连接」会先去 Composio，再去对方的授权页。`}
              /* What is true either way. The trip to Composio is not — an app whose key somebody
                 types never leaves this page — but which Bots can read this person's mail is the
                 whole point of the screen and holds for both kinds. */
              disconnectedReassurance={reassurance}
              title={server.title}
            />
          </PageRows>
        </PageSection>
      </PageShell>
    );
  }

  /*
   * A vendor that is not reached as a person has nothing here for anybody to decide, and one an
   * administrator has not enabled cannot be consented to — there is no OAuth client behind it. Both
   * say which it is rather than drawing a switch that cannot work.
   */
  if (entry?.auth !== "user-oauth") {
    return (
      <PageShell
        backButton={back}
        description={entry ? "这项服务由管理员统一连接，你这里不用做什么。" : undefined}
        title={entry?.title ?? (key === "github" ? "GitHub" : "找不到这项连接")}
      >
        <PageEmpty>
          {entry
            ? "机器人用部署统一保存的凭据使用它，所有人都一样。"
            : key === "github"
              ? "GitHub 在「账号连接」页最上面连接（用一个 GitHub 访问令牌）。"
              : "这个链接里的服务不存在，可能已经移除了。回到「账号连接」看看能连接哪些服务。"}
        </PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={back}
      description={entry.summary}
      title={entry.title}
    >
      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      {/* One decision, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows className="mt-0">
          <Item size="sm">
            <ItemContent>
              {/* Not "Connect your account": the row is also the connected state, and a title has to
                  read for both. */}
              <ItemTitle>{"你的账号"}</ItemTitle>
              <ItemDescription>
                {!enabled
                  ? "管理员尚未启用此连接器，因此目前没有可连接的内容。"
                  : connection
                    ? "授予其工具的机器人将此读取为你的，并只看到你能看到的内容。"
                    : "还没有连接，机器人不能以你的身份读取这里的内容。点连接会跳到服务商页面确认授权。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {connection ? (
                /*
                 * A state and a menu, not a switch. Connected is a fact about a grant that lives at
                 * the vendor, and withdrawing it is a deliberate act rather than the other half of a
                 * position — so it is named in a menu instead of being whatever happens when
                 * something slides back.
                 */
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button size="sm" type="button" variant="outline">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-500"
                        />
                        {"已连接"}
                        <IconChevronDown />
                      </Button>
                    }
                  />
                  {/*
                   * `w-auto`, because the default is `w-(--anchor-width)` — the width of the trigger,
                   * which here is a small "Connected" button. Left alone, the one item inside wraps
                   * onto three lines and a destructive action becomes hard to read at the moment it
                   * most needs to be legible.
                   */}
                  <DropdownMenuContent align="end" className="w-auto">
                    <DropdownMenuItem
                      onClick={() =>
                        /*
                         * NOT BUILT YET, and it says so rather than appearing to work.
                         *
                         * Withdrawing is three acts — revoke at the vendor, revoke the vault
                         * credential, delete the row — and none exist. An item that closed the menu
                         * and changed nothing would report that access had been withdrawn when it
                         * had not, which is the one outcome worse than not offering it.
                         */
                        setNotice(
                          `这里还不能断开连接。请在你的 ${entry.vendor} 账号的「第三方访问」设置里撤销授权，撤销后这里立刻读不到任何内容。`,
                        )
                      }
                      className="whitespace-nowrap"
                      variant="destructive"
                    >
                      {"断开你的"}
                      {entry.title} {"账号"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                /*
                 * The arrow says this leaves OpenBot. It does: the next thing on screen is the
                 * vendor's own consent page, and a control that navigates away should look like one.
                 */
                <Button
                  disabled={!enabled || connect.isPending}
                  onClick={() => {
                    setNotice(null);
                    connect.mutate(key);
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
        </PageRows>
      </PageSection>

      {connection ? (
        <PageSection
          description={
            "服务商记录的、你实际同意的权限（授权页只部分同意时，会少于申请的权限）。"
          }
          title={"访问"}
        >
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>{"已授权"}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {connection.scope || "供应商未命名范围。"}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>{"已连接"}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {new Date(connection.connectedAt).toLocaleString("zh-CN")}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
