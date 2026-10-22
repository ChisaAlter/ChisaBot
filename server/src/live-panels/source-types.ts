/**
 * 面板的直连数据源（2026-10-22，参考 dsh-pad 的「秒级刷新、不烧 token」）。
 *
 * 机器人做面板时可以不再只靠「每小时跑一个无头回合取数」：给面板挂一个数据源，宿主自己按秒级轮询
 * 本机命令 / 公开 HTTP 接口，值回填到规范里 `{"$state": "/live/<id>"}` 绑定的位置。机器人只写一次规范，
 * 之后不再为刷新花 token。
 *
 * 存在 `live_panels.data_sources`（定义）与 `live_panels.source_state`（最近一次读数），
 * 执行与校验在 `server/src/live-panels/sources.ts`。
 */

/** 一个数据源的定义。密钥一律写 `{{secret:名字}}`（保险箱），绝不存明文。 */
export type LivePanelDataSource = {
  /** 稳定 id（`src_` 前缀）：规范里的 `/live/<id>` 用它，改这个名字等于改面板绑定。 */
  id: string;
  kind: "http" | "command";
  /** 卡片底部「来源」写的名字，如「CoinGecko」「本机 uptime」。 */
  name: string;
  /** 轮询间隔（秒，2–3600）。 */
  intervalSec: number;
  /** http：完整网址（https；可以带 {{secret:名字}}）。 */
  url?: string;
  method?: "GET" | "POST";
  /** http：请求头。值里只能出现 {{secret:名字}}，不能写明文密钥。 */
  headers?: Record<string, string>;
  /** http：请求体（POST）。 */
  body?: string;
  /** http：回来的内容怎么读。json = 整段 JSON；text = 原文（截断）；number = 原文里的一个数。 */
  parse?: "json" | "text" | "number";
  /** command：在本机执行的命令（仅管理员 + CHISABOT_PANEL_COMMANDS=1 时可用）。 */
  command?: string;
};

/** 一次读数（回填给前端，也存进 `source_state`）。 */
export type LivePanelSourceReading = {
  ok: boolean;
  /** 解析后的值（JSON 可序列化）。json 源是整段对象 / 数组，text 是字符串，number 是数字。 */
  value: unknown;
  /** 失败原因（中文、已经抹掉密钥值、截断到 300 字）。 */
  error?: string;
  /** 取数完成的时刻（ISO）。 */
  at: string;
  /** 这一次用了多少毫秒。 */
  ms: number;
};

export type LivePanelSourceState = Record<string, LivePanelSourceReading>;

/** 每个面板最多几个数据源（再多，卡片底部和一次取数都撑不住）。 */
export const MAX_SOURCES_PER_PANEL = 3;
export const MIN_SOURCE_INTERVAL_SEC = 2;
export const MAX_SOURCE_INTERVAL_SEC = 3600;
/** 一次取数最多等多久（命令更短：它就在本机）。 */
export const SOURCE_HTTP_TIMEOUT_MS = 8_000;
export const SOURCE_COMMAND_TIMEOUT_MS = 5_000;
/** 回来的内容最多留多少（字符）；命令输出同理。 */
export const SOURCE_VALUE_MAX_CHARS = 20_000;
export const SOURCE_COMMAND_OUTPUT_MAX_BYTES = 64 * 1024;
