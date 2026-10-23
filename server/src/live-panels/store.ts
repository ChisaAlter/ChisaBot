import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { livePanels } from "../db/schema";
import type { LivePanelDataSource, LivePanelSourceState } from "./source-types";

/** url 为空 = 没有网址的来源（本机命令等），卡片上只写名字、不做成链接。 */
export type LivePanelSource = { name: string; url: string };
export type LivePanelRow = typeof livePanels.$inferSelect;

export const MIN_REFRESH_MINUTES = 60;
export const MAX_PANELS_PER_BOT = 24;
/** 「撤销删除」保留多久。 */
export const UNDO_WINDOW_MS = 10 * 60_000;
const LEASE_MS = 8 * 60_000;

export class LivePanelError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export function clampRefresh(minutes: number | null | undefined): number | null {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.min(Math.max(Math.round(minutes), MIN_REFRESH_MINUTES), 7 * 24 * 60);
}

/**
 * 编出来的网址不当链接（2026-10-13 实测：本机命令取数的面板，机器人为了填必填的 url 写了
 * https://workspace.local/，卡片上成了一个点了打不开的「来源」链接）。
 */
function isRealHost(host: string) {
  return host.includes(".") && !/(^|\.)(local|localhost|internal|invalid|example|test)$/i.test(host) && host !== "127.0.0.1";
}

export function cleanSources(sources: readonly { name?: string; url?: string | null }[] | undefined): LivePanelSource[] {
  const out: LivePanelSource[] = [];
  for (const s of sources ?? []) {
    let url: URL | null = null;
    try {
      url = s.url ? new URL(s.url) : null;
    } catch {}
    const linkable = url && (url.protocol === "http:" || url.protocol === "https:") && isRealHost(url.hostname);
    const name = (s.name?.trim() || (linkable ? url!.hostname : "")).slice(0, 60);
    if (!name) continue;
    out.push({ name, url: linkable ? url!.toString().slice(0, 500) : "" });
  }
  return out.slice(0, 6);
}

/**
 * 每天固定时刻刷新（「HH:MM@IANA 时区」）。用户说「每天早上 8 点刷新」时，按这个时刻排，而不是
 * 「建好之后每 24 小时」（2026-10-13 实测：机器人只能回答「锁定不了 8 点整」）。
 */
export function parseRefreshAt(value: string | null | undefined): { hour: number; minute: number; timeZone: string } | null {
  const m = /^(\d{1,2}):(\d{2})@([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)$/.exec(value?.trim() ?? "");
  if (!m) return null;
  const hour = Number(m[1]), minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: m[3] });
  } catch {
    return null;
  }
  return { hour, minute, timeZone: m[3]! };
}

/** 规范成「HH:MM@时区」；时刻或时区不对返回 null。 */
export function normalizeRefreshAt(time: string | null | undefined, timeZone = "Asia/Shanghai"): string | null {
  const m = /^\s*(\d{1,2})[:：](\d{2})\s*$/.exec(time ?? "");
  if (!m) return null;
  const v = `${m[1]!.padStart(2, "0")}:${m[2]}@${timeZone || "Asia/Shanghai"}`;
  return parseRefreshAt(v) ? v : null;
}

function zoneOffsetMs(timeZone: string, at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** refreshAt 的下一次（严格晚于 from + 1 分钟）。 */
export function nextRefreshAtTime(refreshAt: string, from = Date.now()): Date | null {
  const spec = parseRefreshAt(refreshAt);
  if (!spec) return null;
  for (let day = 0; day < 3; day++) {
    const probe = from + day * 86_400_000;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: spec.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(probe))
        .map((p) => [p.type, p.value]),
    );
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), spec.hour, spec.minute);
    let at = wall - zoneOffsetMs(spec.timeZone, wall);
    at = wall - zoneOffsetMs(spec.timeZone, at); // 夏令时边界再校一次
    if (at > from + 60_000) return new Date(at);
  }
  return null;
}

/** 下一次自动刷新：有固定时刻按时刻，否则按间隔。 */
function nextFor(refreshMinutes: number | null, refreshAt: string | null | undefined, from: number) {
  if (refreshAt) return nextRefreshAtTime(refreshAt, from);
  return refreshMinutes ? new Date(from + refreshMinutes * 60_000) : null;
}

/** 面板的机器人已经不在：agents 行没了，或 agent_profiles 标了删除（删除中 / 墓碑 / 部署包机器人）。 */
const ORPHAN_BOT = sql`(not exists (select 1 from agents a where a.id = ${livePanels.botId})
  or exists (select 1 from agent_profiles p where p.agent_id = ${livePanels.botId} and p.deleted_at is not null))`;

export const PANEL_MODEL_KEY = "__meta_model";

export function readPanelModel(row: LivePanelRow): string | null {
  const entry = row.sourceState?.[PANEL_MODEL_KEY];
  if (entry && typeof entry.value === "string" && entry.value.trim()) {
    return entry.value.trim();
  }
  return null;
}

/** 只留下还存在的源的读数：删掉 / 改名 / 换 id 的源，不再把旧值挂在库里（保留 __meta_model）。 */
function pruneSourceState(state: LivePanelSourceState | null | undefined, keep: readonly string[]): LivePanelSourceState {
  const ids = new Set(keep);
  const out: LivePanelSourceState = {};
  for (const [id, reading] of Object.entries(state ?? {})) {
    if (ids.has(id) || id === PANEL_MODEL_KEY) out[id] = reading;
  }
  return out;
}

export function createLivePanelStore(db: Database) {
  const own = (owner: string, id: string) => and(eq(livePanels.id, id), eq(livePanels.ownerUserId, owner));
  async function get(owner: string, id: string): Promise<LivePanelRow> {
    const [row] = await db.select().from(livePanels).where(own(owner, id)).limit(1);
    if (!row) throw new LivePanelError("没有这个面板", 404);
    return row;
  }
  return {
    get,
    async list(owner: string, botId: string): Promise<LivePanelRow[]> {
      return db
        .select()
        .from(livePanels)
        .where(and(eq(livePanels.ownerUserId, owner), eq(livePanels.botId, botId), eq(livePanels.removed, false)))
        .orderBy(asc(livePanels.position), asc(livePanels.createdAt));
    },
    async create(
      owner: string,
      botId: string,
      input: {
        title: string;
        instruction: string;
        refreshMinutes?: number | null;
        refreshAt?: string | null;
        /** 直连数据源（第一次 panel_create 就带上时存下来）。 */
        dataSources?: LivePanelDataSource[];
      },
    ) {
      const [{ count = 0 } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(livePanels)
        .where(and(eq(livePanels.ownerUserId, owner), eq(livePanels.botId, botId), eq(livePanels.removed, false)));
      if (count >= MAX_PANELS_PER_BOT) throw new LivePanelError(`面板太多了（最多 ${MAX_PANELS_PER_BOT} 个），先删掉一些`, 409);
      const [{ max = -1 } = { max: -1 }] = await db
        .select({ max: sql<number>`coalesce(min(${livePanels.position}), 0) - 1` })
        .from(livePanels)
        .where(and(eq(livePanels.ownerUserId, owner), eq(livePanels.botId, botId)));
      const row = {
        id: `lp_${randomUUID()}`,
        ownerUserId: owner,
        botId,
        title: input.title.trim().slice(0, 60) || "面板",
        status: "building",
        spec: null,
        sources: [],
        dataSources: input.dataSources ?? [],
        sourceState: {},
        instruction: input.instruction.trim().slice(0, 2000),
        refreshMinutes: input.refreshAt ? 1440 : clampRefresh(input.refreshMinutes ?? null),
        refreshAt: input.refreshAt ?? null,
        position: max,
      };
      await db.insert(livePanels).values(row);
      return get(owner, row.id);
    },
    /** 机器人交来新数据（首次填充、刷新或修改）。 */
    async update(
      owner: string,
      id: string,
      input: {
        spec: string;
        sources?: { name: string; url?: string }[];
        title?: string;
        instruction?: string;
        refreshMinutes?: number | null;
        refreshAt?: string | null;
        edit?: boolean;
        /** 传了就整份替换（含 id 复用后的结果）；不传保持。 */
        dataSources?: LivePanelDataSource[];
      },
    ) {
      const current = await get(owner, id);
      if (current.removed) throw new LivePanelError("这个面板已经删除了", 404);
      const now = new Date();
      // 改了间隔就不再按固定时刻；给了固定时刻就是每天一次。
      const refreshAt = input.refreshAt !== undefined ? input.refreshAt : input.refreshMinutes !== undefined ? null : current.refreshAt;
      const refreshMinutes = refreshAt ? 1440 : input.refreshMinutes === undefined ? current.refreshMinutes : clampRefresh(input.refreshMinutes);
      const changedShape =
        (input.title !== undefined && input.title.trim() !== current.title) ||
        (input.instruction !== undefined && input.instruction.trim() !== current.instruction);
      // 数据源换了：删掉不再存在的源的旧读数，免得卡片底部还挂着上一个源的数。
      const dataSources = input.dataSources;
      const sourcesChanged = dataSources !== undefined && JSON.stringify(dataSources) !== JSON.stringify(current.dataSources ?? []);
      const sourceState =
        dataSources !== undefined ? pruneSourceState(current.sourceState, dataSources.map((source) => source.id)) : current.sourceState;
      await db
        .update(livePanels)
        .set({
          spec: input.spec,
          sources: cleanSources(input.sources?.length ? input.sources : current.sources),
          ...(dataSources !== undefined ? { dataSources, sourceState } : {}),
          ...(input.title?.trim() ? { title: input.title.trim().slice(0, 60) } : {}),
          ...(input.instruction?.trim() ? { instruction: input.instruction.trim().slice(0, 2000) } : {}),
          refreshMinutes,
          refreshAt,
          status: "ready",
          error: null,
          failures: 0,
          refreshedAt: now,
          nextRefreshAt: nextFor(refreshMinutes, refreshAt, now.getTime()),
          // 租约不在这里放：后台刷新的回合交完数据后还没结束，放了就会被「立即刷新」/ 定时扫描
          // 再认领一次，两个回合叠在一起（2026-10-13 实测）。回合结束时 release() 统一放。
          updatedAt: now,
          ...((input.edit || changedShape || sourcesChanged) && current.spec
            ? {
                previous: {
                  title: current.title,
                  spec: current.spec,
                  sources: current.sources,
                  dataSources: current.dataSources,
                  sourceState: current.sourceState,
                  instruction: current.instruction,
                  refreshMinutes: current.refreshMinutes,
                  refreshAt: current.refreshAt,
                },
              }
            : {}),
        })
        .where(own(owner, id));
      return get(owner, id);
    },
    async fail(owner: string, id: string, reason: string) {
      const current = await get(owner, id);
      const failures = current.failures + 1;
      const now = Date.now();
      // 失败后退避：1、2、4… 个刷新间隔，最多一天。
      // 固定时刻的面板（每天一次）失败后按 1 小时起退避，别等到明天。
      const base = (current.refreshAt ? 60 : (current.refreshMinutes ?? 0)) * 60_000;
      await db
        .update(livePanels)
        .set({
          status: current.spec ? "ready" : "failed",
          error: reason.slice(0, 300),
          failures,
          // 不放租约：机器人在后台刷新里 panel_fail 之后回合还没结束（见 update）。
          nextRefreshAt: base ? new Date(now + Math.min(base * 2 ** Math.min(failures - 1, 4), 86_400_000)) : null,
          updatedAt: new Date(),
        })
        .where(own(owner, id));
      return get(owner, id);
    },
    /**
     * 这次没刷成，但不是面板的错（有人接管着计算机、服务器重启）：卡片写明原因，保留旧数据，
     * 不计失败次数、不退避，几分钟后再试。
     */
    async defer(owner: string, id: string, reason: string, retryMs: number, failures?: number) {
      const current = await get(owner, id);
      await db
        .update(livePanels)
        .set({
          status: current.spec ? "ready" : "failed",
          error: reason.slice(0, 300),
          // 这一轮里机器人可能已经 panel_fail 过（会 +1），恢复成刷新前的次数。
          ...(failures !== undefined ? { failures } : {}),
          nextRefreshAt: new Date(Date.now() + retryMs),
          updatedAt: new Date(),
        })
        .where(own(owner, id));
      return get(owner, id);
    },
    async undoEdit(owner: string, id: string) {
      const current = await get(owner, id);
      const prev = current.previous as {
        title?: string;
        spec?: string;
        sources?: LivePanelSource[];
        dataSources?: LivePanelDataSource[];
        sourceState?: LivePanelSourceState;
        instruction?: string;
        refreshMinutes?: number | null;
        refreshAt?: string | null;
      } | null;
      if (!prev?.spec) throw new LivePanelError("没有可以撤销的修改", 409);
      await db
        .update(livePanels)
        .set({
          title: prev.title ?? current.title,
          spec: prev.spec,
          sources: prev.sources ?? current.sources,
          // 旧版 previous 没有这两个字段：留当前值，别把数据源弄丢。
          ...(prev.dataSources !== undefined ? { dataSources: prev.dataSources, sourceState: prev.sourceState ?? {} } : {}),
          instruction: prev.instruction ?? current.instruction,
          refreshMinutes: prev.refreshMinutes ?? current.refreshMinutes,
          refreshAt: prev.refreshAt !== undefined ? prev.refreshAt : current.refreshAt,
          previous: null,
          status: "ready",
          error: null,
          updatedAt: new Date(),
        })
        .where(own(owner, id));
      return get(owner, id);
    },
    /** 右栏 ⋯ 菜单改刷新频率：给 refreshAt 就是每天固定时刻，只给间隔就清掉固定时刻。 */
    async setRefresh(owner: string, id: string, minutes: number | null, refreshAt?: string | null) {
      const current = await get(owner, id);
      const at = refreshAt === undefined ? null : refreshAt;
      const refreshMinutes = at ? 1440 : clampRefresh(minutes);
      const from = current.refreshedAt?.getTime() ?? Date.now();
      const nextRefreshAt = at
        ? nextRefreshAtTime(at)
        : refreshMinutes
          ? new Date(Math.max(from + refreshMinutes * 60_000, Date.now() + 60_000))
          : null;
      await db.update(livePanels).set({ refreshMinutes, refreshAt: at, nextRefreshAt, updatedAt: new Date() }).where(own(owner, id));
      return get(owner, id);
    },
    /** 右栏 ⋯ 菜单改面板独立刷新模型（CB-088）：null = 跟随机器人主模型。 */
    async setModel(owner: string, id: string, model: string | null) {
      const current = await get(owner, id);
      const state: LivePanelSourceState = { ...(current.sourceState ?? {}) };
      const cleaned = model?.trim() ?? "";
      if (cleaned) {
        state[PANEL_MODEL_KEY] = {
          ok: false,
          value: cleaned.slice(0, 120),
          at: new Date().toISOString(),
          ms: 0,
        };
      } else {
        delete state[PANEL_MODEL_KEY];
      }
      await db.update(livePanels).set({ sourceState: state, updatedAt: new Date() }).where(own(owner, id));
      return get(owner, id);
    },
    /** 交还计算机之后：因为「有人接管」被推迟的面板（卡片上写着 note），马上到点。 */
    async dueNowIfNoted(owner: string, note: string): Promise<LivePanelRow[]> {
      return db
        .update(livePanels)
        .set({ nextRefreshAt: new Date() })
        .where(and(eq(livePanels.ownerUserId, owner), eq(livePanels.removed, false), eq(livePanels.error, note)))
        .returning();
    },
    async remove(owner: string, id: string) {
      await get(owner, id);
      await db.update(livePanels).set({ removed: true, removedAt: new Date(), updatedAt: new Date() }).where(own(owner, id));
    },
    async restore(owner: string, id: string) {
      const row = await get(owner, id);
      if (!row.removed) return row;
      if (!row.removedAt || Date.now() - row.removedAt.getTime() > UNDO_WINDOW_MS) throw new LivePanelError("已经超过可以撤销的时间", 409);
      await db.update(livePanels).set({ removed: false, removedAt: null, updatedAt: new Date() }).where(own(owner, id));
      return get(owner, id);
    },
    async move(owner: string, botId: string, orderedIds: string[]) {
      for (const [index, id] of orderedIds.entries()) {
        await db.update(livePanels).set({ position: index }).where(and(own(owner, id), eq(livePanels.botId, botId)));
      }
    },
    /** 认领一个面板的刷新（租约）；拿不到返回 false。 */
    async claim(owner: string, id: string): Promise<boolean> {
      const now = new Date();
      const rows = await db
        .update(livePanels)
        .set({ leaseUntil: new Date(now.getTime() + LEASE_MS) })
        .where(and(own(owner, id), eq(livePanels.removed, false), or(isNull(livePanels.leaseUntil), lte(livePanels.leaseUntil, now))))
        .returning({ id: livePanels.id });
      return rows.length > 0;
    },
    /**
     * 启动时：上一个进程没来得及放掉的租约（部署 / 重启时正在刷新的面板）全部放掉，并在 1 分钟内重刷。
     * 以前卡片会一直转「正在刷新…」到租约过期（8 分钟），期间点「立即刷新」也被拒（2026-10-13 实测）。
     * 只在跑刷新循环的实例上调用（一个数据库只有一个这样的实例）。
     */
    async releaseOrphanLeases(): Promise<number> {
      const now = new Date();
      const rows = await db
        .update(livePanels)
        .set({ leaseUntil: null, nextRefreshAt: new Date(now.getTime() + 60_000) })
        .where(and(isNotNull(livePanels.leaseUntil), eq(livePanels.removed, false)))
        .returning({ id: livePanels.id });
      return rows.length;
    },
    /**
     * 删机器人时（agents/purge.ts）：它的面板先软删除、停掉刷新（next_refresh_at / 租约清空），
     * 机器人真正删掉时再连行删除。以前删机器人不碰 live_panels，面板行留着、到点还会刷新（2026-10-13）。
     */
    async retireForBot(botId: string): Promise<string[]> {
      const now = new Date();
      const rows = await db
        .update(livePanels)
        .set({ removed: true, removedAt: now, leaseUntil: null, nextRefreshAt: null, updatedAt: now })
        .where(and(eq(livePanels.botId, botId), eq(livePanels.removed, false)))
        .returning({ id: livePanels.id });
      return rows.map((row) => row.id);
    },
    /**
     * 启动时：机器人已经不在（agents 行没了，或资料已标删除）的面板一律删掉，幂等。
     * 修复以前删机器人留下的孤儿面板；CHISABOT_PANEL_ORPHAN_SWEEP=0 关掉。
     */
    async sweepOrphans(): Promise<string[]> {
      const rows = await db
        .delete(livePanels)
        .where(sql`${ORPHAN_BOT}`)
        .returning({ id: livePanels.id });
      return rows.map((row) => row.id);
    },
    async release(owner: string, id: string) {
      await db.update(livePanels).set({ leaseUntil: null }).where(own(owner, id));
    },
    /**
     * 直连数据源的读数写回（sources.ts 的 createSourceRunner）。只动 source_state + updated_at：
     * refreshed_at 是「机器人回合刷新」的时间，秒级取数不能把它刷成刚刚，否则卡片上的「x 分钟前更新」会乱。
     */
    async setSourceState(owner: string, id: string, state: LivePanelSourceState) {
      const current = await get(owner, id);
      const modelMeta = current.sourceState?.[PANEL_MODEL_KEY];
      const nextState = modelMeta ? { ...state, [PANEL_MODEL_KEY]: modelMeta } : state;
      await db.update(livePanels).set({ sourceState: nextState, updatedAt: new Date() }).where(own(owner, id));
    },
    /** 到点该刷新的面板（没有被删、有刷新间隔、没在刷新）。 */
    async due(limit = 4): Promise<LivePanelRow[]> {
      const now = new Date();
      return db
        .select()
        .from(livePanels)
        .where(
          and(
            eq(livePanels.removed, false),
            // 机器人已删（或正在删）的面板不刷新，哪怕行还没清掉。
            sql`not (${ORPHAN_BOT})`,
            isNotNull(livePanels.refreshMinutes),
            isNotNull(livePanels.nextRefreshAt),
            lte(livePanels.nextRefreshAt, now),
            or(isNull(livePanels.leaseUntil), lte(livePanels.leaseUntil, now)),
          ),
        )
        .orderBy(asc(livePanels.nextRefreshAt))
        .limit(limit);
    },
    /** 建好卡片却一直没填数据（机器人中途放弃）的面板，超时后标为失败。 */
    async staleBuilding(olderThanMs: number): Promise<LivePanelRow[]> {
      return db
        .select()
        .from(livePanels)
        .where(
          and(
            eq(livePanels.removed, false),
            eq(livePanels.status, "building"),
            lte(livePanels.createdAt, new Date(Date.now() - olderThanMs)),
            or(isNull(livePanels.leaseUntil), lte(livePanels.leaseUntil, new Date())),
          ),
        )
        .limit(10);
    },
    async isLeased(row: LivePanelRow) {
      return Boolean(row.leaseUntil && row.leaseUntil.getTime() > Date.now());
    },
  };
}
export type LivePanelStore = ReturnType<typeof createLivePanelStore>;
