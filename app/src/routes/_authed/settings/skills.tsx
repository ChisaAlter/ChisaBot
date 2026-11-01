import { IconCheck, IconDownload, IconDots, IconMessageCircle, IconPencil, IconPlus, IconSparkles, IconTrash, IconUsers, IconWand } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { sendPromptToChat } from "@/components/chat/quick-spotlight";
import { PageEmpty, PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { SearchBox } from "@/components/memory/memory-notes";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { normalizeSlugInput, SKILL_SLUG, slugFromTitle } from "@/lib/skill-slug";
import { formDirty } from "@/lib/unsaved";
import { useGuardedOpenChange } from "@/components/ui/unsaved-guard";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard, ListRow, Toolbar } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
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

const SLUG = SKILL_SLUG;

/**
 * 设置 → 技能（DESIGN.md §51）：你存下来的「某类事怎么做」。所有机器人按需加载；聊天框里输入 /名字 也能直接用。
 */
function SkillsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
      queryClient.invalidateQueries({ queryKey: ["plugins"] }),
    ]);
  };
  const openSkillInChat = (skill: { slug: string; title: string }) => {
    sendPromptToChat(navigate, `/${skill.slug} 请按「${skill.title}」技能帮我执行`);
  };
  async function installFromHub(hubSlug: string, title?: string, asShared = false) {
    setInstallingSlug(hubSlug);
    try {
      const res = await importChisaSkill({ hubSlug, ...(asShared ? { shared: true } : {}) });
      await refresh();
      const skipped = res.skippedCount ?? 0;
      if (res.installedCount === 0 && skipped > 0) {
        toast.error("没有安装：同名技能已被他人或共享技能占用，请先在列表里处理。");
      } else {
        toast.success(
          hubSlug === "all"
            ? `已一键安装 ${res.installedCount} 个${asShared ? "全局共享" : "精选"}技能${skipped ? `，另有 ${skipped} 个因重名未处理` : ""}`
            : `已安装${asShared ? "全局共享" : ""}技能「${title ?? hubSlug}」`,
        );
      }
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
        await saveChisaSkill(skill.slug, { title: skill.title, summary: skill.summary, instructions: skill.instructions, create: true, shared: !skill.mine });
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
                {skill.mine ? null : <span className="device-cap-chip"><T>{isAdmin ? "全局共享 · 管理员可改" : "共享 · 只读"}</T></span>}
              </span>
            </>
          }
          title={skill.title}
        />
      </button>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          data-testid={`skill-use-${skill.slug}`}
          onClick={() => openSkillInChat(skill)}
          size="sm"
          title={`去对话里调用 /${skill.slug}`}
          variant="ghost"
        >
          <IconMessageCircle className="size-3.5" />
          {"去对话使用"}
        </Button>
        {skill.mine || isAdmin ? (
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
    </div>
  );

  const hubSection = hub.data?.length ? (
    <PageSection
      action={
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <Button
              data-testid="skill-hub-install-all-shared-btn"
              disabled={installingSlug === "all"}
              onClick={() => void installFromHub("all", undefined, true)}
              size="sm"
              variant="outline"
            >
              <IconUsers className="size-3.5" />
              {installingSlug === "all" ? "安装中…" : "全员共享安装全部"}
            </Button>
          ) : null}
          <Button
            data-testid="skill-hub-install-all-btn"
            disabled={installingSlug === "all"}
            onClick={() => void installFromHub("all", undefined, false)}
            size="sm"
            variant="outline"
          >
            <IconSparkles className="size-3.5" />
            {installingSlug === "all" ? "安装中…" : "一键安装全部精选"}
          </Button>
        </div>
      }
      description="开箱即用的个人助理核心技能包（早安管家、收件箱分拣、多源深度调研、PR 审查、服务器巡检、周报蒸馏等）。安装后随时可在聊天中输入 /名字 调用，管理员还可直接设为全员共享。"
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
                  <>
                    <Button
                      data-testid={`skill-hub-use-${item.slug}`}
                      onClick={() => openSkillInChat(item)}
                      size="sm"
                      variant="outline"
                    >
                      <IconMessageCircle className="size-3.5" />
                      {"去对话使用"}
                    </Button>
                    <Button
                      data-testid={`skill-hub-installed-${item.slug}`}
                      onClick={() => existing && setDialog({ open: true, skill: existing })}
                      size="sm"
                      variant="ghost"
                    >
                      <IconCheck className="mr-1 size-3.5 text-emerald-500" />
                      {"已安装 · 查看"}
                    </Button>
                  </>
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
  ) : null;

  return (
    <>
      <SkillDialog isAdmin={isAdmin} onOpenChange={(open) => setDialog((current) => ({ ...current, open }))} open={dialog.open} skill={dialog.skill} />
      <SkillImportDialog isAdmin={isAdmin} onImported={refresh} onOpenChange={setImportOpen} open={importOpen} />
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
            <Button data-testid="skill-new-btn" onClick={() => setDialog({ open: true, skill: null })} size="sm">
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
            {mine.length === 0 && !q ? hubSection : null}
            <PageSection title={`我的技能 · ${mine.length}`}>
              {mine.length ? (
                <Card className="mem-card">{mine.map(row)}</Card>
              ) : (
                <PageEmpty>{q ? "没有符合条件的技能。" : "还没有个人技能。可在上方「精选技能库」一键安装常用技能，或点右上角新建 / 从 GitHub 导入。"}</PageEmpty>
              )}
            </PageSection>
            {shared.length ? (
              <PageSection description="管理员给所有人准备的技能，只读。" title={`共享技能 · ${shared.length}`}>
                <Card className="mem-card">{shared.map(row)}</Card>
              </PageSection>
            ) : null}
            {mine.length > 0 || q ? hubSection : null}
          </>
        )}
      </PageShell>
    </>
  );
}

function SkillImportDialog({
  open,
  isAdmin = false,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  isAdmin?: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [slug, setSlug] = useState("");
  const [shared, setShared] = useState(false);


  const importAction = useAsyncAction(
    async () => {
      const res = await importChisaSkill({
        url: url.trim() || undefined,
        markdown: markdown.trim() || undefined,
        slug: slug.trim() || undefined,
        ...(isAdmin ? { shared } : {}),
      });
      await onImported();
      toast.success(`已导入${shared ? "全局共享" : ""}技能「${res.skill?.title ?? (slug || "新技能")}」`);
      onOpenChange(false);
    },
    { errorToast: (err) => err.message },
  );
  const resetImportAction = importAction.reset;
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setMarkdown("");
    setSlug("");
    setShared(false);
    resetImportAction();
  }, [open, resetImportAction]);

  const valid = Boolean(url.trim() || markdown.trim());
  /* 填了链接或内容还没导入，按 Esc / 点外面先确认（审查模块 12 第 3 条）。 */
  const dirty = Boolean(url.trim() || markdown.trim() || slug.trim()) && importAction.state !== "success";
  const guardedOpenChange = useGuardedOpenChange(dirty, onOpenChange);

  return (
    <Dialog onOpenChange={guardedOpenChange} open={open}>
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
            {isAdmin ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{"设为全局共享技能（全员可用）"}</div>
                  <div className="text-muted-foreground text-xs">{"开启后，实例中所有用户的机器人都可加载此技能，成员也能直接用 /名字 调用。"}</div>
                </div>
                <Switch checked={shared} onCheckedChange={(checked) => setShared(Boolean(checked))} />
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-3 sm:justify-between">
            <Button
              data-testid="skill-import-fill-demo-btn"
              onClick={() => {
                setMarkdown(
                  [
                    "---",
                    "name: daily-standup-prep",
                    "description: 每日站会 / 晨会发言提纲快速整理",
                    "---",
                    "",
                    "# 每日站会发言提纲整理",
                    "",
                    "1. 调用 `calendar_list_events` 与 `memory_recall` 回顾昨日完成事项与今日会议安排。",
                    "2. 按「昨日完成 · 今日计划 · 风险与阻塞」三段式生成精炼的站会发言卡片。",
                  ].join("\n"),
                );
                setSlug("daily-standup-prep");
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconWand className="size-3.5" />
              {"填入示例 SKILL.md"}
            </Button>
            <div className="flex items-center gap-2">
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
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SkillDialog({
  open,
  skill,
  isAdmin = false,
  onOpenChange,
}: {
  open: boolean;
  skill: ChisaSkill | null;
  isAdmin?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const readOnly = Boolean(skill && !skill.mine && !isAdmin);
  const empty = { slug: "", title: "", summary: "", instructions: "", shared: false };
  const [form, setForm] = useState(empty);
  const [initial, setInitial] = useState(empty);
  /* 名字没手动改过时，跟着标题自动生成（中文标题也能得到合法的名字，审查模块 12 第 5 条）。 */
  const [slugTouched, setSlugTouched] = useState(false);
  const save = useAsyncAction(
    async () => {
      await saveChisaSkill(form.slug, {
        title: form.title,
        summary: form.summary,
        instructions: form.instructions,
        create: !skill,
        ...(isAdmin ? { shared: form.shared } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: chisaSkillKeys.all });
      window.setTimeout(() => onOpenChange(false), 600);
    },
    { errorToast: (error) => error.message },
  );
  const resetSave = save.reset;
  useEffect(() => {
    if (!open) return;
    const next = skill
      ? { slug: skill.slug, title: skill.title, summary: skill.summary, instructions: skill.instructions, shared: !skill.mine }
      : { slug: "", title: "", summary: "", instructions: "", shared: false };
    setForm(next);
    setInitial(next);
    setSlugTouched(false);
    resetSave();
  }, [open, skill, resetSave]);
  const slugOk = SLUG.test(form.slug);
  const valid = slugOk && form.title.trim() && form.instructions.trim();
  const dirty = !readOnly && save.state !== "success" && formDirty(initial, form);
  const guardedOpenChange = useGuardedOpenChange(dirty, onOpenChange);
  return (
    <Dialog onOpenChange={guardedOpenChange} open={open}>
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
                <Input disabled={readOnly} id="skill-title" maxLength={60} onChange={(event) => {
                    const title = event.target.value;
                    setForm({ ...form, title, ...(!skill && !slugTouched ? { slug: slugFromTitle(title) } : {}) });
                  }} placeholder={"如「写周报」"} value={form.title} />
              </label>
              <label className="im-field" htmlFor="skill-slug">
                <span className="im-field-l">
                  {"名字"}
                  <span className="im-req">{skill ? "不能改" : "必填，小写字母、数字、连字符；按标题自动生成"}</span>
                </span>
                <Input
                  className="font-mono"
                  disabled={Boolean(skill)}
                  id="skill-slug"
                  maxLength={40}
                  onChange={(event) => {
                    const slug = normalizeSlugInput(event.target.value);
                    setSlugTouched(slug !== "");
                    setForm({ ...form, slug: slug || slugFromTitle(form.title) });
                  }}
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
            {isAdmin ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{"设为全局共享技能（全员可用）"}</div>
                  <div className="text-muted-foreground text-xs">{"开启后，实例中所有用户的机器人都可加载此技能，成员也能直接用 /名字 调用。"}</div>
                </div>
                <Switch checked={form.shared} onCheckedChange={(checked) => setForm({ ...form, shared: Boolean(checked) })} />
              </div>
            ) : null}
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
