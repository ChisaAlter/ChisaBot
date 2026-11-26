/**
 * 动作后页面短提示 / Toast / Dialog 中的限额与频率撞墙识别（纯逻辑，不依赖 Playwright）。
 *
 * 与 `site-block.ts` / `challenge.ts` 互补：不拍全树 ariaSnapshot diff、不拖慢动作，
 * 仅在动作前后对比可见短提示集合，捕捉新冒出来的「次数已用完 / 操作过于频繁 / rate limit」提示。
 */

export const LIMIT_NOTICE_MAX_LENGTH = 120;

export const LIMIT_NOTICE_SELECTOR = [
  '[role="alert"]',
  '[role="status"]',
  '[role="dialog"]',
  "[aria-live]",
  '[class*="toast" i]',
  '[class*="notice" i]',
  '[class*="alert" i]',
  '[class*="message" i]',
  '[class*="snackbar" i]',
  '[class*="tip" i]',
  '[class*="popup" i]',
  '[class*="modal" i]',
  '[class*="msg" i]',
  '[class*="error" i]',
  '[class*="limit" i]',
].join(", ");

const LIMIT_NOTICE_PATTERNS: readonly RegExp[] = [
  /(?:次数|额度|配额|机会)?已用完/,
  /已达(?:到)?(?:每日|今日|本日|最大|最高)?上限/,
  /超过(?:每日|今日|本日)?(?:次数|频率|最大)?上限/,
  /(?:操作|请求|访问|发送|提交|点击)(?:过于|太)?频繁/,
  /过于频繁/,
  /请稍后(?:再试|重试)/,
  /稍后再试/,
  /明天再来|明日再来|明天再试|明日再试/,
  /(?:今日|今天|本日)(?:次数|额度)?已(?:满|上限|达上限)/,
  /(?:额度|次数|配额)不足/,
  /触发限流|已被限流|系统限流/,
  /\bdaily\s+limit\b/i,
  /\brate[\s-]+limit(?:ed|ing)?\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\bquota\s+exceeded\b/i,
  /\blimit\s+(?:exceeded|reached)\b/i,
  /\btry\s+again\s+(?:later|tomorrow)\b/i,
];

/** 折叠连续空白，保留单空格用于展示与正则匹配。 */
export function normalizeNoticeText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** 仅允许去空白后 1..120 字的短提示，避免把长正文误判成 toast。 */
export function isShortNotice(raw: string): boolean {
  const compactLength = raw.replace(/\s+/g, "").length;
  return compactLength > 0 && compactLength <= LIMIT_NOTICE_MAX_LENGTH;
}

/** 判断一条短提示文本是否命中限额 / 频率限制文案。 */
export function matchesLimitNotice(raw: string): boolean {
  if (!isShortNotice(raw)) return false;
  const text = normalizeNoticeText(raw);
  return LIMIT_NOTICE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 从动作前后的短提示集合中找出「新出现」的触顶/限流提示。
 * 若内外层节点同时命中，优先返回更短更精准的那一条。
 */
export function diffNewLimitNotice(
  before: readonly string[],
  after: readonly string[],
): string | undefined {
  const seen = new Set(before.map(normalizeNoticeText).filter(Boolean));
  let best: string | undefined;
  for (const item of after) {
    const normalized = normalizeNoticeText(item);
    if (!normalized || seen.has(normalized)) continue;
    if (!matchesLimitNotice(normalized)) continue;
    if (!best || normalized.length < best.length) {
      best = normalized;
    }
  }
  return best;
}

export type ActionNoticeSnapshot = {
  title: string;
  notices: string[];
};

/**
 * 注入页面执行的轻量采集函数（传递给 `page.evaluate`，禁止引用外部作用域）。
 * 显式排除输入框、可编辑节点及敏感标记字段，绝不采集密码/验证码等用户输入内容。
 */
export function collectVisibleNoticeSnapshot(options: {
  selector: string;
  maxLength: number;
}): ActionNoticeSnapshot {
  const excludedSelector =
    "input, textarea, select, [contenteditable], [data-chisabot-secret], script, style, noscript";
  const nodes = Array.from(document.querySelectorAll(options.selector)).slice(
    0,
    120,
  );
  const notices: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (notices.length >= 40) break;
    if (node.matches(excludedSelector)) continue;
    if (node.querySelector(excludedSelector)) continue;
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const compactLength = text.replace(/\s+/g, "").length;
    if (compactLength === 0 || compactLength > options.maxLength) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    notices.push(text);
  }
  return {
    title: document.title ?? "",
    notices,
  };
}
