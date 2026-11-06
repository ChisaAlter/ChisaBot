/**
 * 任务中心的「授权目录」设置（owner 级，存在数据库里）。
 *
 * documents / repository 巡检源只读这些目录（sources.ts resolveTaskSourcePath 强约束）；
 * 以前只有部署 env CHISABOT_TASK_CENTER_ROOTS 一份白名单，用户自己加目录要改部署。
 * 现在两边取并集：env 是部署策略，这张表是用户自己的授权（index.ts localRoots 合并）。
 *
 * 校验在写入前做：只收绝对路径形态，拒绝 .. 与凭据字样——这张表直接决定巡检能读哪里，
 * 写进来的每一行都当作授权声明对待。
 */
import type { Database } from "../db/client";
import { TaskCenterError } from "./service";

const MAX_ROOTS = 50;
const PATH_LIMIT = 500;
/** Unix `/`、Windows `X:\`（`X:/` 同形）、UNC `\\`。相对路径一律拒收。 */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const SENSITIVE = /password|passwd|secret|token|api.?key|credential/i;

/**
 * 归一化 + 校验一个授权目录：trim、去尾部多余斜杠（保留 `C:\` 与 `/` 这类根），
 * 然后按白名单规则检查。返回可入库的路径；不合规抛 TaskCenterError。
 */
export function taskCenterRootPath(input: string): string {
  let value = input.trim();
  while (
    value.length > 1 &&
    /[\\/]$/.test(value) &&
    ABSOLUTE.test(value.slice(0, -1))
  )
    value = value.slice(0, -1);
  if (!value) throw new TaskCenterError("目录路径不能为空。");
  if (value.length > PATH_LIMIT)
    throw new TaskCenterError(`目录路径过长，最多 ${PATH_LIMIT} 字。`);
  if (value.includes(".."))
    throw new TaskCenterError("目录路径不能包含「..」。");
  if (SENSITIVE.test(value))
    throw new TaskCenterError(
      "目录路径不能包含密码 / 凭据字样，请把凭据放到保险箱或连接设置。",
    );
  if (!ABSOLUTE.test(value))
    throw new TaskCenterError(
      "授权目录必须是服务器上的绝对路径（以 / 、盘符 X:\\ 或 \\\\ 开头）。",
    );
  return value;
}

export function createTaskCenterRoots(database: Database) {
  const sql = database.$client;

  async function ensure() {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_task_center_roots (
      owner_user_id text NOT NULL, path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_user_id, path)
    )`);
  }

  async function list(owner: string): Promise<string[]> {
    const rows = await sql.unsafe<{ path: string }[]>(
      "SELECT path FROM chisabot_task_center_roots WHERE owner_user_id=$1 ORDER BY created_at",
      [owner],
    );
    return rows.map((row) => row.path);
  }

  async function add(owner: string, path: string): Promise<string[]> {
    const value = taskCenterRootPath(path);
    const [{ count }] = await sql.unsafe<{ count: number }[]>(
      "SELECT count(*)::int AS count FROM chisabot_task_center_roots WHERE owner_user_id=$1",
      [owner],
    );
    if (count >= MAX_ROOTS)
      throw new TaskCenterError(
        `授权目录最多 ${MAX_ROOTS} 个，请先删除不再使用的。`,
      );
    // 重复添加由主键吞掉，幂等。
    await sql.unsafe(
      "INSERT INTO chisabot_task_center_roots(owner_user_id,path) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [owner, value],
    );
    return list(owner);
  }

  async function remove(owner: string, path: string): Promise<string[]> {
    await sql.unsafe(
      "DELETE FROM chisabot_task_center_roots WHERE owner_user_id=$1 AND path=$2",
      [owner, path.trim()],
    );
    return list(owner);
  }

  return { ensure, list, add, remove };
}

export type TaskCenterRoots = ReturnType<typeof createTaskCenterRoots>;
