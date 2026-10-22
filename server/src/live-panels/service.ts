/**
 * 实时面板（2026-10-13，向 Hark 的面板体验看齐）。
 *
 * 用户用一句话要面板（「做一个比特币价格面板，每小时更新」）：
 *  1. 机器人先 `panel_create`：右栏立刻出现一张「正在搭建…」的卡片；
 *  2. 同一回合里用 web_search / web_fetch 取真实数据，`panel_update` 交上 json-render 规范（与
 *     render_ui 同一份组件目录）和数据来源，卡片原地填好，带标题、来源、更新时间；
 *  3. 之后按 refreshMinutes（最少 60 分钟）由服务器自己的刷新循环在后台跑一个无头回合，同一个机器人
 *     重新取数、再 `panel_update`。刷新失败会把原因写在卡片上，并按间隔退避；
 *  4. 改面板就在对话里说（「改成显示以太坊」）：机器人 `panel_update` 带新的 title / instruction，
 *     上一版留作「撤销修改」；删除可在 10 分钟内撤销。
 *
 * 用户看不到 JSON / 规范：卡片只画结果。
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { inspectRenderUiSpec, parseRenderUiSpec, sanitizeRenderUiSpec } from "../../../shared/json-render/catalog";
import { emptySections } from "../../../shared/json-render/empty-sections";
import { takeHumanControlBlock } from "../computer/control-blocks";
import { lintPanelSpec, PANEL_DESIGN_GUIDE } from "./design";
import type { AppVariables } from "../auth/guards";
import { REFUSAL_MARKER, type GrantedTool } from "../plugins/tools";
import { LivePanelError, type LivePanelRow, type LivePanelStore, MIN_REFRESH_MINUTES, normalizeRefreshAt } from "./store";
import type { LivePanelDataSource, LivePanelSourceState } from "./source-types";
import {
  createSourceRunner,
  normalizeSources,
  sourceLabel,
  type LivePanelCommandRunner,
  type LivePanelRequestHttp,
} from "./sources";
import { reasonWithoutStatement } from "../db/query-failure";

export type LivePanelDto = {
  id: string;
  botId: string;
  title: string;
  status: "building" | "ready" | "failed";
  spec: string | null;
  sources: { name: string; url: string }[];
  /** 直连数据源（不回 headers / body 原文；label 是卡片底部展示用的短串）。 */
  dataSources: { id: string; kind: "http" | "command"; name: string; intervalSec: number; label: string }[];
  instruction: string;
  refreshMinutes: number | null;
  /** 每天固定时刻刷新：「08:00」（时区见 refreshTimeZone）；null = 按间隔。 */
  refreshAt: string | null;
  refreshTimeZone: string | null;
  error: string | null;
  refreshedAt: string | null;
  nextRefreshAt: string | null;
  refreshing: boolean;
  canUndoEdit: boolean;
  createdAt: string;
};

/**
 * 把直连数据源最近一次的好值塞进规范 state 的 `live`（2026-10-22）。
 *
 * 浏览器端拿到第一个读数之前、以及手机原生版（它不轮询 /live）也能看到数字，而不是空白磁贴。
 * 浏览器拿到读数后会用更新的值覆盖同名来源（`live-labels.ts` 的 store.update），不重建组件。
 * 只影响这一次响应：库里的 spec 一个字都不改，机器人交上来的规范仍是唯一来源。
 */
function withLiveState(spec: string | null, state: LivePanelSourceState | null | undefined): string | null {
  if (!spec || !state) return spec;
  const live: Record<string, unknown> = {};
  for (const [id, reading] of Object.entries(state)) {
    if (reading?.ok && reading.value !== undefined) live[id] = reading.value;
  }
  if (Object.keys(live).length === 0) return spec;
  try {
    const parsed = parseRenderUiSpec(spec, false) as { root?: string; state?: Record<string, unknown> } | null;
    if (!parsed?.root) return spec;
    const rawLive = parsed.state?.live;
    const baked = rawLive && typeof rawLive === "object" && !Array.isArray(rawLive) ? (rawLive as Record<string, unknown>) : {};
    return JSON.stringify({ ...parsed, state: { ...(parsed.state ?? {}), live: { ...baked, ...live } } });
  } catch {
    return spec;
  }
}

export function toDto(row: LivePanelRow): LivePanelDto {
  return {
    id: row.id,
    botId: row.botId,
    title: row.title,
    status: (row.status as LivePanelDto["status"]) ?? "ready",
    spec: withLiveState(row.spec, row.sourceState),
    sources: row.sources ?? [],
    dataSources: (row.dataSources ?? []).map((source) => ({
      id: source.id,
      kind: source.kind,
      name: source.name,
      intervalSec: source.intervalSec,
      label: sourceLabel(source),
    })),
    instruction: row.instruction,
    refreshMinutes: row.refreshMinutes,
    refreshAt: row.refreshAt?.split("@")[0] ?? null,
    refreshTimeZone: row.refreshAt?.split("@")[1] ?? null,
    error: row.error,
    refreshedAt: row.refreshedAt?.toISOString() ?? null,
    nextRefreshAt: row.nextRefreshAt?.toISOString() ?? null,
    refreshing: Boolean(row.leaseUntil && row.leaseUntil.getTime() > Date.now()),
    canUndoEdit: Boolean((row.previous as { spec?: string } | null)?.spec),
    createdAt: row.createdAt.toISOString(),
  };
}

const sourceSchema = z.object({
  name: z.string().max(60).describe("来源名，如 CoinGecko；本机命令就写「本机命令 top / df」"),
  url: z.string().max(500).optional().describe("来源网址（刚刚读过的真实网址）。本机命令等没有网址的来源不填，不要编一个"),
});
/** 直连数据源（docs/live-panel-sources.md）：值会变、而且变得比一小时快的数据才用。 */
const dataSourceSchema = z.object({
  kind: z.enum(["http", "command"]).describe("http = 调公开 https 接口；command = 本机命令（只有管理员、且部署设了 CHISABOT_PANEL_COMMANDS=1 时可用）"),
  name: z.string().min(1).max(60).describe("来源名，卡片底部显示（如 CoinGecko、本机负载）。同一个面板里不能重名，重名才能沿用原 id"),
  intervalSec: z.number().int().optional().describe("轮询间隔（秒），服务器会夹到 2–3600；不填默认 60"),
  url: z.string().max(1000).optional().describe("http 的完整 https 网址。密钥写 {{secret:名字}}（先在「设置 → 密钥」里存好），不能写明文"),
  method: z.enum(["GET", "POST"]).optional().describe("http 的方法，默认 GET"),
  headers: z.record(z.string(), z.string()).optional().describe("http 请求头（最多 8 条）。值里的密钥只能写 {{secret:名字}}，不能写明文密钥"),
  body: z.string().max(4000).optional().describe("http POST 的请求体；密钥同样用 {{secret:名字}}"),
  parse: z.enum(["json", "text", "number"]).optional().describe("怎么读返回值：json 整段（默认）/ text 原文 / number 原文里的一个数"),
  command: z.string().max(2000).optional().describe("command 的本机命令（Windows 用 cmd /c，其他平台 sh -c；5 秒超时、输出最多 64 KB）"),
});
const dataSourcesSchema = z
  .array(dataSourceSchema)
  .max(3)
  .describe(
    "直连数据源（可选，最多 3 个；传了就整份替换，不传保持）。只有秒级 / 分钟级会变的数才用（价格、服务器负载、额度、倒计时）；一小时以上才变的仍用刷新回合。规范里用 {\"$state\":\"/live/<数据源 id>\"} 或 {\"$state\":\"/live/<id>/字段\"} 绑定。数据源 id 由服务端生成：名字相同的源沿用原 id。",
  );
const refreshAtSchema = z
  .string()
  .max(5)
  .describe("每天固定时刻刷新，24 小时制「HH:MM」（如 \"08:00\"）。用户说「每天早上 8 点」「每天 18:30」时填；填了就是每天这个时刻刷新一次（不用再填 refreshMinutes）。");
const timeZoneSchema = z.string().max(60).describe("refreshAt 的时区（IANA，如 Asia/Shanghai）。用户没说就不填，默认北京时间。");
const createParameters = z.object({
  title: z.string().min(1).max(60).describe("面板标题，简短中文，如「比特币价格」"),
  instruction: z
    .string()
    .min(1)
    .max(2000)
    .describe("以后每次刷新要做什么：这张面板回答的一个问题、显示哪些数据、从哪里取（写清楚接口或网址）、用【面板设计规范】里的哪个版式（A–E）。刷新时你只看得到这句话和上一版面板。"),
  refreshMinutes: z
    .number()
    .int()
    .min(0)
    .max(10080)
    .optional()
    .describe("自动刷新间隔（分钟）。行情、天气这类会变的数据填 60（最短 60）；用户说每天就填 1440；不会变的内容填 0 = 不刷新。默认 60。"),
  refreshAt: refreshAtSchema.optional(),
  timeZone: timeZoneSchema.optional(),
  dataSources: dataSourcesSchema.optional(),
  duplicate: z.boolean().optional().describe("右栏已有同名面板、而用户确实要再做一个时才填 true"),
});
const updateParameters = z.object({
  id: z.string().min(1).describe("panel_create 返回的面板 id"),
  spec: z
    .string()
    .min(2)
    .max(100_000)
    .optional()
    .describe("面板内容：json-render 规范，格式和组件与 render_ui 完全相同（JSONL 或完整 {root,elements} JSON）。只放结果（数字、图表、列表、表格），不要放「数据来源」「更新时间」，卡片会自己显示。按【面板设计规范】写：先按 300px 窄卡设计，最外层 Stack、不用 Card。刷新时保持元素 key 不变。"),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("只换数据时用（可选）：上一版规范里的值是用 {\"$state\": \"/路径\"} 绑定的，就只交新的 state（如 {\"price\": \"$81,272\"}），不必重交 spec；会合并进上一版的 state。"),
  sources: z.array(sourceSchema).min(1).max(6).describe("这次数据实际来自哪里（必须是你刚刚读过的网址）"),
  title: z.string().min(1).max(60).optional().describe("改标题时才填"),
  instruction: z.string().min(1).max(2000).optional().describe("用户要求修改面板时，填新的刷新说明（例如改成显示以太坊）"),
  refreshMinutes: z.number().int().min(0).max(10080).optional().describe("改刷新间隔时才填（会取消每天固定时刻）"),
  refreshAt: refreshAtSchema.nullable().optional().describe("改成每天固定时刻刷新时填「HH:MM」；取消固定时刻填 null"),
  timeZone: timeZoneSchema.optional(),
  dataSources: dataSourcesSchema.optional(),
});
const LINT_MAX_STRIKES = 3;
/** 卡片上的说明：刷新没做成是因为有人接管着计算机（不是面板坏了）。 */
export const CONTROL_HELD_NOTE = "计算机正由你接管，这次没刷新：在右栏「计算机」里点「交还」，几分钟内会自动刷新。";
const idParameters = z.object({ id: z.string().min(1) });
const failParameters = z.object({ id: z.string().min(1), reason: z.string().min(1).max(300).describe("用一句大白话说明为什么取不到数据") });

export const LIVE_PANEL_GUIDANCE = [
  "面板：用户要「面板 / 看板 / 卡片 / 小组件」或想长期盯着某个会变的东西（价格、天气、汇率、排行、倒计时）时，做成右栏面板，不要只在对话里画：",
  "1) 先 panel_create（标题 + 刷新说明 + 刷新间隔），卡片会立刻出现在右栏；对话里只说一句「好的，正在做…面板」。用户说了每天几点刷新（「每天早上 8 点」）就填 refreshAt（\"08:00\"），会准点刷新，不要说做不到。",
  "2) 再用 web_search / web_fetch 取真实数据（优先公开 JSON 接口，例如 api.coingecko.com、api.open-meteo.com），绝不编造数字。",
  "3) 用 panel_update 交上 json-render 规范 + 来源（来源只写真实读过的网址；本机命令取的数据来源不带 url，不要编网址；数字、列表、表格都直接写成字面值：List 的 items / Table 的 rows 直接列出每一行，不要用 repeat 或 $state 绑定——挂了直连数据源时例外，见下两条）；最后对话里一句话说做好了、多久刷新一次，并提一个有用的下一步。",
  "哪些数据该用直连数据源（panel_create / panel_update 的 dataSources）：会自己变、而且变得比一小时快的数据——实时价格、服务器负载 / 内存、额度余额、倒计时、在线状态。一小时以上才变一次的内容（新闻、天气、每天一次的数据）不要挂，仍用刷新回合，省得白轮询。挂之前先确认接口稳定、返回 JSON，并把数据源 id 记下来（返回的 dataSources 里有）。",
  "规范里怎么绑数据源：Metric / List / Table / Chart 的值写 {\"$state\": \"/live/<id>\"}（整段值），或 {\"$state\": \"/live/<id>/字段\"}（JSON 里的一个字段，例如 /live/src_x/price）；前端会把读数合并进 /live，不用自己写 state。只有挂了数据源的这些绑定才允许用 $state；其余数字仍然直接写字面值。",
  PANEL_DESIGN_GUIDE,
  "要改已有面板（换内容、换城市、换币种、改刷新频率）时先 panel_list 找到它，取新数据后 panel_update（带新的 instruction / title），不要新建。",
  "实在取不到数据就 panel_fail 说明原因，并在对话里如实告诉用户。不要在对话里贴规范、JSON 或代码。",
  "用户说面板刷新失败 / 坏了 / 过期，要你修时：先 panel_list 看它的报错，找到原因并修（取数方式不对就 panel_update 带新的 instruction）；修完必须调用 panel_refresh 真跑一次刷新，只有它返回 ok:true 才能说修好了。返回失败就把它给的原因原样用中文告诉用户、说下一步要用户做什么，不要说「救回来了」。",
  "工具结果里有 humanHasControl / 「没有执行」时：那一步没做成。照实告诉用户（例如请在右栏「计算机」里点「交还」），不要假装完成，也不要不说话就结束。",
].join("\n");


/**
 * 只换数据（DESIGN.md §32「布局和数据分开」）：把 data 深合并进上一版规范的 state，返回新的完整规范（JSON）。
 * 上一版没有规范、或者规范里一个 $state 绑定都没有（换了 state 也不会显示）时返回 null，让机器人交完整 spec。
 */
export function mergePanelData(previous: string | null, data: Record<string, unknown>): string | null {
  if (!previous) return null;
  const spec = parseRenderUiSpec(previous, false) as { root?: string; elements?: Record<string, unknown>; state?: Record<string, unknown> } | null;
  if (!spec?.root || !spec.elements) return null;
  if (!JSON.stringify(spec.elements).includes('"$state"')) return null;
  const merge = (base: unknown, patch: unknown): unknown => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
    const out: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) out[key] = merge(out[key], value);
    return out;
  };
  return JSON.stringify({ ...spec, state: merge(spec.state ?? {}, data) });
}

/**
 * 面板里的大数字不能是空的（2026-10-13 第二轮实测：比特币面板「现价（美元）」下面一片空白——
 * 模型把数值绑到了 state 里不存在的路径）。json-render 的校验只管结构，这里补一道：Metric 的 value
 * 为空、或 $state 指向 spec.state 里没有的值，就退回去让机器人直接写数字。
 */
export function emptyMetrics(source: string, options: { live?: boolean } = {}): string[] {
  const spec = sanitizeRenderUiSpec(parseRenderUiSpec(source, false))?.spec as
    | { elements?: Record<string, { type?: string; props?: Record<string, unknown> }>; state?: Record<string, unknown> }
    | undefined;
  if (!spec?.elements) return [];
  const lookup = (path: string) =>
    path
      .split("/")
      .filter(Boolean)
      .reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), spec.state ?? {});
  const missing: string[] = [];
  for (const element of Object.values(spec.elements)) {
    if (element?.type !== "Metric") continue;
    const value = element.props?.value;
    const label = String(element.props?.label ?? "数值");
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) missing.push(label);
    else if (typeof value === "object" && typeof (value as { $state?: unknown }).$state === "string") {
      // 挂了直连数据源的 Metric 绑定 /live/<id>：值在运行时才有，这里不能当空值退回。
      // panel_update 会显式传 live（没有数据源时 false）；直接调用默认放行，免得把运行时绑定误判成空值。
      if (options.live !== false && (value as { $state: string }).$state.startsWith("/live/")) continue;
      const resolved = lookup((value as { $state: string }).$state);
      if (resolved === undefined || resolved === null || resolved === "") missing.push(label);
    }
  }
  return missing;
}

/**
 * emptySections（shared/json-render/empty-sections.ts）只认 spec.state 里的静态值；/live/<id> 在运行时才填，
 * 直接交给它会把所有数据源绑定都判成空、把面板退回。这里把 /live 绑定替换成一个非空占位再检查：
 * 只影响这次检查，存库的规范一个字都不改。
 */
function maskLiveBindings<T>(spec: T): T {
  let masked = false;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.$state === "string" && record.$state.startsWith("/live/")) {
      masked = true;
      return { $state: "/__live" };
    }
    if (typeof record.statePath === "string" && record.statePath.startsWith("/live/")) {
      masked = true;
      return { ...record, statePath: "/__live" };
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = walk(entry);
    return out;
  };
  const copy = walk(spec) as T & { state?: Record<string, unknown> };
  if (masked && copy && typeof copy === "object") copy.state = { ...(copy.state ?? {}), __live: [{}, {}] };
  return copy;
}

/** 面板上有没有可用的直连数据源（决定 /live 绑定能不能在空值检查里放行）。 */
function hasLiveSources(sources: readonly LivePanelDataSource[] | null | undefined): boolean {
  return (sources ?? []).length > 0;
}

/** 「，之后每天 08:00 自动刷新」/「，之后每 1 小时自动刷新」 */
function cadenceWords(row: LivePanelRow) {
  if (row.refreshAt) return `，之后每天 ${row.refreshAt.split("@")[0]} 自动刷新`;
  const m = row.refreshMinutes;
  if (!m) return "";
  return `，之后每 ${m >= 1440 ? `${Math.round(m / 1440)} 天` : m >= 60 ? `${Math.round(m / 60)} 小时` : `${m} 分钟`}自动刷新`;
}

/** 删机器人时中止刷新用的原因（不算失败、不写卡片）。 */
export const BOT_DELETED = "机器人已删除";

export type LivePanelServiceDeps = {
  store: LivePanelStore;
  /** 在一个用完即删的对话里，以面板主人的身份跑这个机器人的一个无头回合（工作流同一条路）。 */
  runHeadless(input: { ownerUserId: string; botId: string; instruction: string; panelId: string; signal: AbortSignal }): Promise<void>;
  /** 直连数据源的 HTTP 通道：正式部署注入 vault.request（{{secret:名}}、域名绑定、guardedFetch、抹密钥）。 */
  requestHttp?: LivePanelRequestHttp;
  /** 测试注入；不注入时命令源直接用 Bun.spawn 跑本机命令。 */
  commandRunner?: LivePanelCommandRunner;
  log?: (event: Record<string, unknown>) => void;
};

export type { LivePanelCommandRunner, LivePanelRequestHttp };

export function createLivePanelService(deps: LivePanelServiceDeps) {
  const { store } = deps;
  const log = deps.log ?? ((event) => console.info(JSON.stringify(event)));
  const sourceRunner = createSourceRunner({ store, deps, log });
  const running = new Map<string, AbortController>();
  /** 正在刷新的面板属于哪个机器人（删机器人时停掉它的刷新）。 */
  const runningBot = new Map<string, string>();
  /** 正在跑的刷新（panel_refresh 等它结束再回答）。 */
  const jobs = new Map<string, Promise<void>>();
  /** 每张面板连续被设计检查退回的次数（只在内存里，重启清零）。 */
  const lintStrikes = new Map<string, number>();

  function refreshPrompt(row: LivePanelRow, firstFill: boolean) {
    return [
      `【后台刷新面板，不是用户在聊天】面板「${row.title}」（id: ${row.id}）${firstFill ? "还没有内容，需要第一次填好" : "需要刷新数据"}。`,
      `刷新说明：${row.instruction}`,
      row.spec
        ? `上一版面板规范（保持同样的布局和每个元素的 key，只换成最新数据——这样用户看到的是数字平滑滚动到新值，而不是整张重画；值是 $state 绑定的就只交 data）：\n${row.spec.slice(0, 12_000)}`
        : "",
      "现在：按刷新说明取最新的真实数据（网上的数据用 web_search / web_fetch；说明里写了本机命令就用 computer_run_command），然后调用 panel_update（id 同上，带 spec（或只带 data）和 sources）。取不到就调用 panel_fail 用中文大白话说明原因。不要做别的事，也不需要回复任何文字。",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function refreshNow(ownerUserId: string, id: string): Promise<{ started: boolean; reason?: string }> {
    const row = await store.get(ownerUserId, id);
    if (row.removed) throw new LivePanelError("这个面板已经删除了", 404);
    if (!(await store.claim(ownerUserId, id))) return { started: false, reason: "正在刷新" };
    const startedAt = Date.now();
    const controller = new AbortController();
    running.set(id, controller);
    runningBot.set(id, row.botId);
    const timer = setTimeout(() => controller.abort(new Error("刷新超时")), 6 * 60_000);
    const self: { job?: Promise<void> } = {};
    const job = (async () => {
      try {
        await deps.runHeadless({ ownerUserId, botId: row.botId, instruction: refreshPrompt(row, !row.spec), panelId: id, signal: controller.signal });
        const after = await store.get(ownerUserId, id);
        const updated = after.refreshedAt && after.refreshedAt.getTime() >= startedAt;
        if (!updated && takeHumanControlBlock(id, startedAt)) {
          // 不是面板坏了：有人接管着计算机，命令被拒。写清楚、不算失败，5 分钟后再试（control-blocks.ts）。
          await store.defer(ownerUserId, id, CONTROL_HELD_NOTE, 5 * 60_000, row.failures);
          log({ type: "live-panel-refresh", id, ok: false, reason: "human-has-control", ms: Date.now() - startedAt });
          return;
        }
        const failedNow = after.error && after.updatedAt.getTime() >= startedAt && !updated;
        if (!updated && !failedNow) await store.fail(ownerUserId, id, "这次刷新没有拿到新数据（机器人没有更新面板），稍后会再试。");
        log({ type: "live-panel-refresh", id, ok: Boolean(updated), ms: Date.now() - startedAt });
      } catch (error) {
        const reason = reasonWithoutStatement(error);
        if (takeHumanControlBlock(id, startedAt) || /A person has control|Take a fresh browser snapshot/.test(reason)) {
          await store.defer(ownerUserId, id, CONTROL_HELD_NOTE, 5 * 60_000, row.failures).catch(() => {});
        } else if (controller.signal.aborted && String(controller.signal.reason?.message ?? controller.signal.reason) === BOT_DELETED) {
          // 机器人被删了：面板已经软删除，什么都不用写。
        } else if (controller.signal.aborted && String(controller.signal.reason?.message ?? controller.signal.reason) === "服务器重启") {
          // 部署 / 重启打断的刷新不算失败，重启后 2 分钟内重来。
          await store.defer(ownerUserId, id, "刷新被服务器重启打断，马上会重新刷新。", 2 * 60_000, row.failures).catch(() => {});
        } else {
          await store.fail(ownerUserId, id, `刷新失败：${reason.slice(0, 200)}`).catch(() => {});
        }
        log({ type: "live-panel-refresh", id, ok: false, reason: reason.slice(0, 200) });
      } finally {
        clearTimeout(timer);
        // 只清自己的登记（不要把后来那一次的清掉）。
        if (running.get(id) === controller) {
          running.delete(id);
          runningBot.delete(id);
        }
        if (jobs.get(id) === self.job) jobs.delete(id);
        await store.release(ownerUserId, id).catch(() => {});
      }
    })();
    self.job = job;
    jobs.set(id, job);
    return { started: true };
  }

  /**
   * 机器人在对话里「修好」面板后必须用它验证（2026-10-13：机器人说「救回来了」，其实刷新照样失败）。
   * 真跑一次后台刷新（和定时刷新同一条路），等它结束，按卡片上的真实结果回答。
   */
  async function refreshAndWait(ownerUserId: string, id: string, waitMs = 4 * 60_000) {
    const startedAt = Date.now();
    const kicked = await refreshNow(ownerUserId, id);
    const job = jobs.get(id);
    if (job) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job, new Promise((resolve) => { timeout = setTimeout(resolve, waitMs); })]);
      if (timeout) clearTimeout(timeout);
    }
    const after = await store.get(ownerUserId, id);
    const ok = Boolean(after.refreshedAt && after.refreshedAt.getTime() >= startedAt && !after.error);
    return { ok, stillRunning: jobs.has(id), alreadyRunning: !kicked.started, panel: after };
  }

  /** 每分钟一次：到点的面板刷新；建了卡片却一直没填的，补跑一次，再不行就标失败。 */
  async function sweep() {
    try {
      for (const row of await store.due(3)) {
        if (running.size >= 3) break;
        await refreshNow(row.ownerUserId, row.id).catch((error) => log({ type: "live-panel-sweep-error", id: row.id, reason: String(error) }));
      }
      // 建了卡片却一直没填（聊天里的回合中途放弃）：标成「正在重试」，补跑一次后台填充；
      // 再失败就停在失败状态，卡片上写明原因（staleBuilding 只挑 building，不会无限重试）。
      for (const row of await store.staleBuilding(3 * 60_000)) {
        if (running.size >= 3) break;
        await store.fail(row.ownerUserId, row.id, "第一次没填好，正在重试…").catch(() => {});
        await refreshNow(row.ownerUserId, row.id).catch(() => {});
      }
    } catch (error) {
      log({ type: "live-panel-sweep-failed", reason: reasonWithoutStatement(error) });
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * 用户点了「交还」：因为「计算机正由你接管」而推迟的面板马上重刷（2026-10-13 实测：交还后卡片上
   * 那句「正由你接管」还要挂 5 分钟，像是交还没生效）。
   */
  async function resumeAfterHandback(ownerUserId: string) {
    try {
      const rows = await store.dueNowIfNoted(ownerUserId, CONTROL_HELD_NOTE);
      for (const row of rows.slice(0, 3)) await refreshNow(ownerUserId, row.id).catch(() => {});
      if (rows.length) log({ type: "live-panel-resume-after-handback", ids: rows.map((r) => r.id) });
    } catch (error) {
      log({ type: "live-panel-resume-failed", reason: reasonWithoutStatement(error) });
    }
  }

  function tools(actorId: string, botId: string, options: { refreshOf?: string; isAdmin?: boolean | (() => Promise<boolean>) } = {}): GrantedTool[] {
    const guard = async (id: string) => {
      // 后台刷新的回合只能动它在刷新的那一张。
      if (options.refreshOf && id !== options.refreshOf) throw new LivePanelError(`这是面板 ${options.refreshOf} 的后台刷新，只能更新这一张`, 404);
      const row = await store.get(actorId, id);
      if (row.botId !== botId) throw new LivePanelError("这个面板不属于当前机器人", 404);
      return row;
    };
    const say = (error: unknown) => `${REFUSAL_MARKER} ${error instanceof Error ? error.message : "操作失败"}`;
    /*
     * 命令数据源只给管理员，但查一次角色要读一次人：每轮装机工具时都查会白白多一次查询。
     * 这里接受一个懒查询，只有机器人真的交上数据源时才问（正常回合完全不碰）。
     */
    const amAdmin = async () =>
      typeof options.isAdmin === "function" ? await options.isAdmin().catch(() => false) : options.isAdmin === true;
    const list: GrantedTool[] = [
      {
        name: "panel_update",
        ref: "live-panels/panel_update",
        description:
          "把取到的真实数据画进右栏面板（首次填充、刷新、或按用户要求修改）。spec 用 render_ui 同一套组件（含图表 Chart / Sparkline、环 Ring、仪表 Gauge、热力 HeatStrip、封面 Hero、状态 Status、倒计时 Countdown 等），来源 sources 必填。必须遵守系统提示里的【面板设计规范】（一层外壳不用 Card、不重复标题、磁贴 ≤2、大块 ≤2、≤5 行、短标签、不写段落、有网址就写 href）；不合格会被退回并写明怎么改，照改后重新调用。",
        parameters: updateParameters,
        execute: async (args) => {
          const parsed = updateParameters.safeParse(args);
          if (!parsed.success) return `${REFUSAL_MARKER} 参数不对：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`;
          try {
            const current = await guard(parsed.data.id);
            // 直连数据源：传了才整份替换，不传保持。id 按 name 复用，规范里的 /live/<id> 绑定不会因为改间隔失效。
            const rawSources = parsed.data.dataSources;
            const dataSources =
              rawSources === undefined ? undefined : normalizeSources(rawSources, { isAdmin: await amAdmin(), existing: current.dataSources ?? [] });
            const live = hasLiveSources(dataSources !== undefined ? dataSources : current.dataSources);
            // 只换数据：把 data 合并进上一版规范的 state（布局不变，浏览器里数字原地滚动）。
            let specText = parsed.data.spec;
            if (!specText) {
              if (!parsed.data.data) return `${REFUSAL_MARKER} 需要 spec（完整面板规范），或者只换数据时给 data。`;
              const merged = mergePanelData(current.spec, parsed.data.data);
              if (!merged) return `${REFUSAL_MARKER} 这张面板还没有可以只换数据的规范（第一次填充或没有用 $state 绑定），请交完整的 spec。`;
              specText = merged;
            }
            const verdict = inspectRenderUiSpec(specText);
            if (!verdict.ok) return [`${REFUSAL_MARKER} 面板规范无效，没有保存。修正后再调用 panel_update：`, ...verdict.issues.map((i) => `- ${i}`)].join("\n");
            const empty = emptyMetrics(specText, { live });
            if (empty.length)
              return `${REFUSAL_MARKER} 面板没有保存：${empty.map((l) => `「${l}」`).join("、")}没有数值。把取到的数字直接写进 Metric 的 value（字符串，例如 "$82,407"）；挂了直连数据源的才用 {"$state":"/live/<id>"} 绑定，然后再调用 panel_update。`;
            // 空列表 / 空重复区块（2026-10-13 第三轮实测：香港天气「未来 5 天」只剩标题）：退回去让机器人把数据写进去。
            // 挂了数据源的 /live 绑定运行时才有值，检查前先换成非空占位（maskLiveBindings），别把整张面板退回。
            const parsedSpec = sanitizeRenderUiSpec(parseRenderUiSpec(specText, false))?.spec ?? null;
            const hollow = emptySections(live ? maskLiveBindings(parsedSpec) : parsedSpec);
            if (hollow.length)
              return `${REFUSAL_MARKER} 面板没有保存：${hollow.map((l) => `「${l}」`).join("、")}下面是空的（List 的 items / Table 的 rows 是空的，或 repeat.statePath 指向的 state 数组不存在或为空）。把取到的每一行直接写进 List 的 items（或 Table 的 rows），不要用 repeat 和 $state（挂了数据源时用 /live/<id> 绑定），然后再调用 panel_update；确实没有数据就把这一节连同标题一起删掉。`;
            // 面板设计规范（design.ts）：不合格就退回并写明每一处怎么改。同一张面板连续退回 3 次后照样保存
            // （渲染端有兜底），免得机器人在一个规范细节上来回打转、面板一直空着。
            const lint = lintPanelSpec(specText, parsed.data.title ?? current.title, { liveSources: live });
            const strikes = lintStrikes.get(parsed.data.id) ?? 0;
            if (lint.length && strikes < LINT_MAX_STRIKES) {
              lintStrikes.set(parsed.data.id, strikes + 1);
              log({ type: "live-panel-lint", panelId: parsed.data.id, strike: strikes + 1, issues: lint });
              return [`${REFUSAL_MARKER} 面板没有保存：不符合【面板设计规范】。逐条改好后用同一个 id 重新调用 panel_update（不要新建面板，也不要在对话里解释）：`, ...lint.map((i) => `- ${i}`)].join("\n");
            }
            lintStrikes.delete(parsed.data.id);
            const { data: _data, dataSources: _rawSources, ...input } = parsed.data;
            const { timeZone, refreshAt: rawAt, ...rest } = input;
            let refreshAt: string | null | undefined = undefined;
            if (rawAt === null) refreshAt = null;
            else if (rawAt !== undefined) {
              refreshAt = normalizeRefreshAt(rawAt, timeZone);
              if (!refreshAt) return `${REFUSAL_MARKER} refreshAt 要写成 24 小时制「HH:MM」（如 "08:00"），timeZone 要是 IANA 时区（如 Asia/Shanghai）。`;
            }
            const row = await store.update(actorId, parsed.data.id, {
              ...rest,
              ...(dataSources !== undefined ? { dataSources } : {}),
              ...(refreshAt !== undefined ? { refreshAt } : {}),
              spec: specText,
              edit: Boolean(parsed.data.instruction || parsed.data.title) && !options.refreshOf,
            });
            const sourceHint = (row.dataSources ?? []).length
              ? ` 数据源 id：${row.dataSources.map((source) => `${source.id}（${source.name}）`).join("、")}；规范里用 {"$state":"/live/<id>"} 绑定。`
              : "";
            return `面板「${row.title}」已更新${cadenceWords(row)}。${sourceHint}${options.refreshOf ? "这是后台刷新，不需要回复。" : "对话里只用一句话告诉用户，不要贴面板内容或规范。"}`;
          } catch (error) {
            return say(error);
          }
        },
      },
      {
        name: "panel_fail",
        ref: "live-panels/panel_fail",
        description: "取不到面板需要的数据时调用，用一句大白话写明原因（会显示在面板卡片上）。",
        parameters: failParameters,
        execute: async (args) => {
          const parsed = failParameters.safeParse(args);
          if (!parsed.success) return `${REFUSAL_MARKER} 需要 id 和 reason`;
          try {
            await guard(parsed.data.id);
            await store.fail(actorId, parsed.data.id, parsed.data.reason);
            return "已记下原因并显示在面板上。";
          } catch (error) {
            return say(error);
          }
        },
      },
    ];
    if (options.refreshOf) return list;
    return [
      {
        name: "panel_create",
        ref: "live-panels/panel_create",
        description:
          "在右栏新建一个会自动刷新的面板（用户要面板 / 看板 / 小组件，或想持续关注某个会变的数据时）。立刻返回 id，卡片先显示「正在搭建」；接着取真实数据并调用 panel_update 填好。改已有面板不要新建，用 panel_list + panel_update。",
        parameters: createParameters,
        execute: async (args) => {
          const parsed = createParameters.safeParse(args);
          if (!parsed.success) return `${REFUSAL_MARKER} 面板参数不对：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`;
          try {
            // 一个主题一张卡（Hark 的做法）：同名面板已在右栏就先别新建，让机器人去更新那张。
            if (!parsed.data.duplicate) {
              const same = (await store.list(actorId, botId)).find((r) => r.title.trim() === parsed.data.title.trim());
              if (same)
                return JSON.stringify({
                  created: false,
                  existing: { id: same.id, title: same.title, status: same.status },
                  next: "右栏已经有这张面板，没有新建。用户要的若是同一个东西，就取最新数据后 panel_update 这张（id 见 existing）；用户明确要再做一张时，才带 duplicate: true 重新 panel_create。",
                });
            }
            const { duplicate: _duplicate, refreshAt: rawAt, timeZone, dataSources: rawSources, ...input } = parsed.data;
            const refreshAt = rawAt ? normalizeRefreshAt(rawAt, timeZone) : null;
            if (rawAt && !refreshAt) return `${REFUSAL_MARKER} refreshAt 要写成 24 小时制「HH:MM」（如 "08:00"），timeZone 要是 IANA 时区（如 Asia/Shanghai）。`;
            const dataSources = normalizeSources(rawSources, { isAdmin: await amAdmin() });
            const row = await store.create(actorId, botId, { ...input, dataSources, refreshAt, refreshMinutes: input.refreshMinutes ?? MIN_REFRESH_MINUTES });
            return JSON.stringify({
              id: row.id,
              status: "building",
              dataSources: (row.dataSources ?? []).map((source) => ({ id: source.id, name: source.name, kind: source.kind, intervalSec: source.intervalSec })),
              next: "卡片已出现在右栏（正在搭建）。现在用 web_search / web_fetch 取真实数据，然后调用 panel_update 填好；挂了数据源的，用返回的 dataSources[].id 写 {\"$state\":\"/live/<id>\"} 绑定。",
            });
          } catch (error) {
            return say(error);
          }
        },
      },
      {
        name: "panel_list",
        ref: "live-panels/panel_list",
        description: "列出当前机器人右栏里的实时面板（id、标题、状态、刷新说明、刷新间隔、上次更新）。修改或删除面板前先用它找到 id。",
        parameters: z.object({}),
        execute: async () => {
          const rows = await store.list(actorId, botId);
          if (rows.length === 0) return "右栏还没有实时面板。";
          return rows
            .map(
              (r) =>
                `- ${r.id}｜${r.title}｜${r.status}${r.error ? `（${r.error}）` : ""}｜${r.refreshAt ? `每天 ${r.refreshAt.replace("@", "（")}）` : `每 ${r.refreshMinutes ?? 0} 分钟`}｜上次更新 ${r.refreshedAt?.toISOString() ?? "无"}${r.dataSources?.length ? `｜数据源 ${r.dataSources.map((source) => `${source.id}（${source.name}）`).join("、")}` : ""}｜说明：${r.instruction}`,
            )
            .join("\n");
        },
      },
      {
        name: "panel_refresh",
        ref: "live-panels/panel_refresh",
        description:
          "立刻真跑一次某个面板的后台刷新（和每小时的自动刷新同一条路），等它跑完（最多约 4 分钟）再返回真实结果。修面板之后必须用它验证：只有返回 ok:true 才能告诉用户修好了。",
        parameters: idParameters,
        execute: async (args) => {
          const parsed = idParameters.safeParse(args);
          if (!parsed.success) return `${REFUSAL_MARKER} 需要 id`;
          try {
            await guard(parsed.data.id);
            const result = await refreshAndWait(actorId, parsed.data.id);
            const p = result.panel;
            if (result.ok)
              return JSON.stringify({ ok: true, title: p.title, refreshedAt: p.refreshedAt?.toISOString(), next: "刷新成功，面板已是最新数据。对话里一句话告诉用户修好了。" });
            return JSON.stringify({
              ok: false,
              title: p.title,
              error: p.error ?? (result.stillRunning ? "刷新还在跑，没在 4 分钟内结束" : "这次刷新没有更新面板"),
              next: "没有修好。把 error 用中文原样告诉用户，并说清下一步要用户做什么；不要说已经修好。",
            });
          } catch (error) {
            return say(error);
          }
        },
      },
      {
        name: "panel_remove",
        ref: "live-panels/panel_remove",
        description: "用户明确要求删除某个面板时调用（用户 10 分钟内可在右栏撤销）。",
        parameters: idParameters,
        execute: async (args) => {
          const parsed = idParameters.safeParse(args);
          if (!parsed.success) return `${REFUSAL_MARKER} 需要 id`;
          try {
            await guard(parsed.data.id);
            await store.remove(actorId, parsed.data.id);
            return "已删除（用户可在右栏撤销）。";
          } catch (error) {
            return say(error);
          }
        },
      },
      ...list,
    ];
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    const fail = (c: { json: (b: unknown, s: number) => Response }, error: unknown) =>
      error instanceof LivePanelError ? c.json({ error: error.message }, error.status) : c.json({ error: "面板服务暂时不可用" }, 500);
    app.get("/", async (c) => {
      const botId = c.req.query("botId");
      if (!botId) return c.json({ error: "缺少 botId" }, 400);
      const rows = await store.list(c.var.actor.id, botId);
      return c.json({ items: rows.map(toDto) });
    });
    /**
     * 直连数据源的读数（docs/live-panel-sources.md §4）：浏览器只在卡片可见、没折叠时轮询。
     * 取数失败也回 200：读数里带 ok:false + 中文 error，前端保留旧值并把来源那一行标红。
     */
    app.get("/:id/live", async (c) => {
      try {
        const owner = c.var.actor.id;
        const row = await store.get(owner, c.req.param("id"));
        if (row.removed) throw new LivePanelError("这个面板已经删除了", 404);
        return c.json(await sourceRunner.readings(owner, row, { isAdmin: c.var.actor.role === "admin", signal: c.req.raw.signal }));
      } catch (error) {
        return fail(c, error);
      }
    });
    app.post("/:id/live/refresh", async (c) => {
      try {
        const owner = c.var.actor.id;
        const row = await store.get(owner, c.req.param("id"));
        if (row.removed) throw new LivePanelError("这个面板已经删除了", 404);
        return c.json(
          await sourceRunner.readings(owner, row, { force: true, isAdmin: c.var.actor.role === "admin", signal: c.req.raw.signal }),
        );
      } catch (error) {
        return fail(c, error);
      }
    });
    app.post("/:id/refresh", async (c) => {
      try {
        const result = await refreshNow(c.var.actor.id, c.req.param("id"));
        return c.json({ ...result, panel: toDto(await store.get(c.var.actor.id, c.req.param("id"))) });
      } catch (error) {
        return fail(c, error);
      }
    });
    app.post("/:id/undo-edit", async (c) => {
      try {
        return c.json({ panel: toDto(await store.undoEdit(c.var.actor.id, c.req.param("id"))) });
      } catch (error) {
        return fail(c, error);
      }
    });
    app.patch("/:id", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { refreshMinutes?: number | null; refreshAt?: string | null; timeZone?: string };
      try {
        if (body.refreshAt) {
          const current = await store.get(c.var.actor.id, c.req.param("id"));
          const at = normalizeRefreshAt(body.refreshAt, body.timeZone ?? current.refreshAt?.split("@")[1] ?? "Asia/Shanghai");
          if (!at) return c.json({ error: "时间格式不对" }, 400);
          return c.json({ panel: toDto(await store.setRefresh(c.var.actor.id, c.req.param("id"), 1440, at)) });
        }
        if (body.refreshMinutes === undefined) return c.json({ error: "没有要改的内容" }, 400);
        return c.json({ panel: toDto(await store.setRefresh(c.var.actor.id, c.req.param("id"), body.refreshMinutes)) });
      } catch (error) {
        return fail(c, error);
      }
    });
    app.delete("/:id", async (c) => {
      try {
        running.get(c.req.param("id"))?.abort(new Error("面板已删除"));
        await store.remove(c.var.actor.id, c.req.param("id"));
        return c.json({ ok: true });
      } catch (error) {
        return fail(c, error);
      }
    });
    app.post("/:id/restore", async (c) => {
      try {
        return c.json({ panel: toDto(await store.restore(c.var.actor.id, c.req.param("id"))) });
      } catch (error) {
        return fail(c, error);
      }
    });
    app.post("/order", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { botId?: string; ids?: string[] };
      if (!body.botId || !Array.isArray(body.ids)) return c.json({ error: "缺少 botId / ids" }, 400);
      await store.move(c.var.actor.id, body.botId, body.ids.slice(0, 50));
      return c.json({ ok: true });
    });
    return app;
  }

  /**
   * 删机器人（agents/purge.ts）：先把它的面板软删除、停掉调度，再中止它正在跑的刷新。
   * 返回软删除的面板 id。
   */
  async function retireBot(botId: string): Promise<string[]> {
    const ids = await store.retireForBot(botId);
    for (const [id, owner] of runningBot) {
      if (owner !== botId) continue;
      running.get(id)?.abort(new Error(BOT_DELETED));
    }
    for (const id of ids) lintStrikes.delete(id);
    if (ids.length) log({ type: "live-panel-bot-deleted", botId, retired: ids.length });
    return ids;
  }

  return {
    tools,
    routes,
    retireBot,
    refreshNow,
    refreshAndWait,
    resumeAfterHandback,
    sweep,
    start() {
      // 删机器人以前不清面板：开机把机器人已不在的面板删掉（幂等；CHISABOT_PANEL_ORPHAN_SWEEP=0 关掉）。
      if (process.env.CHISABOT_PANEL_ORPHAN_SWEEP !== "0")
        void store
          .sweepOrphans()
          .then((ids) => ids.length && log({ type: "live-panel-orphans-removed", removed: ids.length, ids }))
          .catch((error) => log({ type: "live-panel-orphan-sweep-failed", reason: reasonWithoutStatement(error) }));
      void store
        .releaseOrphanLeases()
        .then((n) => n && log({ type: "live-panel-orphan-leases", released: n }))
        .catch(() => {});
      timer ??= setInterval(() => void sweep(), 60_000);
      setTimeout(() => void sweep(), 15_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const controller of running.values()) controller.abort(new Error("服务器重启"));
    },
  };
}
export type LivePanelService = ReturnType<typeof createLivePanelService>;
