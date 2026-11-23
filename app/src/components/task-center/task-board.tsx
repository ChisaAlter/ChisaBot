import {
  IconChevronRight,
  IconFileText,
  IconFolderPlus,
  IconLayoutKanban,
  IconLock,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import { PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContentEnter, SmoothCollapse } from "@/components/ui/motion-primitives";
import { toast } from "@/components/ui/toast";
import { sendPromptToChat } from "@/lib/chat/quote-event";
import {
  taskCenterBoardDocOptions,
  taskCenterBoardsOptions,
  taskCenterBoardViewOptions,
  taskCenterKeys,
} from "@/lib/task-center-api";
import {
  DEFAULT_LANE_PRIORITY,
  type MarkdownBoardCard,
  type MarkdownBoardSnapshot,
  resolveTaskBoardPlacement,
  TASK_BOARD_COLUMN_LABELS,
  TASK_BOARD_COLUMNS,
  type TaskBoardColumn,
} from "../../../../shared/task-board-core";
import {
  TASK_HORIZON_LANES,
  type TaskCenterTask,
  type TaskHorizonLane,
} from "../../../../shared/task-center";
import {
  buildBoardCardChatPrompt,
  normalizeMarkdownDeshout,
} from "./board-format";
import { buildTaskChatPrompt } from "./labels";
import { MarkdownBoardCardItem, PersonalBoardCardItem } from "./task-board-card";
import { BoardCardDetailDialog, CreateBoardCardDialog } from "./task-board-detail";
import { TaskBoardDocPanel } from "./task-board-doc-panel";
import { type DocDraftState, useBoardMutations } from "./use-board-mutations";

type DragCandidate = {
  id: string;
  sourceLane: TaskHorizonLane;
  startX: number;
  startY: number;
  pointerId: number;
  captured: boolean;
};

type DropTarget = {
  lane: TaskHorizonLane;
  beforeId: string | null;
};

const HORIZON_SET = new Set<string>(TASK_HORIZON_LANES);

function isHorizonLane(value: string): value is TaskHorizonLane {
  return HORIZON_SET.has(value);
}

function findDropTargetAtPoint(
  clientX: number,
  clientY: number,
  draggedId: string,
): DropTarget | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const hit = document.elementFromPoint(clientX, clientY);
  if (!(hit instanceof HTMLElement)) return null;
  const colEl = hit.closest<HTMLElement>("[data-drop-lane]");
  const laneAttr = colEl?.dataset.dropLane ?? "";
  if (!isHorizonLane(laneAttr)) return null;
  const lane = laneAttr;
  const cardEl = hit.closest<HTMLElement>("[data-board-card-id]");
  const hoveredId = cardEl?.dataset.boardCardId ?? "";
  if (!cardEl || !hoveredId || hoveredId === draggedId) {
    return { lane, beforeId: null };
  }
  const rect = cardEl.getBoundingClientRect();
  if (clientY <= rect.top + rect.height / 2) {
    return { lane, beforeId: hoveredId };
  }
  const nextSibling = cardEl.nextElementSibling;
  const nextId =
    nextSibling instanceof HTMLElement
      ? (nextSibling.dataset.boardCardId ?? null)
      : null;
  return {
    lane,
    beforeId: nextId && nextId !== draggedId ? nextId : null,
  };
}

export function TaskBoard({
  tasks,
  onOpenTask,
  onOpenSources,
  onCloseCenter,
  onSentToChat,
}: {
  tasks: TaskCenterTask[];
  onOpenTask: (id: string) => void;
  onOpenSources?: () => void;
  onCloseCenter?: () => void;
  onSentToChat?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedMode, setSelectedMode] = useState<string>("personal");
  const [selectedDocFile, setSelectedDocFile] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [mobileColumn, setMobileColumn] = useState<TaskBoardColumn>("now");
  const [docDrafts, setDocDrafts] = useState<Record<string, DocDraftState>>({});

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dragCandidateRef = useRef<DragCandidate | null>(null);
  const suppressClickIdRef = useRef<string | null>(null);

  const boardsQuery = useQuery(taskCenterBoardsOptions());
  const boards = boardsQuery.data?.boards ?? [];
  const availableRoots = boardsQuery.data?.availableRoots ?? [];
  const uninitializedRoots = availableRoots.filter((r) => !r.hasBoard);
  const activeBoardId =
    selectedMode !== "personal" && boards.some((b) => b.boardId === selectedMode)
      ? selectedMode
      : "";

  const boardViewQuery = useQuery(taskCenterBoardViewOptions(activeBoardId));
  const board = boardViewQuery.data?.board;

  const activeDocRelFile =
    board && selectedDocFile && board.docs.some((d) => d.relFile === selectedDocFile)
      ? selectedDocFile
      : "";
  const docQuery = useQuery(
    taskCenterBoardDocOptions(board?.boardId ?? "", activeDocRelFile),
  );

  function clearDraft(cacheKey: string) {
    setDocDrafts((prev) => {
      if (!(cacheKey in prev)) return prev;
      const next = { ...prev };
      delete next[cacheKey];
      return next;
    });
  }

  const {
    schedulePersonal,
    initBoard,
    moveMarkdownCard,
    dispatchCardQuick,
    saveDoc,
  } = useBoardMutations({
    queryClient,
    onBoardInitialized: (created) => {
      setSelectedMode(created.boardId);
      setSelectedDocFile(null);
    },
    onDocSaved: clearDraft,
  });

  function notifySentToChat(text: string) {
    sendPromptToChat(navigate as (opts: never) => unknown, text);
    toast.success("已填入当前对话输入框");
    onCloseCenter?.();
    onSentToChat?.();
  }

  function startDragCandidate(
    event: ReactPointerEvent<HTMLElement>,
    id: string,
    sourceLane: TaskHorizonLane,
    movable: boolean,
  ) {
    if (!movable || event.button !== 0) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("button, a, input, select, [role='menuitem']")
    ) {
      return;
    }
    dragCandidateRef.current = {
      id,
      sourceLane,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      captured: false,
    };
  }

  function handleBoardPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const candidate = dragCandidateRef.current;
    if (!candidate) return;
    const dx = event.clientX - candidate.startX;
    const dy = event.clientY - candidate.startY;
    if (!draggingId) {
      if (Math.hypot(dx, dy) < 6) return;
      if (!candidate.captured) {
        candidate.captured = true;
        try {
          event.currentTarget.setPointerCapture?.(candidate.pointerId);
        } catch {
          // 合成事件或无真实指针时不阻断拖拽
        }
      }
      setDraggingId(candidate.id);
    }
    setDropTarget(findDropTargetAtPoint(event.clientX, event.clientY, candidate.id));
  }

  function finishDrag(commit: boolean) {
    const candidate = dragCandidateRef.current;
    const activeId = draggingId;
    const target = dropTarget;
    dragCandidateRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
    if (!commit || !candidate || !activeId || !target) return;
    suppressClickIdRef.current = activeId;

    if (activeBoardId && board) {
      if (target.lane === candidate.sourceLane && target.beforeId === null) {
        return;
      }
      moveMarkdownCard.mutate({
        boardId: board.boardId,
        baseRevision: board.revision,
        cardId: activeId,
        targetLane: target.lane,
        beforeCardId: target.beforeId,
      });
      return;
    }

    if (target.lane !== candidate.sourceLane) {
      schedulePersonal.mutate({
        id: activeId,
        lane: target.lane,
        priority: DEFAULT_LANE_PRIORITY[target.lane],
      });
    }
  }

  function consumeSuppressedClick(id: string): boolean {
    if (suppressClickIdRef.current === id) {
      suppressClickIdRef.current = null;
      return true;
    }
    return false;
  }

  const normalizedQuery = search.trim().toLowerCase();

  const personalBuckets: Record<
    TaskBoardColumn,
    Array<{
      task: TaskCenterTask;
      filedIn: TaskHorizonLane;
      cardId: string | null;
    }>
  > = { now: [], next: [], later: [], shipped: [] };

  for (const task of tasks) {
    if (normalizedQuery) {
      const hay = `${task.title} ${task.description} ${task.summary ?? ""}`.toLowerCase();
      if (!hay.includes(normalizedQuery)) continue;
    }
    const placement = resolveTaskBoardPlacement(task);
    personalBuckets[placement.column].push({
      task,
      filedIn: placement.filedIn,
      cardId: placement.boardRef?.cardId ?? null,
    });
  }

  const markdownBuckets: Record<TaskBoardColumn, MarkdownBoardCard[]> = {
    now: [],
    next: [],
    later: [],
    shipped: [],
  };
  if (board) {
    for (const card of board.cards) {
      if (normalizedQuery) {
        const hay =
          `${card.id} ${card.title} ${card.tags.join(" ")} ${card.body}`.toLowerCase();
        if (!hay.includes(normalizedQuery)) continue;
      }
      markdownBuckets[card.lane].push(card);
    }
  }

  const selectedCard =
    board?.cards.find((card) => card.id === selectedCardId) ?? null;

  const docCacheKey =
    board && activeDocRelFile ? `${board.boardId}:${activeDocRelFile}` : "";
  const docPayload = docQuery.data?.doc;
  const activeDraft = docCacheKey ? docDrafts[docCacheKey] : undefined;

  function columnCount(col: TaskBoardColumn): number {
    return activeBoardId && board
      ? markdownBuckets[col].length
      : personalBuckets[col].length;
  }

  return (
    <div className="tc-board">
      <div className="tc-board-switcher" role="tablist" aria-label="看板来源切换">
        <button
          aria-selected={activeBoardId === ""}
          className="tc-board-mode-btn"
          data-active={activeBoardId === "" || undefined}
          onClick={() => {
            setSelectedMode("personal");
            setSelectedDocFile(null);
          }}
          role="tab"
          type="button"
        >
          <IconLayoutKanban aria-hidden className="size-3.5" />
          <span>{"个人任务看板"}</span>
          <span className="tc-board-mode-count">{tasks.length}</span>
        </button>

        {boards.map((entry) => (
          <button
            aria-selected={activeBoardId === entry.boardId}
            className="tc-board-mode-btn"
            data-active={activeBoardId === entry.boardId || undefined}
            key={entry.boardId}
            onClick={() => {
              setSelectedMode(entry.boardId);
              setSelectedDocFile(null);
            }}
            role="tab"
            type="button"
          >
            <IconFileText aria-hidden className="size-3.5" />
            <span>{entry.label}</span>
            <span className="tc-board-dialect-badge">
              {entry.dialect === "chisabot-docs" ? "ROADMAP+BACKLOG" : "Autobahn"}
            </span>
            <span className="tc-board-mode-count">{entry.cardCount}</span>
          </button>
        ))}

        {uninitializedRoots.map((root) => (
          <Button
            disabled={initBoard.isPending}
            key={root.path}
            mutation={initBoard}
            onClick={() => initBoard.mutate(root.path)}
            size="xs"
            type="button"
            variant="outline"
          >
            <IconFolderPlus aria-hidden className="size-3.5" />
            {`初始化 ${root.label} 看板`}
          </Button>
        ))}

        {boards.length === 0 && availableRoots.length === 0 && onOpenSources ? (
          <Button
            onClick={onOpenSources}
            size="xs"
            type="button"
            variant="outline"
          >
            <IconFolderPlus aria-hidden className="size-3.5" />
            {"配置授权目录以连接 Markdown 看板"}
          </Button>
        ) : null}
      </div>

      {activeBoardId && board ? (
        <div className="tc-board-subbar">
          <div className="tc-board-doc-tabs" role="tablist" aria-label="文档页签">
            <button
              aria-selected={activeDocRelFile === ""}
              className="tc-board-doc-tab"
              data-active={activeDocRelFile === "" || undefined}
              onClick={() => setSelectedDocFile(null)}
              role="tab"
              type="button"
            >
              {"看板视图"}
            </button>
            {board.docs.map((docTab) => (
              <button
                aria-selected={activeDocRelFile === docTab.relFile}
                className="tc-board-doc-tab"
                data-active={activeDocRelFile === docTab.relFile || undefined}
                key={docTab.relFile}
                onClick={() => setSelectedDocFile(docTab.relFile)}
                role="tab"
                type="button"
              >
                {docTab.name}
                {!docTab.writable ? (
                  <IconLock aria-hidden className="size-3" />
                ) : null}
              </button>
            ))}
          </div>

          <div className="tc-board-toolbar-right">
            {activeDocRelFile === "" ? (
              <div className="tc-board-search-wrap">
                <IconSearch aria-hidden className="size-3.5" />
                <Input
                  aria-label="筛选看板卡片"
                  className="tc-board-search-input"
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="筛选编号、标题或标签"
                  value={search}
                />
              </div>
            ) : null}
            {!board.writable ? (
              <span className="tc-chip">
                <IconLock aria-hidden className="size-3" />
                {"只读"}
              </span>
            ) : activeDocRelFile === "" ? (
              <Button
                onClick={() => setCreateOpen(true)}
                size="sm"
                type="button"
              >
                <IconPlus aria-hidden className="size-3.5" />
                {"新建卡片"}
              </Button>
            ) : null}
            <Button
              aria-label="刷新看板"
              onClick={() => {
                void queryClient.invalidateQueries({
                  queryKey: taskCenterKeys.boardView(board.boardId),
                });
                if (activeDocRelFile) {
                  void queryClient.invalidateQueries({
                    queryKey: taskCenterKeys.boardDoc(
                      board.boardId,
                      activeDocRelFile,
                    ),
                  });
                }
              }}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <IconRefresh aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="tc-board-subbar">
          <div className="tc-board-personal-hint">
            <span>
              {"按「现在 / 接下来 / 以后 / 已交付」排期你的个人任务；拖拽或点击卡片右上角菜单即可调整优先级并实时同步队列。"}
            </span>
          </div>
          <div className="tc-board-toolbar-right">
            <div className="tc-board-search-wrap">
              <IconSearch aria-hidden className="size-3.5" />
              <Input
                aria-label="筛选个人任务"
                className="tc-board-search-input"
                onChange={(e) => setSearch(e.target.value)}
                placeholder="筛选任务标题或内容"
                value={search}
              />
            </div>
          </div>
        </div>
      )}

      {activeBoardId && !board && boardViewQuery.isPending ? (
        <PageSkeleton rows={3} />
      ) : null}

      {activeBoardId && board && activeDocRelFile ? (
        <ContentEnter key={`doc:${board.boardId}:${activeDocRelFile}`}>
          <TaskBoardDocPanel
            activeDocRelFile={activeDocRelFile}
            activeDraft={activeDraft}
            boardId={board.boardId}
            docPayload={docPayload}
            isLoading={docQuery.isPending}
            isSaving={saveDoc.isPending}
            onChangeDraft={(baseRevision, content) => {
              if (!docCacheKey) return;
              setDocDrafts((prev) => ({
                ...prev,
                [docCacheKey]: {
                  baseRevision: prev[docCacheKey]?.baseRevision ?? baseRevision,
                  content,
                },
              }));
            }}
            onDiscardDraft={() => {
              if (docCacheKey) clearDraft(docCacheKey);
            }}
            onSaveWithRevision={(baseRevision, content) => {
              if (!docPayload) return;
              saveDoc.mutate({
                boardId: board.boardId,
                baseRevision,
                relFile: docPayload.relFile,
                content,
              });
            }}
          />
        </ContentEnter>
      ) : null}

      {activeBoardId && board && activeDocRelFile === "" && board.pinned ? (
        <section className="tc-board-pinned">
          <button
            aria-expanded={pinnedOpen}
            className="tc-board-pinned-toggle"
            onClick={() => setPinnedOpen((v) => !v)}
            type="button"
          >
            <span className="flex items-center gap-1.5 font-medium">
              <IconPin aria-hidden className="size-3.5" />
              {normalizeMarkdownDeshout(board.pinned.title)}
            </span>
            <IconChevronRight
              aria-hidden
              className={`size-4 shrink-0 transition-transform duration-200 ${pinnedOpen ? "rotate-90" : ""}`}
            />
          </button>
          {board.pinned.body ? (
            <SmoothCollapse open={pinnedOpen}>
              <p className="tc-board-pinned-body">
                {normalizeMarkdownDeshout(board.pinned.body)}
              </p>
            </SmoothCollapse>
          ) : null}
        </section>
      ) : null}

      {!activeBoardId || (board && activeDocRelFile === "") ? (
        <ContentEnter key={`board:${activeBoardId || "personal"}`}>
          <div className="tc-board-mobile-cols" role="tablist" aria-label="看板列切换">
            {TASK_BOARD_COLUMNS.map((col) => (
              <button
                aria-selected={mobileColumn === col}
                className="tc-board-mobile-col-btn"
                data-active={mobileColumn === col || undefined}
                key={col}
                onClick={() => setMobileColumn(col)}
                role="tab"
                type="button"
              >
                {`${TASK_BOARD_COLUMN_LABELS[col]} (${columnCount(col)})`}
              </button>
            ))}
          </div>

          <div
            className="tc-board-columns"
            onLostPointerCapture={() => finishDrag(false)}
            onPointerCancel={() => finishDrag(false)}
            onPointerMove={handleBoardPointerMove}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {
                  // 忽略已释放指针异常
                }
              }
              finishDrag(true);
            }}
          >
            {TASK_BOARD_COLUMNS.map((col) => {
              const horizonCol = isHorizonLane(col) ? col : null;
              const isDropHere = Boolean(
                draggingId && dropTarget && dropTarget.lane === col,
              );
              const label =
                activeBoardId && board && horizonCol
                  ? board.lanes[horizonCol]
                  : TASK_BOARD_COLUMN_LABELS[col];
              const count = columnCount(col);

              return (
                <section
                  aria-label={`${label} 栏`}
                  className="tc-board-col"
                  data-column={col}
                  data-drop-active={isDropHere || undefined}
                  data-drop-lane={horizonCol ?? undefined}
                  data-mobile-active={mobileColumn === col || undefined}
                  key={col}
                >
                  <header className="tc-board-col-head">
                    <h3>{label}</h3>
                    <span className="tc-board-col-count">{count}</span>
                  </header>

                  <div className="tc-board-col-body">
                    {activeBoardId && board ? (
                      markdownBuckets[col].length === 0 ? (
                        <div className="tc-board-col-empty">{"暂无卡片"}</div>
                      ) : (
                        markdownBuckets[col].map((card) => (
                          <MarkdownBoardCardItem
                            boardWritable={board.writable}
                            card={card}
                            insertBefore={Boolean(
                              isDropHere && dropTarget?.beforeId === card.id,
                            )}
                            isDragging={draggingId === card.id}
                            key={card.id}
                            onDispatch={() =>
                              dispatchCardQuick.mutate({
                                boardId: board.boardId,
                                cardId: card.id,
                              })
                            }
                            onMove={(lane) =>
                              moveMarkdownCard.mutate({
                                boardId: board.boardId,
                                baseRevision: board.revision,
                                cardId: card.id,
                                targetLane: lane,
                                beforeCardId: null,
                              })
                            }
                            onOpen={() => {
                              if (consumeSuppressedClick(card.id)) return;
                              setSelectedCardId(card.id);
                            }}
                            onSendToChat={() =>
                              notifySentToChat(buildBoardCardChatPrompt(card))
                            }
                            onStartDrag={(e, movable) =>
                              startDragCandidate(e, card.id, card.filedIn, movable)
                            }
                          />
                        ))
                      )
                    ) : personalBuckets[col].length === 0 ? (
                      <div className="tc-board-col-empty">{"暂无任务"}</div>
                    ) : (
                      personalBuckets[col].map(({ task, filedIn, cardId }) => (
                        <PersonalBoardCardItem
                          cardId={cardId}
                          filedIn={filedIn}
                          inShipped={col === "shipped"}
                          insertBefore={Boolean(
                            isDropHere && dropTarget?.beforeId === task.id,
                          )}
                          isDragging={draggingId === task.id}
                          key={task.id}
                          onMove={(lane) =>
                            schedulePersonal.mutate({
                              id: task.id,
                              lane,
                              priority: DEFAULT_LANE_PRIORITY[lane],
                            })
                          }
                          onOpen={() => {
                            if (consumeSuppressedClick(task.id)) return;
                            onOpenTask(task.id);
                          }}
                          onSendToChat={() =>
                            notifySentToChat(buildTaskChatPrompt(task))
                          }
                          onStartDrag={(e, movable) =>
                            startDragCandidate(e, task.id, filedIn, movable)
                          }
                          onStartNow={() =>
                            schedulePersonal.mutate({
                              id: task.id,
                              lane: "now",
                              priority: DEFAULT_LANE_PRIORITY.now,
                              start: true,
                            })
                          }
                          task={task}
                        />
                      ))
                    )}
                    {isDropHere && dropTarget?.beforeId === null ? (
                      <div className="tc-board-drop-line" />
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        </ContentEnter>
      ) : null}

      {board ? (
        <>
          <BoardCardDetailDialog
            board={board}
            card={selectedCard}
            onClose={() => setSelectedCardId(null)}
            onOpenTask={(id) => {
              setSelectedCardId(null);
              onOpenTask(id);
            }}
            onSendToChat={(card) => {
              setSelectedCardId(null);
              notifySentToChat(buildBoardCardChatPrompt(card));
            }}
            onUpdated={(nextBoard: MarkdownBoardSnapshot) => {
              queryClient.setQueryData(
                taskCenterKeys.boardView(nextBoard.boardId),
                { board: nextBoard },
              );
            }}
          />
          <CreateBoardCardDialog
            board={board}
            onCreated={(nextBoard) => {
              queryClient.setQueryData(
                taskCenterKeys.boardView(nextBoard.boardId),
                { board: nextBoard },
              );
            }}
            onOpenChange={setCreateOpen}
            open={createOpen}
          />
        </>
      ) : null}
    </div>
  );
}
