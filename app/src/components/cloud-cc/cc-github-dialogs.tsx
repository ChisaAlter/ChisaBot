import { IconBrandGithub, IconFolder, IconGitBranch, IconGitCommit, IconLock, IconSearch } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { CcWorkspaceView } from "../../../../shared/cloud-cc";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { ccApi, ccGithubQueryOptions, ccKeys, ccPushPreviewQueryOptions, ccReposQueryOptions } from "@/lib/cloud-cc";
import { client } from "@/lib/client";
import { pcSyncBridge } from "@/lib/pc-bridge";
import { CcLocalFolderPane } from "./cc-sync";
import { cn } from "@/lib/utils";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 新建工作区 → 从 GitHub（图 2 左，DESIGN.md §73.7）。网页和手机只能从 GitHub 建；电脑上的文件夹要 PC 客户端（P4）。
 * 选仓库（最近更新的在前，可搜索，也可以直接贴 owner/name 或 GitHub 地址）→ 分支（默认是仓库的默认分支）→ 名称 →
 * 「创建并克隆」按钮：克隆中… → 已创建 ✓（建好后自动开第一个会话）。没连 GitHub：引导去 设置 → 账号连接。
 */
export function CcNewWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const github = useQuery(ccGithubQueryOptions(open));
  const connected = !!github.data?.connected && !github.data.invalid;
  const repos = useQuery(ccReposQueryOptions(open && connected));
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 「电脑上的文件夹」只在 PC 客户端（0.1.11 起）里能选（§2.3）
  const canLocal = !!pcSyncBridge();
  const [src, setSrc] = useState<"github" | "local">("github");
  const [localBusy, setLocalBusy] = useState(false);
  // 「电脑上的文件夹」的按钮放进底栏这个位置（和「取消」一行、靠右，§87）
  const [localFoot, setLocalFoot] = useState<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const typed = query.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const typedRepo = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(typed) ? typed : null;
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos.data ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)).slice(0, 50);
  }, [repos.data, query]);
  const selected = repos.data?.find((r) => r.fullName === repo);
  const chosen = repo || typedRepo || "";

  const create = useAsyncAction(
    async () => {
      setError(null);
      if (!chosen) throw new Error("先选一个仓库");
      let ws: CcWorkspaceView;
      try {
        ws = await ccApi.createWorkspace({ repo: chosen, branch: branch.trim() || null, name: name.trim() || null });
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
      await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
      // 等克隆结束（这期间按钮一直是「克隆中…」；关掉对话框也没关系，左栏会显示进度）
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        await sleep(1500);
        const all = await client<CcWorkspaceView[]>("/api/claude-code/workspaces", "workspaces", { fallback: "读不到工作区" });
        queryClient.setQueryData(ccKeys.workspaces, all);
        const now = all.find((w) => w.id === ws.id);
        if (!now) throw new Error("工作区不见了");
        if (now.cloneState === "ready") {
          const session = await ccApi.createSession(now.id);
          await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
          setTimeout(() => {
            onOpenChange(false);
            void navigate({ to: "/cc/$sessionId", params: { sessionId: session.id } });
          }, 900);
          return;
        }
        if (now.cloneState === "error") {
          setError(now.cloneError ?? "克隆失败");
          throw new Error(now.cloneError ?? "克隆失败");
        }
      }
      throw new Error("克隆太久了，左栏会继续显示进度");
    },
    { errorToast: false },
  );
  const busy = create.state === "pending" || localBusy;
  // 分段选择的键盘约定（2026-10-20）：Tab 停在当前来源，方向键换来源、焦点跟随。
  const srcKeys = useSegmentedKeys<"github" | "local">({
    value: src,
    values: ["github", "local"],
    onChange: setSrc,
    disabled: busy,
  });

  return (
    <Dialog onOpenChange={(o) => (!busy || !o ? onOpenChange(o) : undefined)} open={open}>
      <DialogContent className="cc-dlg sm:max-w-[520px]" data-testid="cc-new-ws-dialog">
        <DialogHeader>
          <DialogTitle>{"新建工作区"}</DialogTitle>
          <DialogDescription>
            {src === "local"
              ? "把这台电脑上的一个文件夹传到云端（云端是主副本），之后可以一直同步。会话在自己的分支上改，「合入工作目录」后同步回电脑。"
              : canLocal
                ? "从 GitHub 克隆到云端，或者上传这台电脑上的文件夹。会话各自在 cc/… 分支上改，合入或推送都由你点。"
                : "从 GitHub 克隆到云端。会话各自在 cc/… 分支上改，合入或推送都由你点。电脑上的文件夹要在 ChisaBot PC 客户端里建。"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <div aria-label="来源" className="sg-segmented cc-src-seg" {...srcKeys.groupProps} ref={srcKeys.groupRef} role="radiogroup">
            {/* biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了 */}
            <button aria-checked={src === "github"} className="sg-segmented-item" data-testid="cc-src-github" disabled={busy} onClick={() => setSrc("github")} role="radio" tabIndex={srcKeys.itemTabIndex("github")} type="button">
              <IconBrandGithub className="size-4" />
              {"GitHub"}
            </button>
            {/* biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了 */}
            <button
              aria-checked={src === "local"}
              className="sg-segmented-item"
              data-testid="cc-src-local"
              disabled={!canLocal || busy}
              onClick={() => setSrc("local")}
              role="radio"
              tabIndex={srcKeys.itemTabIndex("local")}
              title={canLocal ? undefined : "只有 ChisaBot PC 客户端能选电脑上的文件夹"}
              type="button"
            >
              <IconFolder className="size-4" />
              {"电脑上的文件夹"}
            </button>
          </div>
          {!canLocal ? <p className="cc-src-note">{"「电脑上的文件夹」只能在 ChisaBot 电脑客户端里选"}</p> : null}
          {src === "local" ? (
            <CcLocalFolderPane footer={localFoot} onBusy={setLocalBusy} onDone={() => onOpenChange(false)} />
          ) : github.isPending ? (
            <div aria-busy className="cc-repo-skel" />
          ) : !connected ? (
            <div className="cc-gh-empty" data-testid="cc-gh-connect">
              <IconBrandGithub className="size-6 opacity-70" />
              <div className="cc-gh-empty-t">{github.data?.invalid ? "GitHub 令牌已失效" : "还没有连接 GitHub"}</div>
              <div className="cc-gh-empty-s">{"在 设置 → 账号连接 贴一个 GitHub 令牌（fine-grained，仓库权限 Contents 和 Pull requests 选「读写」）。令牌存在保险箱里，只在克隆和推送那一次交给云端节点。"}</div>
              <Button render={<Link onClick={() => onOpenChange(false)} to="/settings/connected-accounts" />} size="sm">
                {"去连接 GitHub"}
              </Button>
            </div>
          ) : (
            <>
              <label className="cc-field">
                <span className="cc-field-l">{"仓库"}</span>
                <div className="cc-search">
                  <IconSearch className="size-4 opacity-60" />
                  <input
                    aria-label="搜索仓库，或贴 owner/name"
                    data-testid="cc-repo-search"
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setRepo("");
                    }}
                    placeholder="搜索仓库，或贴 owner/name"
                    value={query}
                  />
                </div>
              </label>
              <div className="cc-repo-list" role="listbox">
                {repos.isPending ? (
                  <div aria-busy className="cc-repo-skel" />
                ) : repos.isError ? (
                  <div className="cc-rp-empty is-err">{repos.error.message}</div>
                ) : list.length === 0 ? (
                  <div className="cc-rp-empty">{typedRepo ? `用 ${typedRepo}` : "没有找到。可以直接贴 owner/name。"}</div>
                ) : (
                  list.map((r) => (
                    <button
                      aria-selected={r.fullName === repo}
                      className="cc-repo"
                      data-testid="cc-repo"
                      key={r.fullName}
                      onClick={() => {
                        setRepo(r.fullName);
                        setBranch("");
                        setError(null);
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="cc-repo-n">
                        {r.fullName}
                        {r.private ? <IconLock aria-label="私有" className="size-3.5 opacity-60" /> : null}
                      </span>
                      {r.description ? <span className="cc-repo-d">{r.description}</span> : null}
                    </button>
                  ))
                )}
              </div>
              <div className="cc-field-row">
                <label className="cc-field">
                  <span className="cc-field-l">{"分支"}</span>
                  <Input data-testid="cc-branch" onChange={(e) => setBranch(e.target.value)} placeholder={selected?.defaultBranch ?? "默认分支"} value={branch} />
                </label>
                <label className="cc-field">
                  <span className="cc-field-l">{"名称"}</span>
                  <Input data-testid="cc-ws-name" onChange={(e) => setName(e.target.value)} placeholder={(chosen.split("/")[1] ?? "") || "和仓库同名"} value={name} />
                </label>
              </div>
              {error ? (
                <p className="cc-form-err" data-testid="cc-new-ws-error" role="alert">
                  {error}
                </p>
              ) : null}
            </>
          )}
        </DialogBody>
        <DialogFooter className="mt-6">
          <Button disabled={busy} onClick={() => onOpenChange(false)} variant="outline">
            {"取消"}
          </Button>
          {src === "github" ? <Button
            data-testid="cc-create-ws"
            disabled={!connected || !chosen}
            feedback={{ pending: "克隆中…", success: "已创建", error: "没有建成" }}
            onClick={() => void create.run()}
            state={create.state}
          >
            {"创建并克隆"}
          </Button> : <div className="contents" data-testid="cc-local-foot-slot" ref={setLocalFoot} />}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 「推送并开 PR」的确认卡（§3.4 第 4 条，DESIGN.md §73.7）：分支 → 目标分支、要推的提交、还没提交的文件（会先自动提交）、
 * PR 标题 / 说明 / 草稿。点「允许并推送」才把令牌交给节点推送，然后开 PR。
 */
export function CcPushDialog({ sessionId, open, onOpenChange }: { sessionId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const preview = useQuery(ccPushPreviewQueryOptions(sessionId, open));
  const [title, setTitle] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const d = preview.data;
  const total = (d?.commits.length ?? 0) + (d && d.uncommitted > 0 ? 1 : 0);
  const push = useAsyncAction(
    async () => {
      setError(null);
      const r = await ccApi.push(sessionId, { title: (title ?? d?.title ?? "").trim(), body: body.trim() || undefined, draft }).catch((e: Error) => {
        setError(e.message);
        throw e;
      });
      await queryClient.invalidateQueries({ queryKey: ccKeys.workspaces });
      await queryClient.invalidateQueries({ queryKey: ["claude-code", "diff", sessionId] });
      if (!r.ok) {
        setError(r.error ?? "PR 没有开成");
        throw new Error(r.error ?? "PR 没有开成");
      }
      setTimeout(() => onOpenChange(false), 900);
    },
    { errorToast: false },
  );
  const busy = push.state === "pending";
  return (
    <Dialog
      onOpenChange={(o) => {
        if (busy && !o) return;
        if (!o) {
          setTitle(null);
          setError(null);
        }
        onOpenChange(o);
      }}
      open={open}
    >
      <DialogContent className="cc-dlg sm:max-w-[520px]" data-testid="cc-push-dialog">
        <DialogHeader>
          <DialogTitle>{"推送并开 PR"}</DialogTitle>
          <DialogDescription>{"把这个会话的分支推到 GitHub，再开一个 PR。令牌只在这一次推送里交给云端节点。"}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {preview.isPending ? (
            <div aria-busy className="cc-repo-skel" />
          ) : preview.isError ? (
            <div className="cc-rp-empty is-err">{preview.error.message}</div>
          ) : (
            <>
              <div className="cc-push-route" data-testid="cc-push-route">
                <IconBrandGithub className="size-4 flex-none opacity-70" />
                <span className="cc-push-repo">{d!.repo}</span>
                <span className="cc-push-br">
                  <IconGitBranch className="size-3.5" />
                  <code>{d!.branch ?? "（还没有分支）"}</code>
                  {" → "}
                  <code>{d!.base}</code>
                </span>
              </div>
              {d!.prUrl ? (
                <p className="cc-push-note">
                  {"这个会话已经开过 PR，再推送会更新它："}
                  <a href={d!.prUrl} rel="noreferrer noopener" target="_blank">
                    {d!.prUrl.replace(/^https:\/\/github\.com\//, "")}
                  </a>
                </p>
              ) : null}
              <div className="cc-push-commits" data-testid="cc-push-commits">
                {d!.commits.map((c) => (
                  <div className="cc-push-commit" key={c.sha}>
                    <IconGitCommit className="size-3.5 flex-none opacity-60" />
                    <code>{c.sha.slice(0, 7)}</code>
                    <span>{c.subject}</span>
                  </div>
                ))}
                {d!.uncommitted > 0 ? (
                  <div className="cc-push-commit is-pending">
                    <IconGitCommit className="size-3.5 flex-none opacity-60" />
                    <span>{`还没提交的 ${d!.uncommitted} 个文件，推送前会自动提交`}</span>
                  </div>
                ) : null}
                {total === 0 ? <div className="cc-rp-empty">{`相对 ${d!.base} 还没有改动，没有可推送的。`}</div> : null}
              </div>
              <label className="cc-field">
                <span className="cc-field-l">{"PR 标题"}</span>
                <Input data-testid="cc-pr-title" onChange={(e) => setTitle(e.target.value)} value={title ?? d!.title} />
              </label>
              <label className="cc-field">
                <span className="cc-field-l">{"说明（可不填）"}</span>
                <Textarea data-testid="cc-pr-body" onChange={(e) => setBody(e.target.value)} placeholder="不填就列出这些提交" rows={3} value={body} />
              </label>
              <label className="cc-check">
                <input checked={draft} onChange={(e) => setDraft(e.target.checked)} type="checkbox" />
                {"开成草稿 PR"}
              </label>
              {error ? (
                <p className="cc-form-err" data-testid="cc-push-error" role="alert">
                  {error}
                </p>
              ) : null}
            </>
          )}
        </DialogBody>
        <DialogFooter className="mt-6">
          <Button disabled={busy} onClick={() => onOpenChange(false)} variant="outline">
            {"拒绝"}
          </Button>
          <Button
            className={cn(total === 0 && "opacity-60")}
            data-testid="cc-push-confirm"
            disabled={!d || total === 0 || !(title ?? d.title).trim()}
            feedback={{ pending: "推送中…", success: "已开 PR", error: "没有成功" }}
            onClick={() => void push.run()}
            state={push.state}
          >
            {"允许并推送"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
