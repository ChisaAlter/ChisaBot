import { IconCheck, IconDownload, IconDots, IconPencil, IconPlus, IconSparkles, IconTrash, IconUsers } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageEmpty, PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { SearchBox } from "@/components/memory/memory-notes";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard, ListRow, Toolbar } from "@/components/ui/skyglass";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  type ChisaSkill,
  chisaSkillHubQueryOptions,
  chisaSkillKeys,
  chisaSkillsQueryOptions,
  deleteChisaSkill,
  importChisaSkill,
  saveChisaSkill,
} from "@/lib/chisa-skills";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings/skills")({
  component: SkillsPage,
});

const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/**
 * 设置 → 技能（DESIGN.md §51）：你存下来的「某类事怎么做」。所有机器人按需加载；聊天框里输入 /名字 也能直接用。
 */
function SkillsPage() {
  const queryClient = useQueryClient();
  const list = useQuery(chisaSkillsQueryOptions());
  const hub = useQuery(chisaSkillHubQueryOptions());
  const isAdmin = useQuery(currentUserQueryOptions()).data?.role === "admin";
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; skill: ChisaSkill | null }>({ open: false, skill: null });
  const [importOpen, setImportOpen] = useState(false);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const q = query.trim().toLocaleLowerCase();
  const skills = (list.data ?? []).filter(
    (skill) => skill.slug !== hidden && (!q || [skill.slug, skill.title, skill.summary, skill.instructions].some((part) => part.toLocaleLowerCase().includes(q))),
  );
  const mine = skills.filter((skill) => skill.mine);
  const shared = skills.filter((skill) => !skill.mine);
  const installedSlugs = new Set((list.data ?? []).map((s) => s.slug));
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: chisaSkillKeys.all }),
      queryClient.invalidateQueries({ queryKey: chisaSkillKeys.hub }),
    ]);
  };
  async function installFromHub(hubSlug: string, title?: string) {
    setInstallingSlug(hubSlug);
    try {
      const res = await importChisaSkill({ hubSlug });
      await refresh();
      toast.success(hubSlug === "all" ? `已一键安装 ${res.installedCount} 个精选技能` : `已安装技能「${title ?? hubSlug}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "安装失败");
    } finally {
      setInstallingSlug(null);
    }
  }
  async function remove(skill: ChisaSkill) {
    const ok = await confirmDialog({ title: `删除技能「${skill.title}」？`, description: "机器人以后不会再按它做事。删除后 8 秒内可以撤销。", confirmLabel: "删除", destructive: true });
    if (!ok) return;
    setHidden(skill.slug);
    try {
      await deleteChisaSkill(skill.slug);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
      return;
    } finally {
      setHidden(null);
    }
    toast.undo(`已删除技能「${skill.title}」`, async () => {
      try {
        await saveChisaSkill(skill.slug, { title: skill.title, summary: skill.summary, instructions: skill.instructions, create: true });
        await refresh();
      } catch {
        toast.error("恢复失败");
      }
    });
  }
  const row = (skill: ChisaSkill) => (
    <div className="im-row" key={skill.slug}>
      <button className="im-row-main" onClick={() => setDialog({ open: true, skill })} type="button">
        <ListRow
          icon={
            <span className={cn("mem-ico", !skill.mine && "is-note")}>
              {skill.mine ? <IconSparkles className="size-5" /> : <IconUsers className="size-5" />}
            </span>
          }
          sub={
            <>
              {skill.summary ? <span className="mem-body">{skill.summary}</span> : null}
              <span className="device-row-meta">
                <span className="skill-slug">{`/${skill.slug}`}</span>
                {skill.mine ? null : <span className="device-cap-chip"><T>{"共享 · 只读"}</T></span>}
              </span>
            </>
          }
          title={skill.title}
        />
      </button>
      {skill.mine ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<button aria-label={`「${skill.title}」的更多操作`} className="device-row-more" title={"更多操作"} type="button" />}>
            <IconDots className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="glass-pop w-[180px] p-1.5">
            <DropdownMenuItem className="glass-mi" onClick={() => setDialog({ open: true, skill })}>
              <IconPencil className="size-[18px] shrink-0 opacity-80" />
              <span className="min-w-0 flex-1">{"编辑…"}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="glass-sep" />
            <DropdownMenuItem className="glass-mi is-danger" onClick={() => void remove(skill)}>
              <IconTrash className="size-[18px] shrink-0 opacity-80" />
              <span className="min-w-0 flex-1">{"删除…"}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
  return (
    <>
      <SkillDialog onOpenChange={(open) => setDialog((current) => ({ ...current, open }))} open={dialog.open} skill={dialog.skill} />
      <SkillImportDialog onImported={refresh} onOpenChange={setImportOpen} open={importOpen} />
      <PageShell
        action={
          /* 技能管理并入这里（DESIGN.md §57 导航收敛）：管理员从这里进入部署共享技能。 */
          <div className="flex flex-wrap gap-2">
            {isAdmin ? (
              <Button nativeButton={false} render={<Link to="/admin/skills" />} size="sm" variant="outline">
                <IconUsers />
                {"共享技能管理"}
              </Button>
            ) : null}
            <Button data-testid="skill-import-btn" onClick={() => setImportOpen(true)} size="sm" variant="outline">
              <IconDownload />
              {"从 GitHub / SKILL.md 导入"}
            </Button>
            <Button onClick={() => setDialog({ open: true, skill: null })} size="sm">
              <IconPlus />
              {"新建技能"}
            </Button>
          </div>
        }
        description="技能是你存下来的「某类事怎么做」：步骤、偏好、要用的网站、踩过的坑。你的所有机器人做事前会按需加载对得上的技能；聊天框里输入 / 加名字也能直接用。支持一键安装内置精选技能包，或直接从 GitHub 导入 SKILL.md。"
        title="技能"
      >
        {list.isPending ? (
          <PageSkeleton rows={3} />
        ) : list.isError ? (
          <ErrorCard
            action={
              <Button className="mt-2" onClick={() => void list.refetch()} size="sm" variant="outline">
                {"重试"}
              </Button>
            }
            description={list.error.message}
            title="技能暂时无法读取"
          />
        ) : (
          <>
            {(list.data ?? []).length > 4 ? (
              <Toolbar className="mem-toolbar">
                <span />
                <SearchBox onChange={setQuery} placeholder={"搜索技能"} value={query} />
              </Toolbar>
            ) : null}
            <PageSection title={`我的技能 · ${mine.length}`}>
              {mine.length ? (
                <Card className="mem-card">{mine.map(row)}</Card>
              ) : (
                <PageEmpty>{q ? "没有符合条件的技能。" : "还没有技能。可在下方「精选技能库」一键安装常用技能，或点右上角新建 / 从 GitHub 导入。"}</PageEmpty>
              )}
            </PageSection>
            {shared.length ? (
              <PageSection description="管理员给所有人准备的技能，只读。" title={`共享技能 · ${shared.length}`}>
                <Card className="mem-card">{shared.map(row)}</Card>
              </PageSection>
            ) : null}
            {hub.data?.length ? (
              <PageSection
                action={
                  <Button
                    data-testid="skill-hub-install-all-btn"
                    disabled={installingSlug === "all"}
                    onClick={() => void installFromHub("all")}
                    size="sm"
                    variant="outline"
                  >
                    <IconSparkles className="size-3.5" />
                    {installingSlug === "all" ? "安装中…" : "一键安装全部精选"}
                  </Button>
                }
                description="开箱即用的个人助理核心技能包（早安管家、收件箱分拣、多源深度调研、PR 审查、服务器巡检、周报蒸馏等）。安装后随时可在聊天中输入 /名字 调用，也可自由编辑。"
                title={`✨ 精选技能库（一键安装） · ${hub.data.length}`}
              >
                <Card className="mem-card" data-testid="skill-hub-card">
                  {hub.data.map((item) => {
                    const isInstalled = installedSlugs.has(item.slug) || item.installed;
                    const existing = (list.data ?? []).find((s) => s.slug === item.slug);
                    return (
                      <div className="im-row" key={item.slug}>
                        <div className="im-row-main is-static">
                          <ListRow
                            icon={
                              <span className="mem-ico">
                                <IconSparkles className="size-5" />
                              </span>
                            }
                            sub={
                              <>
                                <span className="mem-body">{item.summary}</span>
                                <span className="device-row-meta">
                                  <span className="skill-slug">{`/${item.slug}`}</span>
                                  <span className="device-cap-chip">{item.category}</span>
                                </span>
                              </>
                            }
                            title={item.title}
                          />
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {isInstalled ? (
                            <Button
                              data-testid={`skill-hub-installed-${item.slug}`}
                              onClick={() => existing && setDialog({ open: true, skill: existing })}
                              size="sm"
                              variant="ghost"
                            >
                              <IconCheck className="mr-1 size-3.5 text-emerald-500" />
                              {"已安装 · 查看"}
                            </Button>
                          ) : (
                            <Button
                              data-testid={`skill-hub-install-${item.slug}`}
                              disabled={installingSlug === item.slug}
                              onClick={() => void installFromHub(item.slug, item.title)}
                              size="sm"
                              variant="outline"
                            >
                              {installingSlug === item.slug ? "安装中…" : "一键安装"}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </Card>
              </PageSection>
            ) : null}
          </>
        )}
      </PageShell>
    </>
  );
}

function SkillImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [slug, setSlug] = useState("");

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setMarkdown("");
    setSlug("");
    importAction.reset();
  }, [open]);

  const importAction = useAsyncAction(
    async () => {
      const res = await importChisaSkill({
        url: url.trim() || undefined,
        markdown: markdown.trim() || undefined,
        slug: slug.trim() || undefined,
      });
      await onImported();
      toast.success(`已导入技能「${res.skill?.title ?? (slug || "新技能")}」`);
      onOpenChange(false);
    },
    { errorToast: (err) => err.message },
  );

  const valid = Boolean(url.trim() || markdown.trim());

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-xl" data-testid="skill-import-dialog">
        <DialogHeader>
          <DialogTitle>{"从 GitHub / SKILL.md 导入技能"}</DialogTitle>
          <DialogDescription>
            {"支持粘贴 GitHub 上的 SKILL.md 链接（兼容 OpenClaw ClawHub / Claude Code / Cursor 技能格式，自动解析 YAML Frontmatter），或直接粘贴 Markdown 文本。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && importAction.state !== "pending") void importAction.run();
          }}
        >
          <DialogBody className="im-form mt-2 flex flex-col gap-3">
            <label className="im-field">
              <span className="im-field-l">
                {"GitHub SKILL.md 链接 / Raw URL"}
                <span className="im-req">{"支持 github.com/.../blob/.../SKILL.md"}</span>
              </span>
              <Input
                className="font-mono text-xs"
                data-testid="skill-import-url-input"
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md"
                value={url}
              />
            </label>
            <label className="im-field">
              <span className="im-field-l">
                {"或直接粘贴 SKILL.md 内容"}
                <span className="im-req">{"支持 --- Frontmatter ---"}</span>
              </span>
              <Textarea
                className="font-mono text-xs"
                data-testid="skill-import-markdown-input"
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder={"---\nname: my-skill\ndescription: 一句话说明什么时候用\n---\n\n# 技能标题\n1. 第一步..."}
                rows={7}
                value={markdown}
              />
            </label>
            <label className="im-field">
              <span className="im-field-l">
                {"自定义英文名字（可选）"}
                <span className="im-req">{"留空自动从文件提取"}</span>
              </span>
              <Input
                className="font-mono text-xs"
                data-testid="skill-import-slug-input"
                maxLength={40}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                placeholder="my-skill"
                value={slug}
              />
            </label>
          </DialogBody>
          <DialogFooter className="mt-3">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button
              data-testid="skill-import-submit-btn"
              disabled={!valid}
              feedback={{ pending: "导入中…", success: "已导入", error: "导入失败" }}
              state={importAction.state}
              type="submit"
            >
              {"解析并导入"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SkillDialog({ open, skill, onOpenChange }: { open: boolean; skill: ChisaSkill | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const readOnly = Boolean(skill && !skill.mine);
  const [form, setForm] = useState({ slug: "", title: "", summary: "", instructions: "" });
  useEffect(() => {
    if (!open) return;
    setForm(skill ? { slug: skill.slug, title: skill.title, summary: skill.summary, instructions: skill.instructions } : { slug: "", title: "", summary: "", instructions: "" });
    save.reset();
  }, [open, skill]);
  const save = useAsyncAction(
    async () => {
      await saveChisaSkill(form.slug, { title: form.title, summary: form.summary, instructions: form.instructions, create: !skill });
      await queryClient.invalidateQueries({ queryKey: chisaSkillKeys.all });
      window.setTimeout(() => onOpenChange(false), 600);
    },
    { errorToast: (error) => error.message },
  );
  const slugOk = SLUG.test(form.slug);
  const valid = slugOk && form.title.trim() && form.instructions.trim();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-2xl">
        <DialogHeader>
          <DialogTitle>{readOnly ? skill!.title : skill ? "编辑技能" : "新建技能"}</DialogTitle>
          <DialogDescription>{readOnly ? "共享技能，只读。" : "写成以后照着就能做的方法：步骤、偏好、注意事项。不要写密码。"}</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !readOnly && save.state !== "pending") void save.run();
          }}
        >
          <DialogBody className="im-form mt-2">
            <div className="im-grid">
              <label className="im-field" htmlFor="skill-title">
                <span className="im-field-l">
                  {"标题"}
                  <span className="im-req">{"必填"}</span>
                </span>
                <Input disabled={readOnly} id="skill-title" maxLength={60} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder={"如「写周报」"} value={form.title} />
              </label>
              <label className="im-field" htmlFor="skill-slug">
                <span className="im-field-l">
                  {"名字"}
                  <span className="im-req">{skill ? "不能改" : "小写字母、数字、连字符"}</span>
                </span>
                <Input
                  className="font-mono"
                  disabled={Boolean(skill)}
                  id="skill-slug"
                  maxLength={40}
                  onChange={(event) => setForm({ ...form, slug: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
                  placeholder={"weekly-report"}
                  value={form.slug}
                />
                {!skill && form.slug && !slugOk ? <span className="im-field-h">{"2–40 个字符，首尾不能是连字符。"}</span> : null}
              </label>
            </div>
            <label className="im-field" htmlFor="skill-summary">
              <span className="im-field-l">
                {"什么时候用"}
                <span className="im-req">{"一句话，机器人靠它判断要不要加载"}</span>
              </span>
              <Input disabled={readOnly} id="skill-summary" maxLength={200} onChange={(event) => setForm({ ...form, summary: event.target.value })} placeholder={"用户让我写本周工作周报时"} value={form.summary} />
            </label>
            <label className="im-field" htmlFor="skill-instructions">
              <span className="im-field-l">
                {"方法说明"}
                <span className="im-req">{"必填，支持 Markdown"}</span>
              </span>
              <Textarea
                className="skill-instructions"
                disabled={readOnly}
                id="skill-instructions"
                maxLength={20000}
                onChange={(event) => setForm({ ...form, instructions: event.target.value })}
                rows={12}
                value={form.instructions}
              />
            </label>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {readOnly ? "关闭" : "取消"}
            </Button>
            {readOnly ? null : (
              <Button disabled={!valid} feedback="save" state={save.state} type="submit">
                {"保存"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
