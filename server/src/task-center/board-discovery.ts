import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
  MarkdownBoardDialect,
  MarkdownBoardDocTab,
  MarkdownBoardLinkedTask,
} from "../../../shared/task-board-core";
import type { TaskCenterTask, TaskStatus } from "../../../shared/task-center";
import {
  isWritable,
  MAX_BOARD_FILE_BYTES,
  normalizeBoardRel,
  sha256Hex,
} from "./file-lock";
import type { AutobahnConfig } from "./markdown-board-parser";
import { allowedDocument, resolveTaskSourcePath } from "./sources";

const MAX_DOC_TABS = 20;

export const ACTIVE_STATUS_SET = new Set<TaskStatus>([
  "inbox",
  "queued",
  "planning",
  "running",
  "waiting_dependencies",
  "waiting_approval",
  "paused",
]);

export type DiscoveredBoard = {
  boardId: string;
  canonicalRoot: string;
  label: string;
  dialect: MarkdownBoardDialect;
  backlogFile: string;
  canonicalBacklogPath: string;
  roadmapFile?: string;
  canonicalRoadmapPath?: string;
  config?: AutobahnConfig;
};

export function boardKeyOf(canonicalRoot: string): string {
  return sha256Hex(canonicalRoot).slice(0, 16);
}

export function snapshotRevision(
  dialect: MarkdownBoardDialect,
  backlogRaw: string,
  roadmapRaw?: string,
): string {
  return dialect === "chisabot-docs"
    ? sha256Hex(`${roadmapRaw ?? ""}\0${backlogRaw}`)
    : sha256Hex(backlogRaw);
}

async function readAutobahnConfig(
  canonicalRoot: string,
): Promise<AutobahnConfig | undefined> {
  const candidate = resolve(canonicalRoot, "autobahn.config.json");
  try {
    const canonical = await resolveTaskSourcePath(candidate, [canonicalRoot]);
    const info = await stat(canonical);
    if (!info.isFile() || info.size > 64 * 1024) return undefined;
    const raw = JSON.parse(await readFile(canonical, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const obj = raw as Record<string, unknown>;
    const lanes =
      Array.isArray(obj.lanes) &&
      obj.lanes.length === 3 &&
      obj.lanes.every((v) => typeof v === "string" && v.trim())
        ? ([obj.lanes[0], obj.lanes[1], obj.lanes[2]] as [
            string,
            string,
            string,
          ])
        : undefined;
    const docs = Array.isArray(obj.docs)
      ? obj.docs
          .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
          .slice(0, 20)
      : undefined;
    return {
      ...(typeof obj.prefix === "string" ? { prefix: obj.prefix } : {}),
      ...(typeof obj.backlog === "string" ? { backlog: obj.backlog } : {}),
      ...(lanes ? { lanes } : {}),
      ...(docs ? { docs } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function resolveBoardAtRoot(
  canonicalRoot: string,
): Promise<DiscoveredBoard | null> {
  const rootKey = boardKeyOf(canonicalRoot);
  const label = basename(canonicalRoot) || canonicalRoot;
  const config = await readAutobahnConfig(canonicalRoot);

  for (const [roadmapRel, backlogRel] of [
    ["docs/ROADMAP.md", "docs/BACKLOG.md"],
    ["ROADMAP.md", "BACKLOG.md"],
  ] as const) {
    try {
      const roadmapPath = await resolveTaskSourcePath(
        resolve(canonicalRoot, roadmapRel),
        [canonicalRoot],
      );
      const backlogPath = await resolveTaskSourcePath(
        resolve(canonicalRoot, backlogRel),
        [canonicalRoot],
      );
      const [rStat, bStat] = await Promise.all([
        stat(roadmapPath),
        stat(backlogPath),
      ]);
      if (
        !rStat.isFile() ||
        !bStat.isFile() ||
        rStat.size > MAX_BOARD_FILE_BYTES ||
        bStat.size > MAX_BOARD_FILE_BYTES
      ) {
        continue;
      }
      const backlogRaw = await readFile(backlogPath, "utf8");
      if (/^##\s+CB-\d+\s*$/m.test(backlogRaw)) {
        return {
          boardId: rootKey,
          canonicalRoot,
          label,
          dialect: "chisabot-docs",
          backlogFile: normalizeBoardRel(canonicalRoot, backlogPath),
          canonicalBacklogPath: backlogPath,
          roadmapFile: normalizeBoardRel(canonicalRoot, roadmapPath),
          canonicalRoadmapPath: roadmapPath,
        };
      }
    } catch {
      // 文件不存在或越界则跳过尝试下一模式
    }
  }

  const candidates = [
    ...(config?.backlog ? [config.backlog] : []),
    "BACKLOG.md",
    "docs/BACKLOG.md",
  ];
  for (const rel of candidates) {
    try {
      const backlogPath = await resolveTaskSourcePath(
        resolve(canonicalRoot, rel),
        [canonicalRoot],
      );
      const bStat = await stat(backlogPath);
      if (!bStat.isFile() || bStat.size > MAX_BOARD_FILE_BYTES) continue;
      if (!allowedDocument(backlogPath)) continue;
      return {
        boardId: rootKey,
        canonicalRoot,
        label,
        dialect: "autobahn",
        backlogFile: normalizeBoardRel(canonicalRoot, backlogPath),
        canonicalBacklogPath: backlogPath,
        config,
      };
    } catch {
      // 跳过不存在的候选路径
    }
  }
  return null;
}

export async function collectDocTabs(
  board: DiscoveredBoard,
): Promise<MarkdownBoardDocTab[]> {
  const seen = new Set<string>();
  const tabs: MarkdownBoardDocTab[] = [];
  const tryAdd = async (candidatePath: string) => {
    if (tabs.length >= MAX_DOC_TABS) return;
    try {
      const canonical = await resolveTaskSourcePath(candidatePath, [
        board.canonicalRoot,
      ]);
      if (seen.has(canonical) || !allowedDocument(canonical)) return;
      const info = await stat(canonical);
      if (!info.isFile() || info.size > MAX_BOARD_FILE_BYTES) return;
      seen.add(canonical);
      tabs.push({
        relFile: normalizeBoardRel(board.canonicalRoot, canonical),
        name: basename(canonical),
        writable: await isWritable(canonical),
      });
    } catch {
      // 跳过不合规或不可访问文件
    }
  };

  await tryAdd(board.canonicalBacklogPath);
  if (board.canonicalRoadmapPath) await tryAdd(board.canonicalRoadmapPath);
  for (const configuredDoc of board.config?.docs ?? []) {
    await tryAdd(resolve(board.canonicalRoot, configuredDoc));
  }
  const scanDirs = [board.canonicalRoot];
  const docsDir = resolve(board.canonicalRoot, "docs");
  try {
    const canonicalDocs = await resolveTaskSourcePath(docsDir, [
      board.canonicalRoot,
    ]);
    if ((await stat(canonicalDocs)).isDirectory()) scanDirs.push(canonicalDocs);
  } catch {
    // 无 docs 目录跳过
  }
  for (const dir of scanDirs) {
    if (tabs.length >= MAX_DOC_TABS) break;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (tabs.length >= MAX_DOC_TABS) break;
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      await tryAdd(join(dir, entry.name));
    }
  }
  return tabs;
}

export function linkCardTaskMap(
  tasks: readonly TaskCenterTask[],
): Map<string, MarkdownBoardLinkedTask> {
  const best = new Map<string, TaskCenterTask>();
  for (const task of tasks) {
    if (!task.sourceRef) continue;
    const prev = best.get(task.sourceRef);
    if (!prev) {
      best.set(task.sourceRef, task);
      continue;
    }
    const prevActive = ACTIVE_STATUS_SET.has(prev.status);
    const nextActive = ACTIVE_STATUS_SET.has(task.status);
    if (nextActive && !prevActive) {
      best.set(task.sourceRef, task);
      continue;
    }
    if (nextActive === prevActive && task.updatedAt > prev.updatedAt) {
      best.set(task.sourceRef, task);
    }
  }
  const out = new Map<string, MarkdownBoardLinkedTask>();
  for (const [ref, task] of best) {
    out.set(ref, {
      id: task.id,
      title: task.title,
      status: task.status,
      executor: task.executor,
      summary: task.summary,
      error: task.error,
      updatedAt: task.updatedAt,
      finishedAt: task.finishedAt,
    });
  }
  return out;
}
