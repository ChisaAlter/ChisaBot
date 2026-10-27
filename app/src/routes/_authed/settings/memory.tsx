import { IconBook, IconPlus, IconSparkles, IconWorld } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { MEMORY_KIND_LABELS, MEMORY_KINDS, type MemoryKind, type MemoryNoteView } from "../../../../../shared/memory-notes";
import { PageEmpty, PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import {
  confirmBulkDelete,
  deleteWithUndo,
  matches,
  MemoryBots,
  NoteDialog,
  NoteRow,
  SearchBox,
} from "@/components/memory/memory-notes";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { Card, ErrorCard, Toolbar } from "@/components/ui/skyglass";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { dreamMemoryNotes, memoryNoteKeys, memoryNotesQueryOptions } from "@/lib/memory-notes";

export const Route = createFileRoute("/_authed/settings/memory")({
  component: MemoryPage,
});

/**
 * 设置 → 记忆（DESIGN.md §50）：机器人替你记住的笔记。你的所有机器人共用；可以按机器人关掉。
 * 管理员还可直接录入与维护「公共知识库（🌐）」，供全员及所有机器人共享。
 */
function MemoryPage() {
  const queryClient = useQueryClient();
  const { data: user } = useQuery(currentUserQueryOptions());
  const isAdmin = user?.role === "admin";
  const list = useQuery(memoryNotesQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const [filter, setFilter] = useState<MemoryKind | "all">("all");
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<{
    open: boolean;
    note: MemoryNoteView | null;
    preset?: { kind?: MemoryKind; subject?: string; context?: string; shared?: boolean } | null;
  }>({ open: false, note: null, preset: null });
  const botName = useMemo(() => new Map((bots.data ?? []).map((bot) => [bot.id, bot.name])), [bots.data]);
  const notes = (list.data?.notes ?? []).filter((note) => !hidden.has(note.id));
  const counts = useMemo(() => {
    const out = new Map<MemoryKind, number>();
    for (const note of notes) out.set(note.kind, (out.get(note.kind) ?? 0) + 1);
    return out;
  }, [notes]);
  const shown = notes.filter((note) => (filter === "all" || note.kind === filter) && matches(note, query));
  const disabledBots = useMemo(() => new Set((list.data?.bots ?? []).filter((bot) => !bot.enabled).map((bot) => bot.agentId)), [list.data]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: memoryNoteKeys.all });
  const hide = (ids: string[] | null) => setHidden(ids ? new Set(ids) : new Set());
  const groups = MEMORY_KINDS.filter((kind) => filter === "all" || kind === filter)
    .map((kind) => ({ kind, notes: shown.filter((note) => note.kind === kind) }))
    .filter((group) => group.notes.length);
  /*
   * 筛选条是 radiogroup（2026-10-20）：渲染出来的只有「有记录的种类」，方向键要按**渲染顺序**走，
   * 所以先把可见项算出来，钩子和 map 用同一份，不然焦点会落到不存在的项上。
   */
  const kindOptions = (["all", ...MEMORY_KINDS] as const).filter(
    (kind) => kind === "all" || (counts.get(kind) ?? 0) > 0,
  );
  const filterKeys = useSegmentedKeys<MemoryKind | "all">({
    value: filter,
    values: kindOptions,
    onChange: setFilter,
  });

  const dreamAction = useAsyncAction(
    async () => {
      const res = await dreamMemoryNotes();
      await refresh();
      toast.success(res.summary);
    },
    { errorToast: (err) => err.message },
  );

  return (
    <>
      <NoteDialog
        isAdmin={isAdmin}
        note={dialog.note}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        open={dialog.open}
        preset={dialog.preset}
      />
      <PageShell
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="memory-dream-btn"
              feedback={{ pending: "整理中…", success: "已整理", error: "失败" }}
              onClick={() => void dreamAction.run()}
              size="sm"
              state={dreamAction.state}
              variant="outline"
            >
              <IconSparkles />
              {"一键整理记忆"}
            </Button>
            {isAdmin ? (
              <Button
                data-testid="memory-add-shared-knowledge-btn"
                onClick={() =>
                  setDialog({
                    open: true,
                    note: null,
                    preset: {
                      kind: "note",
                      subject: "[知识库] ",
                      context: "公共知识库 · 管理员统一配置",
                      shared: true,
                    },
                  })
                }
                size="sm"
                variant="outline"
              >
                <IconWorld />
                {"录入公共知识库"}
              </Button>
            ) : null}
            <Button
              data-testid="memory-add-knowledge-btn"
              onClick={() =>
                setDialog({
                  open: true,
                  note: null,
                  preset: {
                    kind: "note",
                    subject: "[知识库] ",
                    context: "个人知识库 · 手动录入",
                    shared: false,
                  },
                })
              }
              size="sm"
              variant="outline"
            >
              <IconBook />
              {"录入个人知识库"}
            </Button>
            <Button
              data-testid="memory-add-note-btn"
              onClick={() => setDialog({ open: true, note: null, preset: null })}
              size="sm"
            >
              <IconPlus />
              {"添加"}
            </Button>
          </div>
        }
        description="机器人记住的关于你的事：你的情况、偏好、身边的人、常去的地方、在做的事、每天的日志与知识库条目（📚 个人知识库 / 🌐 公共知识库）。所有机器人共用这份记忆；管理员配置的公共知识库对全员共享。"
        title="记忆"
      >
        {list.isPending ? (
          <PageSkeleton rows={4} />
        ) : list.isError ? (
          <ErrorCard
            action={
              <Button className="mt-2" onClick={() => void list.refetch()} size="sm" variant="outline">
                {"重试"}
              </Button>
            }
            description={list.error.message}
            title="记忆暂时无法读取"
          />
        ) : (
          <>
            <Toolbar className="mem-toolbar">
              <div aria-label={"按种类筛选"} className="sg-segmented mem-seg" {...filterKeys.groupProps} ref={filterKeys.groupRef} role="radiogroup">
                {kindOptions.map((kind) => {
                  const count = kind === "all" ? notes.length : (counts.get(kind) ?? 0);
                  return (
                    <button aria-checked={filter === kind} className="sg-segmented-item" key={kind} onClick={() => setFilter(kind)} role="radio" tabIndex={filterKeys.itemTabIndex(kind)} type="button">
                      <T>{kind === "all" ? "全部" : MEMORY_KIND_LABELS[kind]}</T>
                      <span className="mem-count"><T>{count}</T></span>
                    </button>
                  );
                })}
              </div>
              <SearchBox onChange={setQuery} value={query} />
            </Toolbar>
            {query.trim() && shown.length ? (
              <div className="mem-bulk">
                <span>{`找到 ${shown.length} 条和「${query.trim()}」有关的记忆`}</span>
                <Button
                  onClick={async () => {
                    if (await confirmBulkDelete(shown.length, query.trim())) await deleteWithUndo(shown, refresh, hide);
                  }}
                  size="sm"
                  variant="outline"
                >
                  {"全部删除…"}
                </Button>
              </div>
            ) : null}
            {groups.length ? (
              groups.map((group) => (
                <PageSection key={group.kind} title={`${MEMORY_KIND_LABELS[group.kind]} · ${group.notes.length}`}>
                  <Card className="mem-card">
                    {group.notes.map((note) => (
                      <NoteRow
                        botName={note.agentId ? (botName.get(note.agentId) ?? null) : null}
                        isAdmin={isAdmin}
                        key={note.id}
                        note={note}
                        onDelete={() => void deleteWithUndo([note], refresh, hide)}
                        onEdit={() => setDialog({ open: true, note })}
                      />
                    ))}
                  </Card>
                </PageSection>
              ))
            ) : (
              <PageEmpty>
                {notes.length
                  ? "没有符合条件的记忆。"
                  : "还没有记忆。和机器人聊天时，它会安静地记下值得记住的事；你也可以说「记住…」，或点右上角「添加」。"}
              </PageEmpty>
            )}
            <PageSection description="关掉的机器人不读也不写共用记忆。" title="哪些机器人用记忆">
              <MemoryBots disabled={disabledBots} />
            </PageSection>
          </>
        )}
      </PageShell>
    </>
  );
}
