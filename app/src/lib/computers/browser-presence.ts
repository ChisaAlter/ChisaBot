/**
 * 计算机面板上「谁在用浏览器」那句短状态（DOG-05）。
 *
 * 以前只要控制权在机器人手里就写「机器人在用浏览器」，空闲、截图挂了、活动为空时也一样——看着像
 * 还在干活。这里按真实活动 + 屏幕是否可读拆开，底栏 / 大屏脚共用同一套文案。
 */

export type BrowserPresenceKind =
  | "checking"
  | "transitioning"
  | "driving"
  | "bot-busy"
  | "idle"
  | "unavailable";

export type BrowserPresenceInput = {
  /** 当前控制权；还没查到时为 null。 */
  control: { holder: "bot" | "human"; transitioning?: boolean } | null;
  /** 这一轮计算机状态行还在（pending / 聊天未结束 / linger 内）。 */
  botActive: boolean;
  /** 截图轮询失败、画面已清空：不能再假装「还在看」那张旧图。 */
  screenUnavailable?: boolean;
};

export function browserPresenceKind(input: BrowserPresenceInput): BrowserPresenceKind {
  if (!input.control) return "checking";
  if (input.control.transitioning) return "transitioning";
  if (input.control.holder === "human") return "driving";
  if (input.screenUnavailable) return "unavailable";
  if (input.botActive) return "bot-busy";
  return "idle";
}

/** 右栏小卡片底栏。 */
export function browserPresenceCardLabel(kind: BrowserPresenceKind): string {
  switch (kind) {
    case "checking":
      return "正在检查谁有控制权…";
    case "transitioning":
      return "正在完成当前操作…";
    case "driving":
      return "你在控制浏览器，打开大屏点击和输入，用完点「交还」。";
    case "bot-busy":
      return "机器人在用浏览器，你可以随时接管。";
    case "unavailable":
      return "暂时看不到屏幕，稍后会自动重试；你仍可接管。";
    case "idle":
      return "浏览器空闲，你可以随时接管。";
  }
}

/** 放大接管底栏（更短）。 */
export function browserPresenceFootLabel(kind: BrowserPresenceKind): string {
  switch (kind) {
    case "checking":
      return "正在检查谁有控制权…";
    case "transitioning":
      return "正在完成当前操作，马上交给你…";
    case "driving":
      return "你正在控制浏览器";
    case "bot-busy":
      return "机器人在用浏览器，接管后可以点击和输入";
    case "unavailable":
      return "暂时看不到屏幕";
    case "idle":
      return "浏览器空闲，接管后可以点击和输入";
  }
}
