import {
  IconArrowRight,
  IconDots,
  IconGripVertical,
  IconMessageForward,
  IconPlayerPlay,
  IconRobot,
} from "@tabler/icons-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type MarkdownBoardCard,
  TASK_HORIZON_LABELS,
} from "../../../../shared/task-board-core";
import {
  TASK_HORIZON_LANES,
  type TaskCenterTask,
  type TaskHorizonLane,
} from "../../../../shared/task-center";
import { normalizeMarkdownDeshout } from "./board-format";
import { STATUS_LABELS } from "./labels";

export function MarkdownBoardCardItem({
  card,
  boardWritable,
  isDragging,
  insertBefore,
  onStartDrag,
  onOpen,
  onMove,
  onDispatch,
  onSendToChat,
}: {
  card: MarkdownBoardCard;
  boardWritable: boolean;
  isDragging: boolean;
  insertBefore: boolean;
  onStartDrag: (event: ReactPointerEvent<HTMLElement>, movable: boolean) => void;
  onOpen: () => void;
  onMove: (lane: TaskHorizonLane) => void;
  onDispatch: () => void;
  onSendToChat: () => void;
}) {
  const canMove = boardWritable && card.movable && card.lane !== "shipped";
  return (
    <div>
      {insertBefore ? <div className="tc-board-drop-line" /> : null}
      <article
        className="tc-board-card"
        data-blocked={card.blocked || undefined}
        data-board-card-id={card.id}
        data-dragging={isDragging || undefined}
        data-movable={canMove ? "true" : undefined}
        onPointerDown={(e) => onStartDrag(e, canMove)}
      >
        <div className="tc-board-card-top">
          <button
            className="tc-board-card-main"
            onClick={onOpen}
            type="button"
          >
            <div className="tc-board-card-meta">
              <span className="tc-board-id-chip">{card.id}</span>
              {card.size ? <span className="tc-chip">{card.size}</span> : null}
              {card.blocked ? (
                <span className="tc-chip tc-board-blocked-chip">{"阻塞"}</span>
              ) : null}
              {card.lane === "shipped" ? (
                <span className="tc-chip tc-board-provenance-chip">
                  {`原属：${TASK_HORIZON_LABELS[card.filedIn]}`}
                </span>
              ) : null}
            </div>
            <h4 className="tc-board-card-title">
              {normalizeMarkdownDeshout(card.title)}
            </h4>
            <div className="tc-board-card-foot">
              {card.checkboxes.total > 0 ? (
                <span className="tc-board-check-stat">
                  {`待办 ${card.checkboxes.checked}/${card.checkboxes.total}`}
                </span>
              ) : null}
              {[...new Set(card.tags)].slice(0, 3).map((tag) => (
                <span className="tc-chip" key={tag}>
                  {tag}
                </span>
              ))}
              {card.linkedTask ? (
                <span
                  className="tc-chip tc-board-linked-pill"
                  data-status={card.linkedTask.status}
                >
                  <IconRobot aria-hidden className="size-3" />
                  {STATUS_LABELS[card.linkedTask.status]}
                </span>
              ) : null}
            </div>
          </button>

          <BoardCardMenu
            canMove={canMove}
            currentLane={card.filedIn}
            inShipped={card.lane === "shipped"}
            onDispatch={onDispatch}
            onMove={onMove}
            onSendToChat={onSendToChat}
          />
        </div>
      </article>
    </div>
  );
}

export function PersonalBoardCardItem({
  task,
  filedIn,
  cardId,
  inShipped,
  isDragging,
  insertBefore,
  onStartDrag,
  onOpen,
  onMove,
  onStartNow,
  onSendToChat,
}: {
  task: TaskCenterTask;
  filedIn: TaskHorizonLane;
  cardId: string | null;
  inShipped: boolean;
  isDragging: boolean;
  insertBefore: boolean;
  onStartDrag: (event: ReactPointerEvent<HTMLElement>, movable: boolean) => void;
  onOpen: () => void;
  onMove: (lane: TaskHorizonLane) => void;
  onStartNow: () => void;
  onSendToChat: () => void;
}) {
  const canDragPersonal = !inShipped;
  return (
    <div>
      {insertBefore ? <div className="tc-board-drop-line" /> : null}
      <article
        className="tc-board-card"
        data-board-card-id={task.id}
        data-dragging={isDragging || undefined}
        data-movable={canDragPersonal ? "true" : undefined}
        onPointerDown={(e) => onStartDrag(e, canDragPersonal)}
      >
        <div className="tc-board-card-top">
          <button
            className="tc-board-card-main"
            onClick={onOpen}
            type="button"
          >
            <div className="tc-board-card-meta">
              <span className="tc-chip">{STATUS_LABELS[task.status]}</span>
              {cardId ? (
                <span className="tc-board-id-chip">{cardId}</span>
              ) : null}
              {inShipped ? (
                <span className="tc-chip tc-board-provenance-chip">
                  {`原属：${TASK_HORIZON_LABELS[filedIn]}`}
                </span>
              ) : null}
            </div>
            <h4 className="tc-board-card-title">{task.title}</h4>
            {task.summary || task.error || task.description ? (
              <p className="tc-board-personal-desc">
                {task.error || task.summary || task.description}
              </p>
            ) : null}
          </button>

          <PersonalCardMenu
            canStart={task.status === "inbox"}
            currentLane={filedIn}
            inShipped={inShipped}
            onMove={onMove}
            onSendToChat={onSendToChat}
            onStartNow={onStartNow}
          />
        </div>
      </article>
    </div>
  );
}

function BoardCardMenu({
  canMove,
  currentLane,
  inShipped,
  onMove,
  onDispatch,
  onSendToChat,
}: {
  canMove: boolean;
  currentLane: TaskHorizonLane;
  inShipped: boolean;
  onMove: (lane: TaskHorizonLane) => void;
  onDispatch: () => void;
  onSendToChat: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label="卡片操作"
            className="tc-board-card-more"
            type="button"
          />
        }
      >
        <IconGripVertical aria-hidden className="size-3.5" />
        <IconDots aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{"调度与协同"}</DropdownMenuLabel>
          {canMove && !inShipped
            ? TASK_HORIZON_LANES.filter((l) => l !== currentLane).map((lane) => (
                <DropdownMenuItem key={lane} onClick={() => onMove(lane)}>
                  <IconArrowRight aria-hidden className="size-3.5" />
                  {`移到：${TASK_HORIZON_LABELS[lane]}`}
                </DropdownMenuItem>
              ))
            : null}
          {canMove && !inShipped ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={onDispatch}>
            <IconRobot aria-hidden className="size-3.5" />
            {"交给机器人推进"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onSendToChat}>
            <IconMessageForward aria-hidden className="size-3.5" />
            {"发到当前对话"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PersonalCardMenu({
  canStart,
  currentLane,
  inShipped,
  onMove,
  onStartNow,
  onSendToChat,
}: {
  canStart: boolean;
  currentLane: TaskHorizonLane;
  inShipped: boolean;
  onMove: (lane: TaskHorizonLane) => void;
  onStartNow: () => void;
  onSendToChat: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label="任务看板操作"
            className="tc-board-card-more"
            type="button"
          />
        }
      >
        <IconDots aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {!inShipped || canStart ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>{"调整排期"}</DropdownMenuLabel>
              {!inShipped
                ? TASK_HORIZON_LANES.filter((l) => l !== currentLane).map(
                    (lane) => (
                      <DropdownMenuItem key={lane} onClick={() => onMove(lane)}>
                        <IconArrowRight aria-hidden className="size-3.5" />
                        {`移到：${TASK_HORIZON_LABELS[lane]}`}
                      </DropdownMenuItem>
                    ),
                  )
                : null}
              {canStart ? (
                <DropdownMenuItem onClick={onStartNow}>
                  <IconPlayerPlay aria-hidden className="size-3.5" />
                  {"移入「现在」并启动"}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={onSendToChat}>
          <IconMessageForward aria-hidden className="size-3.5" />
          {"发到当前对话"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
