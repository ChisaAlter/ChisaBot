import { IconBrandGithub, IconDots, IconExternalLink, IconKey, IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { GITHUB_NEW_TOKEN_URL, type GithubConnectionView } from "../../../../shared/github";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard, ListRow } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import { checkGithub, connectGithub, disconnectGithub, githubKeys, githubQueryOptions } from "@/lib/github";
import { agoText } from "@/lib/im";

const KIND_TEXT: Record<GithubConnectionView["tokenKind"], string> = {
  "fine-grained": "Fine-grained 令牌",
  classic: "Classic 令牌",
  oauth: "OAuth 令牌",
  other: "令牌",
};

/**
 * 设置 → 账号连接 → GitHub（DESIGN.md §53）。
 * 连接 = 贴一个 GitHub 令牌：服务器先用它读一次 /user，成功才加密存进保险箱（保留名 github）。值从不回显。
 */
export function GithubConnectionSection() {
  const status = useQuery(githubQueryOptions());
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const connection = status.data ?? null;
  const check = useAsyncAction(
    async () => {
      const next = await checkGithub();
      queryClient.setQueryData(githubKeys.all, next);
      if (next.status === "invalid") throw new Error("令牌已失效，请更换");
    },
    { errorToast: (error) => error.message },
  );
  async function disconnect() {
    const ok = await confirmDialog({
      title: "断开 GitHub？",
      description: "令牌会从服务器上删除，机器人不能再读写你的 GitHub。GitHub 那边的令牌不会自动作废，不再用的话请到 GitHub 设置里删除。",
      confirmLabel: "断开",
      destructive: true,
    });
    if (!ok) return;
    try {
      await disconnectGithub();
      queryClient.setQueryData(githubKeys.all, null);
      await queryClient.invalidateQueries({ queryKey: ["vault"] });
      toast.success("已断开 GitHub");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "断开失败");
    }
  }

  return (
    <PageSection description="机器人可以读你的仓库、Issue、PR 和文件；建 Issue、评论、建 PR 之前都会在聊天里先问你。" title="GitHub">
      <GithubTokenDialog onOpenChange={setOpen} open={open} replacing={Boolean(connection)} />
      {status.isPending ? (
        <PageSkeleton rows={1} />
      ) : status.isError ? (
        <ErrorCard
          action={
            <Button className="mt-2" onClick={() => void status.refetch()} size="sm" variant="outline">
              {"重试"}
            </Button>
          }
          description={status.error.message}
          title="GitHub 连接暂时无法读取"
        />
      ) : connection ? (
        <Card className="mem-card" data-testid="github-connection">
          <div className="im-row">
            <div className="im-row-main is-static">
              <ListRow
                icon={
                  connection.avatarUrl ? (
                    <img alt="" className="gh-avatar" height={40} referrerPolicy="no-referrer" src={connection.avatarUrl} width={40} />
                  ) : (
                    <span className="gh-mark">
                      <IconBrandGithub className="size-5" />
                    </span>
                  )
                }
                sub={
                  <>
                    <span className="device-row-meta">
                      <span className={connection.status === "ok" ? "gh-state is-ok" : "gh-state is-bad"}>{connection.status === "ok" ? "已连接" : "令牌已失效"}</span>
                      <span className="device-cap-chip"><T>{KIND_TEXT[connection.tokenKind]}</T></span>
                      {connection.hint ? <span className="device-cap-chip"><T>{`末四位 ${connection.hint}`}</T></span> : null}
                    </span>
                    <span className="mem-by">{`${agoText(connection.checkedAt)}检查过 · 写操作每次都先问你`}</span>
                  </>
                }
                title={
                  <>
                    {connection.name || connection.login}
                    <span className="gh-login">{`@${connection.login}`}</span>
                  </>
                }
              />
            </div>
            {connection.status === "invalid" ? (
              <Button onClick={() => setOpen(true)} size="sm">
                {"更换令牌"}
              </Button>
            ) : (
              <Button className="gh-check" feedback={{ pending: "检查中…", success: "正常", error: "检查失败" }} onClick={() => void check.run()} size="sm" state={check.state} variant="outline">
                {"检查"}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<button aria-label="GitHub 连接的更多操作" className="device-row-more" title="更多操作" type="button" />}>
                <IconDots className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-pop w-[200px] p-1.5">
                <DropdownMenuItem className="glass-mi" onClick={() => void check.run()}>
                  <IconRefresh className="size-[18px] shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">{"检查令牌"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem className="glass-mi" onClick={() => setOpen(true)}>
                  <IconKey className="size-[18px] shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">{"更换令牌…"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem className="glass-mi" onClick={() => window.open(connection.htmlUrl, "_blank", "noopener,noreferrer")}>
                  <IconExternalLink className="size-[18px] shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">{"在 GitHub 打开"}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator className="glass-sep" />
                <DropdownMenuItem className="glass-mi is-danger" onClick={() => void disconnect()}>
                  <IconPlugConnectedX className="size-[18px] shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">{"断开连接…"}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Card>
      ) : (
        <Card className="mem-card" data-testid="github-connection">
          <div className="im-row">
            <div className="im-row-main is-static">
              <ListRow
                icon={
                  <span className="gh-mark">
                    <IconBrandGithub className="size-5" />
                  </span>
                }
                sub="未连接 · 用一个 GitHub 访问令牌连接，加密保存，机器人看不到"
                title="GitHub"
              />
            </div>
            <Button onClick={() => setOpen(true)} size="sm">
              {"连接"}
            </Button>
          </div>
        </Card>
      )}
    </PageSection>
  );
}

function GithubTokenDialog({ open, replacing, onOpenChange }: { open: boolean; replacing: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const save = useAsyncAction(
    async () => {
      const next = await connectGithub(token.trim());
      setToken("");
      queryClient.setQueryData(githubKeys.all, next);
      await queryClient.invalidateQueries({ queryKey: ["vault"] });
      window.setTimeout(() => onOpenChange(false), 700);
    },
    { errorToast: (error) => error.message },
  );
  const resetSave = save.reset;
  useEffect(() => {
    if (!open) return;
    setToken("");
    resetSave();
  }, [open, resetSave]);
  const valid = token.trim().length >= 20 && !/\s/.test(token.trim());
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{replacing ? "更换 GitHub 令牌" : "连接 GitHub"}</DialogTitle>
          <DialogDescription>{"令牌只发往 api.github.com，加密保存；保存后谁也看不到，包括你自己。"}</DialogDescription>
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
            <ol className="gh-steps">
              <li>
                <span className="gh-step-n">{"1"}</span>
                <div className="min-w-0 flex-1">
                  <div className="gh-step-t">{"在 GitHub 创建令牌"}</div>
                  <div className="gh-step-s">{"已预填名称、90 天有效期和 Contents · Issues · Pull requests 读写权限。在「Repository access」里选要给机器人的仓库，然后点 Generate token。"}</div>
                  <a className="gh-step-link" href={GITHUB_NEW_TOKEN_URL} rel="noopener noreferrer" target="_blank">
                    <IconBrandGithub className="size-4" />
                    {"打开 GitHub 创建令牌"}
                    <IconExternalLink className="size-3.5 opacity-70" />
                  </a>
                </div>
              </li>
              <li>
                <span className="gh-step-n">{"2"}</span>
                <label className="im-field min-w-0 flex-1" htmlFor="github-token">
                  <span className="gh-step-t">{"粘贴令牌"}</span>
                  <Input
                    autoComplete="new-password"
                    className="font-mono"
                    data-1p-ignore
                    id="github-token"
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="github_pat_…"
                    spellCheck={false}
                    type="password"
                    value={token}
                  />
                  <span className="im-field-h">{"也可以用 Classic 令牌（勾 repo），但 Fine-grained 只开放选中的仓库，更安全。"}</span>
                </label>
              </li>
            </ol>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button disabled={!valid} feedback={{ pending: "验证中…", success: "已连接", error: "连接失败" }} state={save.state} type="submit">
              {replacing ? "更换" : "连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
