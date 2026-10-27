import { IconBrandGithub, IconDots, IconKey, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { VAULT_DOMAIN, VAULT_NAME, type VaultSecretView } from "../../../../../shared/vault";
import { PageEmpty, PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard, ListRow } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import { agoText } from "@/lib/im";
import { deleteVaultSecret, saveVaultSecret, vaultKeys, vaultQueryOptions } from "@/lib/vault";

export const Route = createFileRoute("/_authed/settings/vault")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings/connected-accounts",
      search: { tab: "api-keys" },
      replace: true,
    });
  },
  component: VaultPage,
});

export const VAULT_SECURITY_NOTE =
  "API 密钥、令牌这类机器人要用、但不该看到的东西。服务器加密保存，机器人看不到明文，只在服务器上替换进发往允许域名的请求，聊天记录里永远不会出现。";

/** 可内嵌在「账号连接 → 密钥」标签页或独立「设置 → 密钥」页中的保险箱列表（CB-095）。 */
export function VaultSection({ embedded = false }: { embedded?: boolean }) {
  const list = useQuery(vaultQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<{ open: boolean; secret: VaultSecretView | null }>({ open: false, secret: null });
  const [hidden, setHidden] = useState<string | null>(null);
  const secrets = (list.data ?? []).filter((secret) => secret.id !== hidden);
  async function remove(secret: VaultSecretView) {
    const ok = await confirmDialog({
      title: `删除「${secret.label}」？`,
      description: "删除后机器人不能再用它调用接口。值不会保留，删除不能撤销；需要时再添加一次。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    setHidden(secret.id);
    try {
      await deleteVaultSecret(secret.id);
      await queryClient.invalidateQueries({ queryKey: vaultKeys.all });
      toast.success(`已删除「${secret.label}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setHidden(null);
    }
  }

  const body = list.isPending ? (
    <PageSkeleton rows={2} />
  ) : list.isError ? (
    <ErrorCard
      action={
        <Button className="mt-2" onClick={() => void list.refetch()} size="sm" variant="outline">
          {"重试"}
        </Button>
      }
      description={list.error.message}
      title="保险箱暂时无法读取"
    />
  ) : secrets.length ? (
    <PageSection title={`我的密钥 · ${secrets.length}`}>
      <Card className="mem-card">
        {secrets.map((secret) => (
          <div className="im-row" key={secret.id}>
            <button
              className="im-row-main"
              onClick={() =>
                secret.managedBy
                  ? void navigate({
                      to:
                        secret.managedBy === "claude-proxy"
                          ? "/settings/cloud-workspace"
                          : "/settings/connected-accounts",
                    })
                  : setDialog({ open: true, secret })
              }
              title={
                secret.managedBy === "claude-proxy"
                  ? "在 云端工作区 → Claude 上游代理 里管理"
                  : secret.managedBy
                    ? "在 账号连接 → GitHub 里管理"
                    : undefined
              }
              type="button"
            >
              <ListRow
                icon={
                  <span className="mem-ico is-project">
                    {secret.managedBy ? <IconBrandGithub className="size-5" /> : <IconKey className="size-5" />}
                  </span>
                }
                sub={
                  <>
                    <span className="device-row-meta">
                      <span className="skill-slug">{`{{secret:${secret.name}}}`}</span>
                      {secret.hint ? (
                        <span className="device-cap-chip">
                          <T>{`末四位 ${secret.hint}`}</T>
                        </span>
                      ) : null}
                    </span>
                    <span className="mem-by">{`${secret.managedBy === "claude-proxy" ? "由 云端工作区 → Claude 上游代理 管理 · " : secret.managedBy ? "由 账号连接 → GitHub 管理 · " : ""}可用于 ${secret.domains.join("、")} · ${secret.lastUsedAt ? `${agoText(secret.lastUsedAt)}用过` : "还没用过"}`}</span>
                  </>
                }
                title={secret.label}
              />
            </button>
            {secret.managedBy ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      aria-label={`「${secret.label}」的更多操作`}
                      className="device-row-more"
                      title={"更多操作"}
                      type="button"
                    />
                  }
                >
                  <IconDots className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="glass-pop w-[180px] p-1.5">
                  <DropdownMenuItem className="glass-mi" onClick={() => setDialog({ open: true, secret })}>
                    <IconPencil className="size-[18px] shrink-0 opacity-80" />
                    <span className="min-w-0 flex-1">{"编辑…"}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="glass-sep" />
                  <DropdownMenuItem className="glass-mi is-danger" onClick={() => void remove(secret)}>
                    <IconTrash className="size-[18px] shrink-0 opacity-80" />
                    <span className="min-w-0 flex-1">{"删除…"}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
      </Card>
    </PageSection>
  ) : (
    <PageEmpty>{"保险箱是空的。点右上角「添加密钥」，或者等机器人需要时在聊天里填。"}</PageEmpty>
  );

  if (embedded) {
    return (
      <section aria-label="API 密钥与令牌" className="mt-8" data-testid="connected-accounts-vault">
        <SecretDialog
          onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
          open={dialog.open}
          secret={dialog.secret}
        />
        <div className="mb-3 flex items-center justify-between gap-3 px-2">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">{"API 密钥与令牌"}</h2>
            <p className="text-xs text-muted-foreground">{VAULT_SECURITY_NOTE}</p>
          </div>
          <Button onClick={() => setDialog({ open: true, secret: null })} size="sm">
            <IconPlus />
            {"添加密钥"}
          </Button>
        </div>
        {body}
      </section>
    );
  }

  return (
    <>
      <SecretDialog onOpenChange={(open) => setDialog((current) => ({ ...current, open }))} open={dialog.open} secret={dialog.secret} />
      <PageShell
        action={
          <Button onClick={() => setDialog({ open: true, secret: null })} size="sm">
            <IconPlus />
            {"添加密钥"}
          </Button>
        }
        description={`${VAULT_SECURITY_NOTE} 机器人需要时会在聊天里弹一张安全输入卡片。网站登录和 GitHub 在「账号连接」里。`}
        title="密钥"
      >
        {body}
      </PageShell>
    </>
  );
}

/** 设置 → 密钥（DESIGN.md §52）：API 密钥和令牌。值只进不出：这里也看不到，只能替换。 */
function VaultPage() {
  return <VaultSection />;
}

function SecretDialog({ open, secret, onOpenChange }: { open: boolean; secret: VaultSecretView | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", label: "", domains: "", value: "" });
  const domains = form.domains
    .split(/[\s,，、]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const domainsOk = domains.length > 0 && domains.every((d) => VAULT_DOMAIN.test(d));
  const valid = VAULT_NAME.test(form.name) && form.label.trim() && domainsOk && (secret || form.value.trim());
  const save = useAsyncAction(
    async () => {
      await saveVaultSecret({ name: form.name, label: form.label, domains, value: form.value.trim() ? form.value : null });
      setForm((current) => ({ ...current, value: "" }));
      await queryClient.invalidateQueries({ queryKey: vaultKeys.all });
      window.setTimeout(() => onOpenChange(false), 600);
    },
    { errorToast: (error) => error.message },
  );
  const resetSave = save.reset;
  useEffect(() => {
    if (!open) return;
    setForm(secret ? { name: secret.name, label: secret.label, domains: secret.domains.join(", "), value: "" } : { name: "", label: "", domains: "", value: "" });
    resetSave();
  }, [open, secret, resetSave]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{secret ? `编辑「${secret.label}」` : "添加密钥"}</DialogTitle>
          <DialogDescription>{"值保存后谁也看不到，包括你自己；要换就填一个新值。"}</DialogDescription>
        </DialogHeader>
        <form
          autoComplete="off"
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && save.state !== "pending") void save.run();
          }}
        >
          <DialogBody className="im-form mt-2">
            <div className="im-grid">
              <label className="im-field" htmlFor="vault-label">
                <span className="im-field-l">
                  {"名称"}
                  <span className="im-req">{"必填"}</span>
                </span>
                <Input id="vault-label" maxLength={60} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder={"OpenAI API 密钥"} value={form.label} />
              </label>
              <label className="im-field" htmlFor="vault-name">
                <span className="im-field-l">
                  {"引用名"}
                  <span className="im-req">{secret ? "不能改" : "小写字母、数字、_ -"}</span>
                </span>
                <Input
                  className="font-mono"
                  disabled={Boolean(secret)}
                  id="vault-name"
                  maxLength={40}
                  onChange={(event) => setForm({ ...form, name: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "_") })}
                  placeholder={"openai_key"}
                  value={form.name}
                />
              </label>
            </div>
            <label className="im-field" htmlFor="vault-domains">
              <span className="im-field-l">
                {"只允许发往"}
                <span className="im-req">{"域名，多个用逗号隔开；子域名写 *.example.com"}</span>
              </span>
              <Input className="font-mono" id="vault-domains" onChange={(event) => setForm({ ...form, domains: event.target.value })} placeholder={"api.openai.com"} value={form.domains} />
              {form.domains && !domainsOk ? <span className="im-field-h">{"域名格式不对，例如 api.openai.com 或 *.example.com。"}</span> : null}
            </label>
            <label className="im-field" htmlFor="vault-value">
              <span className="im-field-l">
                {"值"}
                <span className="im-req">{secret ? "已保存，留空不改" : "必填"}</span>
              </span>
              <Input
                autoComplete="new-password"
                className="font-mono"
                data-1p-ignore
                id="vault-value"
                onChange={(event) => setForm({ ...form, value: event.target.value })}
                placeholder={secret ? `已保存${secret.hint ? `（末四位 ${secret.hint}）` : ""}` : "粘贴密钥"}
                type="password"
                value={form.value}
              />
            </label>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button disabled={!valid} feedback="save" state={save.state} type="submit">
              {"保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
