import type {
  TaskCenterTask,
  TaskHorizonLane,
  TaskStatus,
} from "./task-center";

export const TASK_BOARD_COLUMNS = ["now", "next", "later", "shipped"] as const;
export type TaskBoardColumn = (typeof TASK_BOARD_COLUMNS)[number];

export const TASK_HORIZON_LABELS: Record<TaskHorizonLane, string> = {
  now: "现在",
  next: "接下来",
  later: "以后",
};

export const TASK_BOARD_COLUMN_LABELS: Record<TaskBoardColumn, string> = {
  now: "现在",
  next: "接下来",
  later: "以后",
  shipped: "已交付",
};

export const DEFAULT_LANE_PRIORITY: Record<TaskHorizonLane, number> = {
  now: 80,
  next: 50,
  later: 20,
};

export type BoardSourceRef = {
  rootKey: string;
  relFile: string;
  cardId: string;
};

const BOARD_REF_PREFIX = "board:v1:";
const ROOT_KEY_RE = /^[a-f0-9]{16}$/;

/** 为本地 Markdown 看板卡片生成稳定的任务中心 sourceRef 标识。 */
export function formatBoardSourceRef(ref: BoardSourceRef): string {
  return `${BOARD_REF_PREFIX}${ref.rootKey}:${encodeURIComponent(ref.relFile)}:${encodeURIComponent(ref.cardId)}`;
}

/** 解析 `board:v1:<rootKey>:<relFile>:<cardId>` 格式的任务来源标识；非看板来源返回 null。 */
export function parseBoardSourceRef(
  sourceRef: string | null | undefined,
): BoardSourceRef | null {
  if (!sourceRef?.startsWith(BOARD_REF_PREFIX)) return null;
  const rest = sourceRef.slice(BOARD_REF_PREFIX.length);
  const first = rest.indexOf(":");
  const second = first >= 0 ? rest.indexOf(":", first + 1) : -1;
  if (first < 0 || second < 0) return null;
  const rootKey = rest.slice(0, first);
  if (!ROOT_KEY_RE.test(rootKey)) return null;
  try {
    const relFile = decodeURIComponent(rest.slice(first + 1, second));
    const cardId = decodeURIComponent(rest.slice(second + 1));
    if (!relFile || !cardId) return null;
    return { rootKey, relFile, cardId };
  } catch {
    return null;
  }
}

const TERMINAL_STATUSES = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

/** 将 ChisaBot 任务中心任务投影到「现在 / 接下来 / 以后 / 已交付」四列与原属泳道。 */
export function resolveTaskBoardPlacement(
  task: Pick<TaskCenterTask, "status" | "priority" | "lane" | "sourceRef">,
): {
  column: TaskBoardColumn;
  filedIn: TaskHorizonLane;
  boardRef: BoardSourceRef | null;
} {
  const filedIn: TaskHorizonLane =
    task.lane ??
    (task.priority >= 70 ? "now" : task.priority >= 40 ? "next" : "later");
  const column: TaskBoardColumn = TERMINAL_STATUSES.has(task.status)
    ? "shipped"
    : task.status === "inbox"
      ? filedIn
      : "now";
  return {
    column,
    filedIn,
    boardRef: parseBoardSourceRef(task.sourceRef),
  };
}

export type MarkdownBoardDialect = "autobahn" | "chisabot-docs";

export type MarkdownBoardSummary = {
  boardId: string;
  rootPath: string;
  label: string;
  dialect: MarkdownBoardDialect;
  backlogFile: string;
  roadmapFile?: string;
  writable: boolean;
  cardCount: number;
};

export type MarkdownBoardLinkedTask = Pick<
  TaskCenterTask,
  | "id"
  | "title"
  | "status"
  | "executor"
  | "summary"
  | "error"
  | "updatedAt"
  | "finishedAt"
>;

export type MarkdownBoardPinnedNote = {
  title: string;
  body: string;
  line: number;
};

export type MarkdownBoardCard = {
  id: string;
  title: string;
  lane: TaskBoardColumn;
  filedIn: TaskHorizonLane;
  done: boolean;
  blocked: boolean;
  movable: boolean;
  statusText: string;
  size: string;
  tags: string[];
  body: string;
  line: number;
  sourceFile: string;
  sourceRef: string;
  checkboxes: { checked: number; total: number };
  linkedTask?: MarkdownBoardLinkedTask;
};

export type MarkdownBoardDocTab = {
  relFile: string;
  name: string;
  writable: boolean;
};

export type MarkdownBoardSnapshot = {
  boardId: string;
  rootPath: string;
  label: string;
  dialect: MarkdownBoardDialect;
  backlogFile: string;
  roadmapFile?: string;
  revision: string;
  writable: boolean;
  lanes: Record<TaskHorizonLane, string>;
  pinned: MarkdownBoardPinnedNote | null;
  cards: MarkdownBoardCard[];
  docs: MarkdownBoardDocTab[];
};

export type MarkdownBoardDocPayload = {
  boardId: string;
  relFile: string;
  name: string;
  content: string;
  revision: string;
  writable: boolean;
};
