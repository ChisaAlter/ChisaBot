import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import {
  IconCheck,
  IconCode,
  IconEdit,
  IconEye,
  IconMessageForward,
  IconPlayerPlay,
  IconPlus,
  IconRobot,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { ClientError } from "@/lib/client";
import {
  taskCenterApi,
  taskCenterCapabilityOptions,
  taskCenterKeys,
} from "@/lib/task-center-api";
import {
  type MarkdownBoardCard,
  type MarkdownBoardSnapshot,
  TASK_BOARD_COLUMN_LABELS,
  TASK_HORIZON_LABELS,
} from "../../../../shared/task-board-core";
import {
  TASK_HORIZON_LANES,
  TASK_LEVEL_LABELS,
  TASK_LEVELS,
  type TaskHorizonLane,
  type TaskLevel,
} from "../../../../shared/task-center";
import {
  normalizeMarkdownDeshout,
  parseCardBodyForView,
} from "./board-format";
import { formatExecutorLabel, STATUS_LABELS } from "./labels";
import { MarkdownOverlayEditor } from "./markdown-overlay-editor";

export { buildBoardCardChatPrompt } from "./board-format";

function renderInlineCodeSegments(text: string, lineKey: number): ReactNode[] {
  const segments = text.split(/(`[^`]+`)/g);
  let offset = 0;
  return segments.map((seg) => {
    const key = `${lineKey}:${offset}`;
    offset += seg.length;
    if (seg.startsWith("`") && seg.endsWith("`") && seg.length >= 2) {
      return (
        <code className="tc-board-inline-code" key={key}>
          {seg.slice(1, -1)}
        </code>
      );
    }
    return <span key={key}>{seg}</span>;
  });
}

export function BoardCardDetailDialog({
  board,
  card,
  onClose,
  onUpdated,
  onOpenTask,
  onSendToChat,
}: {
  board: MarkdownBoardSnapshot;
  card: MarkdownBoardCard | null;
  onClose: () => void;
  onUpdated: (board: MarkdownBoardSnapshot) => void;
  onOpenTask: (taskId: string) => void;
  onSendToChat: (card: MarkdownBoardCard) => void;
}) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={Boolean(card)}
    >
      {card ? (
        <BoardCardDetailContent
          board={board}
          card={card}
          key={`${board.boardId}:${card.id}`}
          onClose={onClose}
          onOpenTask={onOpenTask}
          onSendToChat={onSendToChat}
          onUpdated={onUpdated}
        />
      ) : null}
    </Dialog>
  );
}

function BoardCardDetailContent({
  board,
  card,
  onClose,
  onUpdated,
  onOpenTask,
  onSendToChat,
}: {
  board: MarkdownBoardSnapshot;
  card: MarkdownBoardCard;
  onClose: () => void;
  onUpdated: (board: MarkdownBoardSnapshot) => void;
  onOpenTask: (taskId: string) => void;
  onSendToChat: (card: MarkdownBoardCard) => void;
}) {
  const queryClient = useQueryClient();
  const agents = useQuery(agentListQueryOptions());
  const capabilities = useQuery(taskCenterCapabilityOptions());
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(card.title);
  const [draftBody, setDraftBody] = useState(card.body);
  const [executor, setExecutor] = useState(card.linkedTask?.executor ?? "bot");
  const [agentId, setAgentId] = useState("");
  const [level, setLevel] = useState<TaskLevel>(3);

  const executors =
    capabilities.data?.capabilities.filter(
      (entry) => entry.kind === "executor",
    ) ?? [];
  const parsedBody = useMemo(
    () => parseCardBodyForView(card.body),
    [card.body],
  );

  function handleBoardConflict(error: unknown, fallback: string) {
    if (error instanceof ClientError && error.status === 409) {
      toast.info(error.message);
      void queryClient.invalidateQueries({
        queryKey: taskCenterKeys.boardView(board.boardId),
      });
      return;
    }
    toast.error(error instanceof Error ? error.message : fallback);
  }

  const toggleCheckbox = useMutation({
    mutationFn: (input: { checkboxIndex: number; checked: boolean }) =>
      taskCenterApi.toggleBoardCheckbox({
        boardId: board.boardId,
        baseRevision: board.revision,
        cardId: card.id,
        checkboxIndex: input.checkboxIndex,
        checked: input.checked,
      }),
    onSuccess: (res) => {
      onUpdated(res.board);
    },
    onError: (err) => handleBoardConflict(err, "更新勾选状态失败。"),
  });

  const saveCard = useMutation({
    mutationFn: () =>
      taskCenterApi.updateBoardCard({
        boardId: board.boardId,
        baseRevision: board.revision,
        cardId: card.id,
        title: draftTitle.trim() || card.title,
        body: draftBody,
      }),
    onSuccess: (res) => {
      onUpdated(res.board);
      setEditing(false);
      toast.success(`已保存卡片 ${card.id}`);
    },
    onError: (err) => handleBoardConflict(err, "保存卡片失败。"),
  });

  const dispatchCard = useMutation({
    mutationFn: () =>
      taskCenterApi.dispatchBoardCard({
        boardId: board.boardId,
        cardId: card.id,
        executor,
        agentId: executor === "bot" ? agentId || null : null,
        level,
        risk: "internal",
        start: true,
      }),
    onSuccess: (res) => {
      onUpdated(res.board);
      void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
      toast.success(
        `已交给${formatExecutorLabel(res.task.executor, executors)}推进，完成后会自动回写卡片摘要`,
      );
    },
    onError: (err) => {
      if (err instanceof ClientError && err.status === 409) {
        toast.info(err.message);
        void queryClient.invalidateQueries({
          queryKey: taskCenterKeys.boardView(board.boardId),
        });
        void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
        return;
      }
      toast.error(err instanceof Error ? err.message : "派发卡片任务失败。");
    },
  });

  return (
    <DialogContent
      className="max-h-[85svh] w-[calc(100%-2rem)] max-w-2xl"
      overlayClassName="bg-black/45"
    >
      <DialogHeader className="shrink-0 pr-8">
        <div className="tc-board-detail-badges">
          <span className="tc-board-id-chip">{card.id}</span>
          <span className="tc-chip" data-lane={card.lane}>
            {TASK_BOARD_COLUMN_LABELS[card.lane]}
          </span>
          {card.lane === "shipped" ? (
            <span className="tc-chip tc-board-provenance-chip">
              {`原属：${TASK_HORIZON_LABELS[card.filedIn]}`}
            </span>
          ) : null}
          {card.blocked ? (
            <span className="tc-chip tc-board-blocked-chip">{"阻塞中"}</span>
          ) : null}
          {card.size ? <span className="tc-chip">{card.size}</span> : null}
          {[...new Set(card.tags)].map((tag) => (
            <span className="tc-chip" key={tag}>
              {tag}
            </span>
          ))}
        </div>
        <DialogTitle className="mt-1 text-base">
          {normalizeMarkdownDeshout(card.title)}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {`${card.sourceFile}:${card.line}`}
          {board.writable ? "" : " · 只读文件"}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
        {editing && board.writable ? (
          <div className="flex flex-col gap-3">
            <label className="tc-field">
              {"卡片标题"}
              <Input
                onChange={(e) => setDraftTitle(e.target.value)}
                value={draftTitle}
              />
            </label>
            <div className="tc-field">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{"Markdown 正文（Ctrl/Cmd+S 保存，Esc 取消）"}</span>
                <span>{"整块写回，不改动其他卡片"}</span>
              </div>
              <MarkdownOverlayEditor
                ariaLabel={`编辑卡片 ${card.id} 的 Markdown 正文`}
                onCancel={() => setEditing(false)}
                onChange={setDraftBody}
                onSave={() => saveCard.mutate()}
                value={draftBody}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {parsedBody.specs.length > 0 ? (
              <dl className="tc-board-spec-grid">
                {parsedBody.specs.map((spec) => (
                  <div className="tc-board-spec-pill" key={spec.id}>
                    <dt>{spec.key}</dt>
                    <dd>{normalizeMarkdownDeshout(spec.value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            <div className="tc-board-body-view">
              {parsedBody.elements.length === 0 &&
              parsedBody.specs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {"这张卡片还没有正文补充说明。"}
                </p>
              ) : null}
              {parsedBody.elements.map((item) => {
                if (item.kind === "code") {
                  return (
                    <pre className="tc-board-code-block" key={item.key}>
                      <code>{item.content}</code>
                    </pre>
                  );
                }
                if (item.kind === "checkbox") {
                  return (
                    <label
                      className="tc-board-checkbox-row"
                      data-checked={item.checked || undefined}
                      key={item.key}
                    >
                      <input
                        checked={item.checked}
                        disabled={!board.writable || toggleCheckbox.isPending}
                        onChange={() =>
                          toggleCheckbox.mutate({
                            checkboxIndex: item.checkboxIndex,
                            checked: !item.checked,
                          })
                        }
                        type="checkbox"
                      />
                      <span>
                        {renderInlineCodeSegments(item.text, item.key)}
                      </span>
                    </label>
                  );
                }
                if (item.kind === "heading") {
                  return (
                    <h4 className="tc-board-prose-heading" key={item.key}>
                      {item.text}
                    </h4>
                  );
                }
                if (item.kind === "quote") {
                  return (
                    <blockquote className="tc-board-prose-quote" key={item.key}>
                      {renderInlineCodeSegments(item.text, item.key)}
                    </blockquote>
                  );
                }
                return (
                  <p className="tc-board-prose-p" key={item.key}>
                    {renderInlineCodeSegments(item.text, item.key)}
                  </p>
                );
              })}
            </div>
          </div>
        )}

        <section className="tc-board-dispatch-box">
          <div className="tc-board-dispatch-head">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <IconRobot aria-hidden className="size-4" />
              {"ChisaBot 自动化协同"}
            </span>
            {card.linkedTask ? (
              <Button
                onClick={() => {
                  if (card.linkedTask) onOpenTask(card.linkedTask.id);
                }}
                size="xs"
                variant="outline"
              >
                <IconEye aria-hidden className="size-3.5" />
                {`关联任务：${STATUS_LABELS[card.linkedTask.status]}`}
              </Button>
            ) : null}
          </div>

          {card.linkedTask ? (
            <div className="tc-board-linked-summary">
              <p className="text-xs text-muted-foreground">
                {`执行方式：${formatExecutorLabel(card.linkedTask.executor, executors)}`}
              </p>
              {card.linkedTask.summary ? (
                <p className="text-sm">{card.linkedTask.summary}</p>
              ) : null}
              {card.linkedTask.error ? (
                <p className="tc-error text-xs">{card.linkedTask.error}</p>
              ) : null}
            </div>
          ) : null}

          <div className="tc-board-dispatch-grid">
            <label className="tc-field">
              {"执行方式"}
              <select
                className="tc-select"
                onChange={(e) => setExecutor(e.target.value)}
                value={executor}
              >
                <option value="bot">{"ChisaBot 机器人"}</option>
                {executors
                  .filter((entry) => entry.id !== "bot")
                  .map((entry) => (
                    <option
                      disabled={!entry.available}
                      key={entry.id}
                      value={entry.id}
                    >
                      {entry.name}
                    </option>
                  ))}
              </select>
            </label>

            {executor === "bot" && (agents.data?.length ?? 0) > 0 ? (
              <label className="tc-field">
                {"指定机器人"}
                <select
                  className="tc-select"
                  onChange={(e) => setAgentId(e.target.value)}
                  value={agentId}
                >
                  <option value="">{"使用主智能体"}</option>
                  {agents.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="tc-field">
              {"自主级别"}
              <select
                className="tc-select"
                onChange={(e) => {
                  const nextLevel = Number(e.target.value);
                  if (TASK_LEVELS.includes(nextLevel as TaskLevel)) {
                    setLevel(nextLevel as TaskLevel);
                  }
                }}
                value={level}
              >
                {TASK_LEVELS.map((n) => (
                  <option key={n} value={n}>
                    {TASK_LEVEL_LABELS[n]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {
              "派发后会自动创建关联任务；执行成功后系统将自动把此卡片标为已完成并附上交付摘要。"
            }
          </p>
        </section>
      </DialogBody>

      <DialogFooter className="shrink-0 flex-wrap justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => onSendToChat(card)}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconMessageForward aria-hidden className="size-3.5" />
            {"发到当前对话"}
          </Button>
          {board.writable ? (
            editing ? (
              <>
                <Button
                  disabled={saveCard.isPending}
                  mutation={saveCard}
                  onClick={() => saveCard.mutate()}
                  size="sm"
                  type="button"
                >
                  <IconCheck aria-hidden className="size-3.5" />
                  {"保存源码"}
                </Button>
                <Button
                  onClick={() => {
                    setDraftTitle(card.title);
                    setDraftBody(card.body);
                    setEditing(false);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {"取消编辑"}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => {
                  setDraftTitle(card.title);
                  setDraftBody(card.body);
                  setEditing(true);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconCode aria-hidden className="size-3.5" />
                {"编辑源码"}
              </Button>
            )
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onClose} size="sm" type="button" variant="ghost">
            {"关闭"}
          </Button>
          <Button
            disabled={dispatchCard.isPending}
            mutation={dispatchCard}
            onClick={() => dispatchCard.mutate()}
            size="sm"
            type="button"
          >
            <IconPlayerPlay aria-hidden className="size-3.5" />
            {card.linkedTask ? "重新派发执行" : "交给机器人推进"}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}

export function CreateBoardCardDialog({
  board,
  open,
  onOpenChange,
  onCreated,
}: {
  board: MarkdownBoardSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (board: MarkdownBoardSnapshot, cardId: string) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {open ? (
        <CreateBoardCardForm
          board={board}
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      ) : null}
    </Dialog>
  );
}

function CreateBoardCardForm({
  board,
  onClose,
  onCreated,
}: {
  board: MarkdownBoardSnapshot;
  onClose: () => void;
  onCreated: (board: MarkdownBoardSnapshot, cardId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [lane, setLane] = useState<TaskHorizonLane>("now");
  const [size, setSize] = useState("M");
  const [tagsText, setTagsText] = useState("");
  const [body, setBody] = useState("- [ ] 明确验收标准\n- [ ] 完成实现与验证");

  const create = useMutation({
    mutationFn: () =>
      taskCenterApi.createBoardCard({
        boardId: board.boardId,
        baseRevision: board.revision,
        title: title.trim(),
        lane,
        size: size.trim() || undefined,
        tags: tagsText
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        body,
      }),
    onSuccess: (res) => {
      onCreated(res.board, res.cardId);
      onClose();
      toast.success(`已新增卡片 ${res.cardId}`);
    },
    onError: (err) => {
      if (err instanceof ClientError && err.status === 409) {
        toast.info(err.message);
        void queryClient.invalidateQueries({
          queryKey: taskCenterKeys.boardView(board.boardId),
        });
        return;
      }
      toast.error(err instanceof Error ? err.message : "新建看板卡片失败。");
    },
  });

  return (
    <DialogContent
      className="max-h-[85svh] w-[calc(100%-2rem)] max-w-xl"
      overlayClassName="bg-black/45"
    >
      <DialogHeader className="shrink-0">
        <DialogTitle className="flex items-center gap-1.5 text-base">
          <IconEdit aria-hidden className="size-4" />
          {"新建看板卡片"}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {`写入 ${board.backlogFile}（${board.dialect === "chisabot-docs" ? "自动登记 ROADMAP + BACKLOG" : "Autobahn 格式"}）`}
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex min-h-0 flex-1 flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          create.mutate();
        }}
      >
        <DialogBody className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          <label className="tc-field">
            {"标题"}
            <Input
              onChange={(e) => setTitle(e.target.value)}
              placeholder="简述目标或要交付的结果"
              required
              value={title}
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="tc-field">
              {"归属泳道"}
              <select
                className="tc-select"
                onChange={(e) => setLane(e.target.value as TaskHorizonLane)}
                value={lane}
              >
                {TASK_HORIZON_LANES.map((item) => (
                  <option key={item} value={item}>
                    {TASK_HORIZON_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>
            <label className="tc-field">
              {"体量（可选）"}
              <Input
                onChange={(e) => setSize(e.target.value)}
                placeholder="S / M / L"
                value={size}
              />
            </label>
            <label className="tc-field">
              {"标签（逗号分隔）"}
              <Input
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="ui, server"
                value={tagsText}
              />
            </label>
          </div>
          <div className="tc-field">
            <span>{"Markdown 正文"}</span>
            <MarkdownOverlayEditor
              ariaLabel="新建卡片 Markdown 正文"
              minRows={8}
              onChange={setBody}
              onSave={() => {
                if (title.trim()) create.mutate();
              }}
              value={body}
            />
          </div>
        </DialogBody>
        <DialogFooter className="shrink-0">
          <Button onClick={onClose} size="sm" type="button" variant="ghost">
            {"取消"}
          </Button>
          <Button
            disabled={!title.trim() || create.isPending}
            mutation={create}
            size="sm"
            type="submit"
          >
            <IconPlus aria-hidden className="size-3.5" />
            {"创建卡片"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
