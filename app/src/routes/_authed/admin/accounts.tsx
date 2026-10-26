import { IconDots, IconKey, IconLink, IconLock, IconPlayerPause, IconPlayerPlay, IconPlus, IconTrash, IconUser, IconUserPlus, IconUserShield } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageEmpty, PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard, ListRow } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import {
  accountKeys,
  accountsQueryOptions,
  createAccount,
  createInvite,
  deleteAccount,
  expiresText,
  type GatewayAccount,
  type GatewayInvite,
  lastSeenText,
  resetAccount,
  revokeInvite,
  setAccountDisabled,
  setAccountPassword,
  setAccountRole,
  setInvitesEnabled,
} from "@/lib/accounts";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/admin/accounts")({
  // CB-096：多用户与管理员账号管理默认开启；仅当显式配置 CHISABOT_ACCOUNTS_UI=0 时隐藏。
  beforeLoad: async ({ context }) => {
    const capabilities = await context.queryClient.ensureQueryData(deploymentCapabilitiesQueryOptions()).catch(() => null);
    if (capabilities?.accountsUi === false) throw redirect({ to: "/settings", replace: true });
  },
  component: AccountsPage,
});

/**
 * 设置 → 管理 → 账号（CB-040 / CB-096，DESIGN.md §65）：多用户管理与管理员账户体系。
 * 支持直接创建账号（普通成员 / 管理员）、生成一次性邀请链接、角色升降级、直接改密或发重置链接、停用与恢复。
 * 每个账号的机器人、对话、个人记忆、密钥、设备独立隔离；管理员统一配置的公共知识库、全局技能与默认 MCP 全员共享。
 */
function AccountsPage() {
  const list = useQuery(accountsQueryOptions());
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<GatewayAccount | null>(null);
  const [link, setLink] = useState<{ title: string; url: string; expiresAt: number } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: accountKeys.all });

  async function toggle(account: GatewayAccount) {
    if (!account.disabled) {
      const ok = await confirmDialog({
        title: `停用「${account.displayName}」？`,
        description: "停用后他立刻退出所有设备（网页、PC、手机），也不能再登录。他的机器人和数据都保留，随时可以恢复。",
        confirmLabel: "停用",
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await setAccountDisabled(account.id, !account.disabled);
      await refresh();
      toast.success(account.disabled ? `已恢复「${account.displayName}」` : `已停用「${account.displayName}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  }
  async function toggleRole(account: GatewayAccount) {
    const nextRole = account.role === "admin" ? "user" : "admin";
    const ok = await confirmDialog({
      title: nextRole === "admin" ? `将「${account.displayName}」设为管理员？` : `将「${account.displayName}」改为普通成员？`,
      description:
        nextRole === "admin"
          ? "管理员可以管理所有账号、模型、公共知识库、全局技能和插件与 MCP 配置。"
          : "改为普通成员后，他将不再拥有后台管理权限，但自己的机器人、对话和数据不受影响。",
      confirmLabel: nextRole === "admin" ? "设为管理员" : "改为普通成员",
    });
    if (!ok) return;
    try {
      await setAccountRole(account.id, nextRole);
      await refresh();
      toast.success(nextRole === "admin" ? `已将「${account.displayName}」设为管理员` : `已将「${account.displayName}」改为普通成员`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  }
  async function reset(account: GatewayAccount) {
    const ok = await confirmDialog({
      title: `给「${account.displayName}」重置密码？`,
      description: "会生成一个 24 小时内有效的链接，发给他，他打开后设新密码；设好后旧密码和所有已登录的设备都会失效。",
      confirmLabel: "生成链接",
    });
    if (!ok) return;
    try {
      const invite = await resetAccount(account.id);
      await refresh();
      setLink({ title: `「${account.displayName}」的重置密码链接`, url: invite.url, expiresAt: invite.expiresAt });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  }
  async function remove(account: GatewayAccount) {
    const ok = await confirmDialog({
      title: `删除账号「${account.displayName}」？`,
      description: "他会立刻退出、不能再登录，账号名可以重新使用。他在 ChisaBot 里的机器人和对话不会被删除（只是没人能再登录看到）。不能撤销。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAccount(account.id);
      await refresh();
      toast.success(`已删除「${account.displayName}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  }
  async function revoke(invite: GatewayInvite) {
    try {
      await revokeInvite(invite.id);
      await refresh();
      toast.success("链接已作废");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  }

  const data = list.data;
  const accounts = data?.available ? data.accounts : [];
  const invites = data?.available ? data.invites : [];
  const invitesEnabled = data?.available ? data.invitesEnabled : false;
  const nameOf = (id: string | null) => accounts.find((a) => a.id === id)?.displayName ?? "账号";
  return (
    <>
      <CreateAccountDialog
        invitesEnabled={invitesEnabled}
        onCreated={(account) => {
          void refresh();
          setCreateOpen(false);
          toast.success(`已创建${account.role === "admin" ? "管理员" : "成员"}账号「${account.displayName}」`);
        }}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
      <InviteDialog
        invitesEnabled={invitesEnabled}
        onCreated={(invite) => {
          void refresh();
          setInviteOpen(false);
          setLink({ title: invite.role === "admin" ? "管理员邀请链接" : "邀请链接", url: invite.url, expiresAt: invite.expiresAt });
        }}
        onOpenChange={setInviteOpen}
        open={inviteOpen}
      />
      <PasswordDialog
        account={passwordTarget}
        onOpenChange={(open) => (open ? null : setPasswordTarget(null))}
        onSaved={(account) => {
          void refresh();
          setPasswordTarget(null);
          toast.success(`已修改「${account.displayName}」的密码`);
        }}
      />
      <LinkDialog link={link} onOpenChange={(open) => (open ? null : setLink(null))} />
      <PageShell
        action={
          data?.available ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setCreateOpen(true)} size="sm" variant="outline">
                <IconUserPlus />
                {"新建账号"}
              </Button>
              <Button onClick={() => setInviteOpen(true)} size="sm">
                <IconPlus />
                {"邀请成员"}
              </Button>
            </div>
          ) : null
        }
        description="管理实例中的所有用户与管理员账号：支持直接新建账号或发送一次性邀请链接。每个账号的机器人、对话、个人记忆、密钥与设备彼此隔离；管理员在后台配置的公共知识库、全局技能与默认 MCP 可供全员共享。"
        title="账号"
      >
        {list.isPending ? (
          <PageSkeleton rows={2} />
        ) : list.isError ? (
          <ErrorCard
            action={
              <Button className="mt-2" onClick={() => void list.refetch()} size="sm" variant="outline">
                {"重试"}
              </Button>
            }
            description={list.error.message}
            title="账号列表暂时无法读取"
          />
        ) : !data?.available ? (
          <PageEmpty>{data?.reason ?? "不可用"}</PageEmpty>
        ) : (
          <>
            <PageSection title={`账号 · ${accounts.length}`}>
              <Card className="mem-card">
                {accounts.map((account) => (
                  <div className="im-row" key={account.id}>
                    <div className="im-row-main">
                      <ListRow
                        icon={
                          <span className="mem-ico is-project">
                            {account.role === "admin" ? <IconUserShield className="size-5" /> : <IconUser className="size-5" />}
                          </span>
                        }
                        sub={
                          <>
                            <span className="device-row-meta">
                              <span className="skill-slug">{account.username}</span>
                              <span className="device-cap-chip"><T>{account.role === "admin" ? "管理员" : "普通成员"}</T></span>
                              {account.disabled ? <span className="device-cap-chip is-off"><T>{"已停用"}</T></span> : null}
                              {account.id === data.me ? <span className="device-cap-chip"><T>{"你"}</T></span> : null}
                            </span>
                            <span className="mem-by">{account.builtin ? "内置管理员 · 在服务器配置里改密码" : lastSeenText(account.lastLoginAt)}</span>
                          </>
                        }
                        title={account.displayName}
                      />
                    </div>
                    {account.builtin ? null : (
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<button aria-label={`「${account.displayName}」的更多操作`} className="device-row-more" title={"更多操作"} type="button" />}>
                          <IconDots className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="glass-pop w-[210px] p-1.5">
                          <DropdownMenuItem className="glass-mi" onClick={() => setPasswordTarget(account)}>
                            <IconLock className="size-[18px] shrink-0 opacity-80" />
                            <span className="min-w-0 flex-1">{"直接修改密码…"}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem className="glass-mi" onClick={() => void reset(account)}>
                            <IconKey className="size-[18px] shrink-0 opacity-80" />
                            <span className="min-w-0 flex-1">{"重置密码链接…"}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem className="glass-mi" onClick={() => void toggleRole(account)}>
                            {account.role === "admin" ? <IconUser className="size-[18px] shrink-0 opacity-80" /> : <IconUserShield className="size-[18px] shrink-0 opacity-80" />}
                            <span className="min-w-0 flex-1">{account.role === "admin" ? "改为普通成员…" : "设为管理员…"}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem className="glass-mi" onClick={() => void toggle(account)}>
                            {account.disabled ? <IconPlayerPlay className="size-[18px] shrink-0 opacity-80" /> : <IconPlayerPause className="size-[18px] shrink-0 opacity-80" />}
                            <span className="min-w-0 flex-1">{account.disabled ? "恢复" : "停用…"}</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="glass-sep" />
                          <DropdownMenuItem className="glass-mi is-danger" onClick={() => void remove(account)}>
                            <IconTrash className="size-[18px] shrink-0 opacity-80" />
                            <span className="min-w-0 flex-1">{"删除账号…"}</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                ))}
              </Card>
            </PageSection>
            <PageSection description="链接只能用一次，过期自动失效。还没用的可以在这里作废。" title={`未使用的链接 · ${invites.length}`}>
              {invites.length ? (
                <Card className="mem-card">
                  {invites.map((invite) => (
                    <div className="im-row" key={invite.id}>
                      <div className="im-row-main">
                        <ListRow
                          icon={
                            <span className="mem-ico">
                              <IconLink className="size-5" />
                            </span>
                          }
                          sub={<span className="mem-by">{expiresText(invite.expiresAt)}</span>}
                          title={
                            invite.kind === "reset"
                              ? `重置密码 · ${nameOf(invite.accountId)}`
                              : `${invite.role === "admin" ? "邀请管理员" : "邀请成员"}${invite.note ? ` · ${invite.note}` : ""}`
                          }
                        />
                      </div>
                      <Button onClick={() => void revoke(invite)} size="sm" variant="ghost">
                        {"作废"}
                      </Button>
                    </div>
                  ))}
                </Card>
              ) : (
                <PageEmpty>{"没有未使用的链接。"}</PageEmpty>
              )}
            </PageSection>
          </>
        )}
      </PageShell>
    </>
  );
}

function CreateAccountDialog({
  open,
  onOpenChange,
  invitesEnabled,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invitesEnabled: boolean;
  onCreated: (account: GatewayAccount) => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const create = useAsyncAction(
    async () => {
      if (!invitesEnabled) await setInvitesEnabled(true);
      const account = await createAccount({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        password,
        role,
      });
      window.setTimeout(() => onCreated(account), 300);
    },
    { errorToast: (error) => error.message },
  );
  const resetCreate = create.reset;
  useEffect(() => {
    if (!open) return;
    setUsername("");
    setDisplayName("");
    setPassword("");
    setRole("user");
    resetCreate();
  }, [open, resetCreate]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{"新建账号"}</DialogTitle>
          <DialogDescription>{"直接为团队成员或管理员创建登录账号。创建后对方即可使用账号名与密码登录。"}</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (create.state !== "pending") void create.run();
          }}
        >
          <DialogBody className="im-form mt-2">
            <label className="im-field" htmlFor="create-account-username">
              <span className="im-field-l">
                {"账号名"}
                <span className="im-req">{"必填，2–32 个字符"}</span>
              </span>
              <Input
                autoComplete="off"
                id="create-account-username"
                maxLength={32}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={"例如：xiaoming"}
                required
                value={username}
              />
            </label>
            <label className="im-field" htmlFor="create-account-display-name">
              <span className="im-field-l">
                {"显示名称"}
                <span className="im-req">{"可选，留空同账号名"}</span>
              </span>
              <Input
                autoComplete="off"
                id="create-account-display-name"
                maxLength={32}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={"例如：小明"}
                value={displayName}
              />
            </label>
            <label className="im-field" htmlFor="create-account-password">
              <span className="im-field-l">
                {"初始密码"}
                <span className="im-req">{"必填，至少 8 位"}</span>
              </span>
              <Input
                autoComplete="new-password"
                id="create-account-password"
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={"至少 8 位密码"}
                required
                type="password"
                value={password}
              />
            </label>
            <div className="im-field">
              <span className="im-field-l">{"角色权限"}</span>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["user", "普通成员"],
                    ["admin", "管理员"],
                  ] as const
                ).map(([value, label]) => (
                  <Button key={value} onClick={() => setRole(value)} size="sm" type="button" variant={role === value ? "default" : "outline"}>
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button disabled={!username.trim() || password.length < 8} feedback="create" state={create.state} type="submit">
              {"创建账号"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({
  account,
  onOpenChange,
  onSaved,
}: {
  account: GatewayAccount | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (account: GatewayAccount) => void;
}) {
  const [password, setPassword] = useState("");
  const save = useAsyncAction(
    async () => {
      if (!account) return;
      const updated = await setAccountPassword(account.id, password);
      window.setTimeout(() => onSaved(updated), 300);
    },
    { errorToast: (error) => error.message },
  );
  const resetSave = save.reset;
  useEffect(() => {
    if (!account) return;
    setPassword("");
    resetSave();
  }, [account, resetSave]);
  return (
    <Dialog onOpenChange={onOpenChange} open={!!account}>
      <DialogContent className="im-dialog max-w-md">
        <DialogHeader>
          <DialogTitle>{account ? `修改「${account.displayName}」的密码` : "修改密码"}</DialogTitle>
          <DialogDescription>{"直接为该账号设置新密码。保存后，该账号在所有已登录设备上的会话将立即失效。"}</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (save.state !== "pending") void save.run();
          }}
        >
          <DialogBody className="im-form mt-2">
            <label className="im-field" htmlFor="account-new-password">
              <span className="im-field-l">
                {"新密码"}
                <span className="im-req">{"至少 8 位"}</span>
              </span>
              <Input
                autoComplete="new-password"
                id="account-new-password"
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={"输入新密码（至少 8 位）"}
                required
                type="password"
                value={password}
              />
            </label>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button disabled={password.length < 8} feedback="save" state={save.state} type="submit">
              {"保存密码"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  invitesEnabled,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invitesEnabled: boolean;
  onCreated: (invite: { url: string; expiresAt: number; role?: "admin" | "user" }) => void;
}) {
  const [note, setNote] = useState("");
  const [hours, setHours] = useState(72);
  const [role, setRole] = useState<"user" | "admin">("user");
  const create = useAsyncAction(
    async () => {
      if (!invitesEnabled) await setInvitesEnabled(true);
      const invite = await createInvite({ note: note.trim() || undefined, hours, role });
      window.setTimeout(() => onCreated(invite), 400);
    },
    { errorToast: (error) => error.message },
  );
  const resetCreate = create.reset;
  useEffect(() => {
    if (!open) return;
    setNote("");
    setHours(72);
    setRole("user");
    resetCreate();
  }, [open, resetCreate]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{"邀请成员"}</DialogTitle>
          <DialogDescription>{"生成一个一次性链接发给对方。他打开后自己设账号名和密码，登录后会有一个自己的「助手」机器人。"}</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (create.state !== "pending") void create.run();
          }}
        >
          <DialogBody className="im-form mt-2">
            <label className="im-field" htmlFor="invite-note">
              <span className="im-field-l">
                {"备注"}
                <span className="im-req">{"可选，只有你看得到"}</span>
              </span>
              <Input id="invite-note" maxLength={32} onChange={(event) => setNote(event.target.value)} placeholder={"例如：小明"} value={note} />
            </label>
            <div className="im-field">
              <span className="im-field-l">{"角色权限"}</span>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["user", "普通成员"],
                    ["admin", "管理员"],
                  ] as const
                ).map(([value, label]) => (
                  <Button key={value} onClick={() => setRole(value)} size="sm" type="button" variant={role === value ? "default" : "outline"}>
                    {label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="im-field">
              <span className="im-field-l">{"有效期"}</span>
              <div className="flex flex-wrap gap-2">
                {[
                  [24, "1 天"],
                  [72, "3 天"],
                  [168, "7 天"],
                ].map(([value, label]) => (
                  <Button key={value} onClick={() => setHours(value as number)} size="sm" type="button" variant={hours === value ? "default" : "outline"}>
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button feedback="create" state={create.state} type="submit">
              {"生成链接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LinkDialog({ link, onOpenChange }: { link: { title: string; url: string; expiresAt: number } | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(link)}>
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{link?.title ?? ""}</DialogTitle>
          <DialogDescription>{`复制下面的链接发给他（微信、QQ 都行）。只能用一次，${link ? expiresText(link.expiresAt) : ""}。关掉这个窗口后就看不到完整链接了。`}</DialogDescription>
        </DialogHeader>
        <DialogBody className="im-form mt-2">
          <Input aria-label={"链接"} className="font-mono" onFocus={(event) => event.currentTarget.select()} readOnly value={link?.url ?? ""} />
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {"完成"}
          </Button>
          <CopyButton value={link?.url ?? ""}>{"复制链接"}</CopyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
