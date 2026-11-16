import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { TaskCenterError } from "./service";
import {
  allowedDocument,
  resolveTaskSourcePath,
  TaskSourceError,
} from "./sources";

export const MAX_BOARD_FILE_BYTES = 1024 * 1024;

const fileLocks = new Map<string, Promise<void>>();

/**
 * 按字典序依次获取路径/资源键互斥锁，消除并发写入竞争并防止交叉加锁死锁。
 */
export async function withFileLocks<T>(
  keys: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(keys)].sort((a, b) => a.localeCompare(b));
  const releases: Array<() => void> = [];
  for (const key of ordered) {
    const prev = fileLocks.get(key) ?? Promise.resolve();
    let resolveNext = () => {};
    const next = new Promise<void>((res) => {
      resolveNext = res;
    });
    const chained = prev.then(() => next);
    fileLocks.set(key, chained);
    await prev;
    releases.push(() => {
      resolveNext();
      if (fileLocks.get(key) === chained) fileLocks.delete(key);
    });
  }
  try {
    return await fn();
  } finally {
    for (let i = releases.length - 1; i >= 0; i -= 1) {
      releases[i]?.();
    }
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function normalizeBoardRel(
  canonicalRoot: string,
  canonicalFile: string,
): string {
  return relative(canonicalRoot, canonicalFile).replaceAll("\\", "/");
}

export async function atomicWriteFile(
  canonicalPath: string,
  content: string,
): Promise<void> {
  const tmp = join(
    dirname(canonicalPath),
    `.chisabot-board-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, canonicalPath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 双文件顺序原子落盘：若第二个文件写入失败，尽力回滚第一个文件以维持双文件一致。
 */
export async function writeBoardFilesWithRollback(
  writes: ReadonlyArray<{
    path: string;
    nextContent: string;
    prevContent: string;
  }>,
): Promise<void> {
  const changed = writes.filter((w) => w.nextContent !== w.prevContent);
  const applied: Array<{ path: string; prevContent: string }> = [];
  try {
    for (const item of changed) {
      await atomicWriteFile(item.path, item.nextContent);
      applied.push({ path: item.path, prevContent: item.prevContent });
    }
  } catch (error) {
    for (let i = applied.length - 1; i >= 0; i -= 1) {
      const entry = applied[i];
      if (!entry) continue;
      await atomicWriteFile(entry.path, entry.prevContent).catch(() => {});
    }
    throw error;
  }
}

export async function isWritable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathEntryExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    return true;
  }
}

export async function readBoundedText(
  candidatePath: string,
  canonicalRoots: readonly string[],
): Promise<{ canonical: string; content: string; writable: boolean }> {
  let canonical: string;
  try {
    canonical = await resolveTaskSourcePath(candidatePath, canonicalRoots);
  } catch (error) {
    if (error instanceof TaskSourceError) {
      throw new TaskCenterError(error.message, 403);
    }
    throw new TaskCenterError("找不到目标看板文件。", 404);
  }
  if (!allowedDocument(canonical)) {
    throw new TaskCenterError(
      "只允许读写看板目录内的普通 Markdown / TXT 文件。",
      403,
    );
  }
  const info = await stat(canonical).catch(() => null);
  if (!info?.isFile()) {
    throw new TaskCenterError("目标路径不是可读文件。", 404);
  }
  if (info.size > MAX_BOARD_FILE_BYTES) {
    throw new TaskCenterError("看板 Markdown 文件过大（超过 1 MiB）。", 400);
  }
  const content = await readFile(canonical, "utf8");
  return { canonical, content, writable: await isWritable(canonical) };
}
