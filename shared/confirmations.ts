/**
 * 确认卡片 + 审批偏好（DESIGN.md §58，docs/confirmations.md）。服务器（server/src/confirmations）和网页共用。
 *
 * 机器人做有后果的事之前（对外发消息、删除、付款购买、操作用户的电脑），按用户的审批偏好决定：
 * 「先问我」= 聊天里出一张确认卡片（要做什么 · 对象 · 细节 · 确认 / 取消），确认后这一轮接着做；
 * 「直接做」= 不问。用户还能用自己的话写规则（「给张三发微信不用问我」），机器人每轮都读得到。
 */
export const CONFIRM_CATEGORIES = ["message", "delete", "purchase", "device", "admin"] as const;
export type ConfirmCategory = (typeof CONFIRM_CATEGORIES)[number];
export type ConfirmMode = "ask" | "auto";

export const CONFIRM_CATEGORY_INFO: Record<
  ConfirmCategory,
  { label: string; description: string; locked?: boolean }
> = {
  message: {
    label: "对外发消息",
    description: "代你给别人发消息、邮件，或在群里、网站上发帖",
  },
  delete: {
    label: "删除",
    description: "删除文件、机器人、任务、面板等数据",
  },
  purchase: {
    label: "付款购买",
    description: "在网页上下单、付款、转账、订阅",
    locked: true,
  },
  device: {
    label: "操作你的电脑",
    description: "在你的电脑上运行命令、写文件、截图、操作鼠标键盘（只问设成「询问」的能力）",
  },
  admin: {
    label: "添加连接器",
    description: "把一个新的 MCP 服务器 / 外部服务接进这个部署（凭据会发往该地址）",
    locked: true,
  },
};

export type ConfirmDetail = { label: string; value: string; code?: boolean; /** value 是 unified diff，按增删行着色（设备改文件，§62） */ diff?: boolean };

export type ConfirmStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export type ConfirmRequestView = {
  id: string;
  agentId: string;
  threadId: string | null;
  toolCallId: string | null;
  category: ConfirmCategory;
  tool: string;
  title: string;
  target: string | null;
  details: ConfirmDetail[];
  status: ConfirmStatus;
  /** 在哪里决定的：网页卡片、电脑上的弹窗、或按偏好自动通过。 */
  decidedVia: "web" | "device" | "preference" | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
};

export type ConfirmPrefView = {
  category: ConfirmCategory;
  label: string;
  description: string;
  mode: ConfirmMode;
  locked: boolean;
  /** 用户（或机器人记下的）原话，例如「以后删东西不用问我」。 */
  note: string | null;
  updatedAt: string | null;
};

export type ConfirmRuleView = {
  id: string;
  text: string;
  category: ConfirmCategory;
  mode: ConfirmMode;
  keywords: string[];
  source: "user" | "bot";
  agentId: string | null;
  createdAt: string;
};

export const CONFIRM_MODE_LABEL: Record<ConfirmMode, string> = { ask: "先问我", auto: "直接做" };

/** 后来才确认（工具已经不在等了）时，服务器发进对话、叫机器人接着做的那条消息的开头。 */
export const CONFIRM_RESUME_MARKER = "⟦chisabot:confirm:";
