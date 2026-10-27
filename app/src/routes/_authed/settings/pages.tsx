import {
  IconCopy,
  IconDots,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconHistory,
  IconMessageReply,
  IconPencil,
  IconPhoto,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { PageView } from "../../../../../shared/pages";
import { sendPromptToChat } from "@/components/chat/quick-spotlight";
import { PageEmpty, PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { PageThumb } from "@/components/pages/page-card";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import { writeClipboard } from "@/components/ui/copy-button";
import { agoText } from "@/lib/im";
import {
  deletePage,
  deletePageAsset,
  pageAssetsQueryOptions,
  pageKeys,
  pagesQueryOptions,
  pageUrl,
  pageVersionsQueryOptions,
  patchPage,
  reportPageOrigin,
  restorePageVersion,
  undoDeletePage,
  uploadPageAsset,
} from "@/lib/pages";

export const Route = createFileRoute("/_authed/settings/pages")({
  component: PagesPage,
});

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

/** 设置 → 页面（DESIGN.md §54）：机器人做的网页。打开、复制链接、版本历史、素材、下线、删除。 */
function PagesPage() {
  const navigate = useNavigate();
  const list = useQuery(pagesQueryOptions());
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ kind: "rename" | "versions" | "assets"; page: PageView } | null>(null);
  useEffect(() => reportPageOrigin(), []);
  const pages = (list.data ?? []).filter((page) => !hidden.has(page.id));
  const refresh = () => queryClient.invalidateQueries({ queryKey: pageKeys.all });

  async function togglePublished(page: PageView) {
    if (page.published) {
      const ok = await confirmDialog({
        title: `下线「${page.title}」？`,
        description: "下线后链接打不开，内容保留，随时可以重新发布。",
        confirmLabel: "下线",
      });
      if (!ok) return;
    }
    try {
      await patchPage(page.id, { published: !page.published });
      await refresh();
      toast.success(page.published ? `已下线「${page.title}」` : `已重新发布「${page.title}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  }

  async function remove(page: PageView) {
    const ok = await confirmDialog({
      title: `删除「${page.title}」？`,
      description: "链接会立刻失效，所有版本和素材一起删除。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    setHidden((current) => new Set(current).add(page.id));
    try {
      await deletePage(page.id);
      toast.undo(`已删除「${page.title}」`, () => {
        void undoDeletePage(page.id)
          .then(refresh)
          .then(() =>
            setHidden((current) => {
              const next = new Set(current);
              next.delete(page.id);
              return next;
            }),
          )
          .catch((error) => toast.error(error instanceof Error ? error.message : "撤销失败"));
      });
      await refresh();
    } catch (error) {
      setHidden((current) => {
        const next = new Set(current);
        next.delete(page.id);
        return next;
      });
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  }

  async function copy(page: PageView) {
    try {
      await writeClipboard(pageUrl(page));
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  }

  return (
    <>
      <RenameDialog onOpenChange={(open) => !open && setDialog(null)} page={dialog?.kind === "rename" ? dialog.page : null} />
      <VersionsDialog onOpenChange={(open) => !open && setDialog(null)} page={dialog?.kind === "versions" ? dialog.page : null} />
      <AssetsDialog onOpenChange={(open) => !open && setDialog(null)} page={dialog?.kind === "assets" ? dialog.page : null} />
      <PageShell
        action={
          <Button
            data-testid="pages-go-chat-btn"
            onClick={() =>
              sendPromptToChat(
                navigate,
                "请帮我制作并发布一个精美的网页页面：",
                "制作可分享网页",
              )
            }
            size="sm"
            variant="outline"
          >
            <IconMessageReply className="size-3.5" />
            {"让机器人做个页面"}
          </Button>
        }
        description="机器人做的网页：行程、邀请函、报告、作品集……每个页面一个不公开列出的链接，拿到链接的人不用登录就能看。在聊天里让机器人「做个页面」或「改一下页面」即可，每次改动都存成新的一版。"
        title="页面"
      >
        {list.isPending ? (
          <PageSkeleton rows={2} tall />
        ) : list.isError ? (
          <ErrorCard
            action={
              <Button className="mt-2" onClick={() => void list.refetch()} size="sm" variant="outline">
                {"重试"}
              </Button>
            }
            description={list.error.message}
            title="页面列表暂时无法读取"
          />
        ) : pages.length ? (
          <PageSection title={`我的页面 · ${pages.length}`}>
            <Card className="mem-card">
              {pages.map((page) => (
                <div className="im-row page-row" data-off={page.published ? undefined : ""} key={page.id}>
                  <a
                    aria-label={page.published ? `打开「${page.title}」` : `「${page.title}」已下线`}
                    className="page-row-main"
                    href={page.published ? pageUrl(page) : undefined}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <PageThumb className="page-row-thumb" page={page} scale={0.1} />
                    <span className="min-w-0 flex-1">
                      <span className="page-row-t">{page.title}</span>
                      <span className="device-row-meta">
                        <span className={page.published ? "device-cap-chip" : "device-cap-chip is-off"}>{page.published ? "已发布" : "已下线"}</span>
                        <span className="mem-by">{`第 ${page.version} 版 · ${agoText(page.updatedAt) ?? ""}更新${page.assets ? ` · ${page.assets} 个素材` : ""}`}</span>
                      </span>
                      {page.published ? <span className="page-row-url">{pageUrl(page).replace(/^https?:\/\//, "")}</span> : null}
                    </span>
                  </a>
                  {page.published ? (
                    <button aria-label={`复制「${page.title}」的链接`} className="device-row-more" onClick={() => void copy(page)} title={"复制链接"} type="button">
                      <IconCopy className="size-4" />
                    </button>
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<button aria-label={`「${page.title}」的更多操作`} className="device-row-more" title={"更多操作"} type="button" />}>
                      <IconDots className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="glass-pop w-[188px] p-1.5">
                      {page.published ? (
                        <DropdownMenuItem className="glass-mi" onClick={() => window.open(pageUrl(page), "_blank", "noopener,noreferrer")}>
                          <IconExternalLink className="size-[18px] shrink-0 opacity-80" />
                          <span className="min-w-0 flex-1">{"打开"}</span>
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem className="glass-mi" onClick={() => setDialog({ kind: "rename", page })}>
                        <IconPencil className="size-[18px] shrink-0 opacity-80" />
                        <span className="min-w-0 flex-1">{"改标题…"}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem className="glass-mi" onClick={() => setDialog({ kind: "versions", page })}>
                        <IconHistory className="size-[18px] shrink-0 opacity-80" />
                        <span className="min-w-0 flex-1">{"版本历史…"}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem className="glass-mi" onClick={() => setDialog({ kind: "assets", page })}>
                        <IconPhoto className="size-[18px] shrink-0 opacity-80" />
                        <span className="min-w-0 flex-1">{"素材…"}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem className="glass-mi" onClick={() => void togglePublished(page)}>
                        {page.published ? <IconEyeOff className="size-[18px] shrink-0 opacity-80" /> : <IconEye className="size-[18px] shrink-0 opacity-80" />}
                        <span className="min-w-0 flex-1">{page.published ? "下线…" : "重新发布"}</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator className="glass-sep" />
                      <DropdownMenuItem className="glass-mi is-danger" onClick={() => void remove(page)}>
                        <IconTrash className="size-[18px] shrink-0 opacity-80" />
                        <span className="min-w-0 flex-1">{"删除…"}</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </Card>
          </PageSection>
        ) : (
          <PageEmpty>
            <div className="flex flex-col items-center gap-3">
              <span>
                {
                  "还没有页面。在聊天里跟机器人说「把这个行程做成一个页面」，或点击下方灵感模板一键生成："
                }
              </span>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  data-testid="page-preset-trip"
                  onClick={() =>
                    sendPromptToChat(
                      navigate,
                      "请帮我制作一个「周末两天一夜京都赏枫行程指南」互动网页页面并生成分享链接",
                      "网页模板",
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {"🗺️ 做个周末出游行程页"}
                </Button>
                <Button
                  data-testid="page-preset-board"
                  onClick={() =>
                    sendPromptToChat(
                      navigate,
                      "请帮我制作一个「本周个人目标与项目进度看板」网页页面并发布",
                      "网页模板",
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {"📊 做个项目进度看板页"}
                </Button>
                <Button
                  data-testid="page-preset-invite"
                  onClick={() =>
                    sendPromptToChat(
                      navigate,
                      "请帮我制作一张「周五晚聚餐活动邀请函（含时间地点与地图卡片）」网页页面",
                      "网页模板",
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {"💌 做个活动邀请函页面"}
                </Button>
              </div>
            </div>
          </PageEmpty>
        )}
      </PageShell>
    </>
  );
}

function RenameDialog({ page, onOpenChange }: { page: PageView | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ title: "", description: "" });
  const save = useAsyncAction(
    async () => {
      if (!page) return;
      await patchPage(page.id, { title: form.title.trim(), description: form.description.trim() || null });
      await queryClient.invalidateQueries({ queryKey: pageKeys.all });
      window.setTimeout(() => onOpenChange(false), 600);
    },
    { errorToast: (error) => error.message },
  );
  const resetSave = save.reset;
  useEffect(() => {
    if (!page) return;
    setForm({ title: page.title, description: page.description ?? "" });
    resetSave();
  }, [page, resetSave]);
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(page)}>
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{"改标题"}</DialogTitle>
          <DialogDescription>{"标题显示在浏览器标签和分享预览上。改标题会存成新的一版。"}</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (form.title.trim() && save.state !== "pending") void save.run();
          }}
        >
          <DialogBody className="im-form mt-2">
            <label className="im-field" htmlFor="page-title">
              <span className="im-field-l">{"标题"}</span>
              <Input id="page-title" maxLength={80} onChange={(event) => setForm({ ...form, title: event.target.value })} value={form.title} />
            </label>
            <label className="im-field" htmlFor="page-desc">
              <span className="im-field-l">
                {"简介"}
                <span className="im-req">{"可选，分享预览里的一句话"}</span>
              </span>
              <Input id="page-desc" maxLength={200} onChange={(event) => setForm({ ...form, description: event.target.value })} value={form.description} />
            </label>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button disabled={!form.title.trim()} feedback="save" state={save.state} type="submit">
              {"保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VersionsDialog({ page, onOpenChange }: { page: PageView | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const versions = useQuery({ ...pageVersionsQueryOptions(page?.id ?? ""), enabled: Boolean(page) });
  const [restoring, setRestoring] = useState<number | null>(null);
  async function restore(version: number) {
    if (!page) return;
    setRestoring(version);
    try {
      await restorePageVersion(page.id, version);
      await Promise.all([queryClient.invalidateQueries({ queryKey: pageKeys.all }), versions.refetch()]);
      toast.success(`已恢复到第 ${version} 版（存成了新的一版）`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setRestoring(null);
    }
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(page)}>
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{`版本历史 · ${page?.title ?? ""}`}</DialogTitle>
          <DialogDescription>{"每次改动一版，保留最近 50 版。恢复旧版不会删掉后来的版本，而是把旧版复制成最新的一版。"}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-2">
          {versions.isPending ? (
            <PageSkeleton rows={3} />
          ) : versions.isError ? (
            <p className="page-empty">{versions.error.message}</p>
          ) : (
            <div className="page-versions">
              {(versions.data ?? []).map((v) => (
                <div className="page-version" key={v.version}>
                  <span className="page-version-n">{`第 ${v.version} 版`}</span>
                  <span className="min-w-0 flex-1">
                    <span className="page-version-t">{v.note || v.title}</span>
                    <span className="mem-by">{`${agoText(v.createdAt) ?? ""} · ${sizeText(v.bytes)}`}</span>
                  </span>
                  {v.current ? (
                    <span className="device-cap-chip"><T>{"当前"}</T></span>
                  ) : (
                    <Button
                      disabled={restoring !== null}
                      onClick={() => void restore(v.version)}
                      size="sm"
                      state={restoring === v.version ? "pending" : undefined}
                      variant="outline"
                    >
                      {"恢复"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function AssetsDialog({ page, onOpenChange }: { page: PageView | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const assets = useQuery({ ...pageAssetsQueryOptions(page?.id ?? ""), enabled: Boolean(page) });
  const input = useRef<HTMLInputElement>(null);
  const upload = useAsyncAction(
    async (files: File[]) => {
      if (!page) return;
      const names: string[] = [];
      for (const file of files) names.push(await uploadPageAsset(page.id, file));
      await Promise.all([assets.refetch(), queryClient.invalidateQueries({ queryKey: pageKeys.all })]);
      toast.success(`已上传：${names.map((n) => `assets/${n}`).join("、")}`);
    },
    { errorToast: (error) => error.message },
  );
  async function remove(name: string) {
    if (!page) return;
    const ok = await confirmDialog({ title: `删除素材「${name}」？`, description: "页面里引用它的地方会显示不出来。", confirmLabel: "删除", destructive: true });
    if (!ok) return;
    try {
      await deletePageAsset(page.id, name);
      await Promise.all([assets.refetch(), queryClient.invalidateQueries({ queryKey: pageKeys.all })]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(page)}>
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{`素材 · ${page?.title ?? ""}`}</DialogTitle>
          <DialogDescription>{"页面里用 assets/名字 引用的图片等文件（每个 ≤ 8MB）。上传后告诉机器人用在哪里。"}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-2">
          {assets.isPending ? (
            <PageSkeleton rows={2} />
          ) : assets.data?.length ? (
            <div className="page-versions">
              {assets.data.map((asset) => (
                <div className="page-version" key={asset.name}>
                  <span className="min-w-0 flex-1">
                    <span className="page-version-t page-mono">{`assets/${asset.name}`}</span>
                    <span className="mem-by">{`${sizeText(asset.bytes)} · ${agoText(asset.createdAt) ?? ""}`}</span>
                  </span>
                  <button aria-label={`删除素材 ${asset.name}`} className="device-row-more" onClick={() => void remove(asset.name)} title={"删除"} type="button">
                    <IconTrash className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="page-empty">{"还没有素材。"}</p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <input
            accept="image/*,audio/*,video/mp4,video/webm,application/pdf"
            className="hidden"
            multiple
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              if (files.length) void upload.run(files);
            }}
            ref={input}
            type="file"
          />
          <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {"关闭"}
          </Button>
          <Button feedback={{ pending: "上传中…", success: "已上传", error: "上传失败" }} onClick={() => input.current?.click()} state={upload.state} type="button">
            <IconUpload />
            {"上传素材"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
