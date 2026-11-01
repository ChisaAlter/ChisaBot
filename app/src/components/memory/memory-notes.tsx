import {
  IconBriefcase,
  IconCalendarEvent,
  IconDots,
  IconHeart,
  IconMapPin,
  IconNote,
  IconPencil,
  IconRobot,
  IconSearch,
  IconTrash,
  IconUser,
  IconUserCircle,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryNoteView,
  SUBJECT_KINDS,
} from "../../../../shared/memory-notes";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useGuardedOpenChange } from "@/components/ui/unsaved-guard";
import { formDirty } from "@/lib/unsaved";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, ListRow } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { agoText } from "@/lib/im";
import {
  createMemoryNote,
  deleteMemoryNotes,
  type MemoryNoteInput,
  memoryNoteKeys,
  setMemoryBot,
  updateMemoryNote,
} from "@/lib/memory-notes";
import { cn } from "@/lib/utils";

/**
 * 设置 → 记忆（DESIGN.md §50）。按种类分组的笔记列表 + 搜索 + 编辑 / 删除（撤销）+ 每个机器人的开关。
 * 搜索框里有词时，可以「删除这 N 条」——和对机器人说「忘掉 X」是同一件事。
 */

export const KIND_ICON: Record<MemoryKind, typeof IconUser> = {
  profile: IconUserCircle,
  preference: IconHeart,
  person: IconUser,
  place: IconMapPin,
  project: IconBriefcase,
  note: IconNote,
  daily: IconCalendarEvent,
};

/** 和服务器同一套打分的简化版：只做包含匹配（列表在本地筛，服务器那套用于机器人）。 */
export function matches(note: MemoryNoteView, query: string) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  return [note.subject, note.content, note.context].some((part) => part?.toLocaleLowerCase().includes(q));
}

export function MemoryKindIcon({ kind }: { kind: MemoryKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={cn("mem-ico", `is-${kind}`)}>
      <Icon className="size-5" />
    </span>
  );
}

export function NoteRow({
  note,
  botName,
  isAdmin = false,
  onEdit,
  onDelete,
}: {
  note: MemoryNoteView;
  botName: string | null;
  isAdmin?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const title = note.subject ?? note.content.split("\n")[0]!;
  const body = note.subject ? note.content : note.content.split("\n").slice(1).join(" ");
  const isKnowledge = Boolean(note.subject?.startsWith("[知识库]") || note.subject?.startsWith("📚") || note.context?.includes("知识库"));
  const readOnly = Boolean(note.shared && !isAdmin);
  return (
    <div className="im-row mem-row">
      <button className="im-row-main" disabled={readOnly} onClick={readOnly ? undefined : onEdit} type="button">
        <ListRow
          icon={<MemoryKindIcon kind={note.kind} />}
          sub={
            <>
              {body ? <span className="mem-body">{body.replace(/\n+/g, " · ")}</span> : null}
              <span className="device-row-meta">
                {note.shared ? <span className="device-cap-chip"><T>{"🌐 公共知识库"}</T></span> : null}
                {isKnowledge && !note.shared ? <span className="device-cap-chip"><T>{"📚 个人知识库"}</T></span> : null}
                {note.context ? <span className="device-cap-chip"><T>{`情境：${note.context}`}</T></span> : null}
                <span className="mem-by">
                  {note.shared
                    ? "管理员共享"
                    : note.author === "bot"
                      ? (
                          <>
                            <IconRobot aria-hidden className="size-3.5" />
                            {botName ?? "机器人"}
                          </>
                        )
                      : "你写的"}
                  {` · ${agoText(note.updatedAt)}更新`}
                </span>
              </span>
            </>
          }
          title={title}
        />
      </button>
      {readOnly ? (
        <span className="device-cap-chip shrink-0">
          <T>{"只读"}</T>
        </span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger render={<button aria-label={`「${title}」的更多操作`} className="device-row-more" title={"更多操作"} type="button" />}>
            <IconDots className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="glass-pop w-[180px] p-1.5">
            <DropdownMenuItem className="glass-mi" onClick={onEdit}>
              <IconPencil className="size-[18px] shrink-0 opacity-80" />
              <span className="min-w-0 flex-1">{"编辑…"}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="glass-sep" />
            <DropdownMenuItem className="glass-mi is-danger" onClick={onDelete}>
              <IconTrash className="size-[18px] shrink-0 opacity-80" />
              <span className="min-w-0 flex-1">{"删除"}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

type Form = { kind: MemoryKind; subject: string; content: string; context: string; shared: boolean };

export function NoteDialog({
  open,
  note,
  preset,
  isAdmin = false,
  onOpenChange,
}: {
  open: boolean;
  note: MemoryNoteView | null;
  preset?: { kind?: MemoryKind; subject?: string; context?: string; shared?: boolean } | null;
  isAdmin?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>({ kind: "preference", subject: "", content: "", context: "", shared: false });
  const [initial, setInitial] = useState<Form>(form);
  const needsSubject = SUBJECT_KINDS.includes(form.kind);
  const save = useAsyncAction(
    async () => {
      const input: MemoryNoteInput = {
        kind: form.kind,
        subject: form.subject.trim() || null,
        content: form.content,
        context: form.context.trim() || null,
        ...(isAdmin ? { shared: form.shared } : {}),
      };
      if (note) await updateMemoryNote(note.id, input);
      else await createMemoryNote(input);
      await queryClient.invalidateQueries({ queryKey: memoryNoteKeys.all });
      window.setTimeout(() => onOpenChange(false), 600);
    },
    { errorToast: (error) => error.message },
  );
  const resetSave = save.reset;
  useEffect(() => {
    if (!open) return;
    const next: Form = note
      ? { kind: note.kind, subject: note.subject ?? "", content: note.content, context: note.context ?? "", shared: Boolean(note.shared) }
      : {
          kind: preset?.kind ?? "preference",
          subject: preset?.subject ?? "",
          content: "",
          context: preset?.context ?? "",
          shared: Boolean(preset?.shared),
        };
    setForm(next);
    setInitial(next);
    resetSave();
  }, [open, note, preset, resetSave]);
  const valid = form.content.trim().length > 0 && (!needsSubject || form.subject.trim().length > 0);
  const isKnowledgePreset = Boolean(!note && preset?.subject?.startsWith("[知识库]"));
  /* 写了一半按 Esc / 点外面先确认（审查模块 12 第 3 条）。 */
  const guardedOpenChange = useGuardedOpenChange(save.state !== "success" && formDirty(initial, form), onOpenChange);
  return (
    <Dialog onOpenChange={guardedOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg" data-testid="memory-note-dialog">
        <DialogHeader>
          <DialogTitle>{note ? "编辑记忆" : isKnowledgePreset ? (form.shared ? "🌐 录入公共知识库" : "📚 录入个人知识库") : "添加记忆"}</DialogTitle>
          <DialogDescription>
            {form.shared
              ? "公共知识库条目对本实例中所有成员与所有机器人可见（普通成员只读），适合存放团队规范、公共文档与共享参考资料。"
              : isKnowledgePreset
                ? "将网页摘录、工作规范、读书笔记或重要参考资料存入知识库，所有机器人均可通过 knowledge_search 检索引用。"
                : "你的所有机器人都会看到这条（关掉记忆的机器人除外）。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && save.state !== "pending") void save.run();
          }}
        >
          <DialogBody className="im-form mt-2">
            <div className="im-grid">
              <label className="im-field" htmlFor="mem-kind">
                <span className="im-field-l">{"种类"}</span>
                <Select onValueChange={(next) => setForm({ ...form, kind: String(next) as MemoryKind })} value={form.kind}>
                  <SelectTrigger className="w-full" id="mem-kind">
                    <SelectValue>{MEMORY_KIND_LABELS[form.kind]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {MEMORY_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {MEMORY_KIND_LABELS[kind]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              <label className="im-field" htmlFor="mem-subject">
                <span className="im-field-l">
                  {form.kind === "daily" ? "日期" : "主题"}
                  <span className="im-req">{needsSubject ? "必填" : "可选"}</span>
                </span>
                <Input
                  id="mem-subject"
                  maxLength={80}
                  onChange={(event) => setForm({ ...form, subject: event.target.value })}
                  placeholder={form.kind === "person" ? "名字或称呼" : form.kind === "place" ? "地名" : form.kind === "project" ? "项目名" : form.kind === "daily" ? "YYYY-MM-DD，留空 = 今天" : "留空也行"}
                  value={form.subject}
                />
              </label>
            </div>
            <label className="im-field" htmlFor="mem-content">
              <span className="im-field-l">
                {"内容"}
                <span className="im-req">{"必填"}</span>
              </span>
              <Textarea id="mem-content" maxLength={4000} onChange={(event) => setForm({ ...form, content: event.target.value })} rows={5} value={form.content} />
            </label>
            <label className="im-field" htmlFor="mem-context">
              <span className="im-field-l">
                {"情境"}
                <span className="im-req">{"可选"}</span>
              </span>
              <Input id="mem-context" maxLength={300} onChange={(event) => setForm({ ...form, context: event.target.value })} placeholder={"什么时候成立，比如「工作日在公司午饭」"} value={form.context} />
            </label>
            {isAdmin ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{"设为公共知识库（全员共享）"}</div>
                  <div className="text-muted-foreground text-xs">{"开启后，所有成员的机器人都可检索并引用该条目，普通成员只读。"}</div>
                </div>
                <Switch checked={form.shared} onCheckedChange={(checked) => setForm({ ...form, shared: Boolean(checked) })} />
              </div>
            ) : null}
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

/** 每个机器人一行：开着 = 读写共用记忆。 */
export function MemoryBots({ disabled }: { disabled: ReadonlySet<string> }) {
  const queryClient = useQueryClient();
  const bots = useQuery(agentListQueryOptions());
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const roster = useMemo(() => bots.data ?? [], [bots.data]);
  if (!roster.length) return null;
  return (
    <Card className="mem-bots">
      {roster.map((bot) => {
        const on = local[bot.id] ?? !disabled.has(bot.id);
        return (
          <div className="mem-bot" key={bot.id}>
            <span className="min-w-0 flex-1 truncate">{bot.name}</span>
            <span className="mem-bot-s">{on ? "读写共用记忆" : "不读也不写"}</span>
            <Switch
              aria-label={on ? `关掉「${bot.name}」的记忆` : `打开「${bot.name}」的记忆`}
              checked={on}
              onCheckedChange={async (next) => {
                setLocal((current) => ({ ...current, [bot.id]: next }));
                try {
                  await setMemoryBot(bot.id, next);
                  await queryClient.invalidateQueries({ queryKey: memoryNoteKeys.all });
                } catch (error) {
                  setLocal((current) => ({ ...current, [bot.id]: !next }));
                  toast.error(error instanceof Error ? error.message : "保存失败");
                }
              }}
            />
          </div>
        );
      })}
    </Card>
  );
}

/**
 * 一组最多先画这么多行（CB-106）。列表一次拿全（本地搜索要用全文），但 3000 条每行一个下拉菜单
 * 全挂上去，首屏要好几秒、删一条也要整页重渲染；先画前 N 条，其余点「显示其余」再画。
 * 搜索框里有词时不截断：那是在找东西，命中的都要看得到（命中通常很少）。
 */
export const MEMORY_GROUP_LIMIT = 50;

export function visibleNotes<T>(notes: readonly T[], expanded: boolean, limit = MEMORY_GROUP_LIMIT): readonly T[] {
  return expanded || notes.length <= limit ? notes : notes.slice(0, limit);
}

/** 撤销窗口（毫秒）：和「撤销」提示一样长，过了才真正删库（CB-106）。 */
export const MEMORY_UNDO_MS = 8000;

/**
 * 待删除的记忆（CB-106 延迟删除）。确认后只在界面上隐藏，撤销窗口结束才发删除请求；
 * 撤销 = 取消这次待删除，库里的原记录一直没动（id、created_at、agent_id 原样）。
 *
 * 放在模块级而不是页面 state 里：离开设置页（组件卸载）不取消、也不提前删，计时照走，8 秒到了照删；
 * 回到页面时仍然隐藏着。关标签页/刷新（pagehide）时窗口没法再撤销，立刻用 keepalive 请求把待删的发出去。
 */
type PendingDelete = { ids: string[]; timer: ReturnType<typeof setTimeout>; refresh: () => Promise<unknown> };
const pendingDeletes = new Map<number, PendingDelete>();
const flushedIds = new Set<string>();
const flushedRefreshes = new Set<() => Promise<unknown>>();
let pendingSeq = 0;
let pendingHidden: ReadonlySet<string> = new Set();
const pendingListeners = new Set<() => void>();

function emitPending() {
  pendingHidden = new Set([...[...pendingDeletes.values()].flatMap((entry) => entry.ids), ...flushedIds]);
  for (const listener of pendingListeners) listener();
}

/** 删除失败的提示文案：断网（fetch 抛 TypeError，如 Failed to fetch）给中文，不露英文原文。 */
export function deleteErrorText(error: unknown) {
  if (error instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false))
    return "网络连不上，这条记忆没删";
  return error instanceof Error && error.message ? error.message : "删除失败";
}

/** 撤销提示文案：带上记忆标题（主题，没有就用正文），太长截断。 */
export function undoToastText(notes: MemoryNoteView[]) {
  if (notes.length !== 1) return `已删除 ${notes.length} 条记忆`;
  const raw = (notes[0]?.subject || notes[0]?.content || "").replace(/\s+/g, " ").trim();
  if (!raw) return "已删除 1 条记忆";
  const title = [...raw].length > 16 ? `${[...raw].slice(0, 16).join("")}…` : raw;
  return `已删除记忆「${title}」`;
}

/** 界面上要隐藏的记忆 id（待删除 + 正在删）。配合 useSyncExternalStore。 */
export const pendingMemoryDeletes = {
  subscribe(listener: () => void) {
    pendingListeners.add(listener);
    return () => void pendingListeners.delete(listener);
  },
  snapshot: () => pendingHidden,
};

async function commitDelete(key: number) {
  const entry = pendingDeletes.get(key);
  if (!entry) return;
  try {
    await deleteMemoryNotes(entry.ids);
  } catch (error) {
    // 删除失败：放开隐藏，记录回到列表，并报错。
    pendingDeletes.delete(key);
    forgetToast(key);
    emitPending();
    toast.error(deleteErrorText(error));
    return;
  }
  // 列表刷新完再放开隐藏，免得已删的那条闪回来。
  await entry.refresh().catch(() => undefined);
  pendingDeletes.delete(key);
  forgetToast(key);
  emitPending();
}

/** 关页时把待删的立刻发出去（导出给测试：测试里的 window 换过，事件监听挂在别的对象上）。 */
export function flushOnPageHide() {
  for (const [key, entry] of pendingDeletes) {
    clearTimeout(entry.timer);
    pendingDeletes.delete(key);
    forgetToast(key);
    for (const id of entry.ids) flushedIds.add(id);
    flushedRefreshes.add(entry.refresh);
    void fetch("/api/memory-notes/forget", {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: entry.ids }),
    })
      .then(() => entry.refresh().catch(() => undefined))
      .catch(() => undefined)
      .finally(() => {
        for (const id of entry.ids) flushedIds.delete(id);
        flushedRefreshes.delete(entry.refresh);
        emitPending();
      });
  }
  emitPending();
}
function refreshAfterPageShow() {
  if (!flushedRefreshes.size && !flushedIds.size) return;
  const refreshes = [...flushedRefreshes];
  flushedRefreshes.clear();
  void Promise.all(refreshes.map((fn) => fn().catch(() => undefined))).finally(() => {
    flushedIds.clear();
    emitPending();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushOnPageHide);
  window.addEventListener("pageshow", refreshAfterPageShow);
}

/**
 * 删掉（可撤销）。立刻隐藏并弹「撤销」，{@link MEMORY_UNDO_MS} 后才真删；连删几次各自独立计时、各自撤销。
 * 返回这次待删除的 key（测试用）。
 */
export function deleteWithUndo(notes: MemoryNoteView[], refresh: () => Promise<unknown>) {
  const ids = notes.map((note) => note.id);
  const key = ++pendingSeq;
  const timer = setTimeout(() => void commitDelete(key), MEMORY_UNDO_MS);
  pendingDeletes.set(key, { ids, timer, refresh });
  emitPending();
  // 同时最多 MEMORY_UNDO_TOAST_LIMIT 条单独的「撤销」；再多的并进一条「已删除 N 条记忆 · 全部撤销」（CB-111）。
  for (const [toastKey, toastId] of singleToasts) if (!toast.isOpen(toastId)) singleToasts.delete(toastKey);
  if (singleToasts.size >= MEMORY_UNDO_TOAST_LIMIT) {
    mergedKeys.add(key);
    syncMergedToast();
    return key;
  }
  const toastId = toast.undo(undoToastText(notes), () => cancelPending(key), MEMORY_UNDO_MS);
  singleToasts.set(key, toastId);
  return key;
}

/** 同时最多几条单独的撤销提示（CB-111）。 */
export const MEMORY_UNDO_TOAST_LIMIT = 3;
/** 待删 key → 它单独的撤销提示 id。 */
const singleToasts = new Map<number, number>();
/** 超出上限、并进合并提示的待删 key。 */
const mergedKeys = new Set<number>();
let mergedToastId = 0;

/** 取消一次待删除。已经开始真删了（计时刚到）就来不及了；否则原记录原样还在。 */
function cancelPending(key: number) {
  const entry = pendingDeletes.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingDeletes.delete(key);
  forgetToast(key);
  emitPending();
}

/** 待删除结束（撤销/真删/失败/关页）后，把它从提示里拿掉。 */
function forgetToast(key: number) {
  singleToasts.delete(key);
  if (mergedKeys.delete(key)) syncMergedToast();
}

/** 合并提示：数的是合并进来的记忆条数；「全部撤销」只撤合并进来的，单独显示的各自撤销。 */
function syncMergedToast() {
  const count = [...mergedKeys].reduce((sum, key) => sum + (pendingDeletes.get(key)?.ids.length ?? 0), 0);
  if (!mergedKeys.size || !count) {
    mergedKeys.clear();
    if (mergedToastId) toast.dismiss(mergedToastId);
    mergedToastId = 0;
    return;
  }
  const text = `已删除 ${count} 条记忆`;
  if (mergedToastId && toast.isOpen(mergedToastId)) {
    toast.update(mergedToastId, text);
    return;
  }
  // 不自动消失：最后一条合并的待删除结束时才收起，保证每条在 8 秒内都还能撤销。
  let id = 0;
  id = toast.action(
    text,
    "全部撤销",
    () => {
      // 先把合并的 key 全拿出来再逐个撤销：否则每撤一条都会 syncMergedToast，
      // 而 mergedToastId 已清零，会新建一条「已删除 N 条记忆」又马上收掉（闪烁，CB-111 QA）。
      if (mergedToastId === id) mergedToastId = 0;
      const keys = [...mergedKeys];
      mergedKeys.clear();
      for (const key of keys) cancelPending(key);
    },
    Number.POSITIVE_INFINITY,
  );
  mergedToastId = id;
}

/** 清掉所有待删除和撤销提示的记账（只给测试用：模块级状态，同进程跑多个测试文件时不串）。不发删除请求。 */
export function resetMemoryUndoForTest() {
  for (const entry of pendingDeletes.values()) clearTimeout(entry.timer);
  pendingDeletes.clear();
  flushedIds.clear();
  flushedRefreshes.clear();
  singleToasts.clear();
  mergedKeys.clear();
  mergedToastId = 0;
  emitPending();
}

/** 删一条也先确认（和技能页一致，CB-106）；确认后仍有 8 秒撤销。 */
export async function confirmNoteDelete(note: MemoryNoteView) {
  const title = note.subject ?? note.content.split("\n")[0] ?? "";
  return confirmDialog({
    title: `删除记忆「${title.length > 40 ? `${title.slice(0, 40)}…` : title}」？`,
    description: "所有机器人都不会再记得这条内容。删除后 8 秒内可以撤销。",
    confirmLabel: "删除",
    destructive: true,
  });
}

export async function confirmBulkDelete(count: number, query: string) {
  return confirmDialog({
    title: `删除和「${query}」有关的 ${count} 条记忆？`,
    description: "所有机器人都不会再记得这些内容。删除后 8 秒内可以撤销。",
    confirmLabel: "删除",
    destructive: true,
  });
}

export function SearchBox({ value, onChange, placeholder = "搜索记忆" }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="mem-search">
      <IconSearch aria-hidden className="size-4" />
      <input aria-label={placeholder} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type="search" value={value} />
    </label>
  );
}
