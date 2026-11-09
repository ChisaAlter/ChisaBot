import type { ImPlatform } from "../../../shared/im";

/** 平台收到的一条消息，已经变成和平台无关的样子。 */
export type ImInbound = {
  /** 平台的消息 id（回复、去重用）。 */
  messageId: string;
  chatType: "private" | "group";
  /** 私聊 = 对方的用户 id；群聊 = 群 id（频道 = 子频道 id）。 */
  chatId: string;
  /** 发消息的人。 */
  userId: string;
  userName?: string;
  /** 文字内容，已经去掉 @ 机器人的部分。 */
  text: string;
  /** 群聊里是否 @ 了机器人（或回复了机器人的消息）。私聊恒为 true。 */
  mentioned: boolean;
  /** 适配器回复时需要的平台原始信息（被动回复的 msg_id、req_id、sessionWebhook……）。 */
  reply: Record<string, unknown>;
  /** 图片等附件：只记数量 / 地址，这一版不发给模型。 */
  attachments?: { kind: "image" | "file" | "voice" | "video"; url?: string }[];
};

export type ImLogLevel = "info" | "warn" | "error";

export type ImAdapterStatus = {
  state: "connecting" | "connected" | "error" | "waiting";
  detail?: string | null;
  account?: string | null;
};

/** 最小的 WebSocket 接口（Bun / 浏览器的全局 WebSocket 都满足；测试里换成假的）。 */
export type WsLike = {
  readyState: number;
  binaryType?: string;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type WsFactory = (
  url: string,
  options?: {
    headers?: Record<string, string>;
    /**
     * 这条连接的管理员显式开了「允许内网地址」、且目标是该连接自己配置的协议端时才为 true：
     * 本机 / 内网可连，云元数据仍拦。用户 / 模型给的地址永远不传。
     */
    allowPrivate?: boolean;
  },
) => WsLike;

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type AdapterContext = {
  connectionId: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  log: (level: ImLogLevel, text: string) => void;
  setStatus: (status: ImAdapterStatus) => void;
  /** 收到消息：交给服务排队跑机器人。 */
  onMessage: (message: ImInbound) => void;
  /** 适配器拿到了新的凭据（微信授权过期刷新之类）要存回去。 */
  saveSecrets?: (patch: Record<string, string>) => Promise<void>;
  fetch: FetchLike;
  ws: WsFactory;
  /** 计时器可注入，测试里不用真等。 */
  sleep?: (ms: number) => Promise<void>;
};

export type ImReply = {
  inbound: ImInbound;
  /** 已经按平台格式整理、切好段的文字。 */
  chunks: string[];
  /** 完整原文（支持 Markdown 的平台自己决定怎么发）。 */
  text: string;
};

export type ImDeliveryReceipt = { messageIds: string[] };

export interface ImAdapter {
  readonly platform: ImPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 回复一条消息。 */
  send(reply: ImReply): Promise<ImDeliveryReceipt | undefined>;
  /** 「正在输入」之类的提示，可选。 */
  typing?(inbound: ImInbound): Promise<void>;
  /** 回复前的占位（企业微信流式的转圈），可选。 */
  /** 一条消息每段最长多少字。 */
  readonly maxChunk: number;
  /** 这个平台能不能显示 Markdown。 */
  readonly markdown: boolean;
}

export type TestResult = { ok: boolean; detail: string };

export type AdapterFactory = (context: AdapterContext) => ImAdapter;

export class ImConfigError extends Error {}
