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
  useEffect(() => {
    if (!open) return;
    setForm(
      note
        ? { kind: note.kind, subject: note.subject ?? "", content: note.content, context: note.context ?? "", shared: Boolean(note.shared) }
        : {
            kind: preset?.kind ?? "preference",
            subject: preset?.subject ?? "",
            content: "",
            context: preset?.context ?? "",
            shared: Boolean(preset?.shared),
          },
    );
    save.reset();
  }, [open, note, preset]);
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
  const valid = form.content.trim().length > 0 && (!needsSubject || form.subject.trim().length > 0);
  const isKnowledgePreset = Boolean(!note && preset?.subject?.startsWith("[知识库]"));
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
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

/** 删掉（可撤销：撤销 = 原样重建）。 */
export async function deleteWithUndo(notes: MemoryNoteView[], refresh: () => Promise<unknown>, hide: (ids: string[] | null) => void) {
  const ids = notes.map((note) => note.id);
  hide(ids);
  try {
    await deleteMemoryNotes(ids);
  } catch (error) {
    hide(null);
    toast.error(error instanceof Error ? error.message : "删除失败");
    return;
  }
  await refresh();
  hide(null);
  toast.undo(notes.length === 1 ? "已删除 1 条记忆" : `已删除 ${notes.length} 条记忆`, async () => {
    try {
      for (const note of notes) await createMemoryNote({ kind: note.kind, subject: note.subject, content: note.content, context: note.context });
      await refresh();
    } catch {
      toast.error("恢复失败");
    }
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
