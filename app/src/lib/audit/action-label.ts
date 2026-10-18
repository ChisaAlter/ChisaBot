/**
 * 活动记录（审计页）里电脑工具名与常见英文拒因的中文显示。
 *
 * 服务端仍写原始 tool 名（computer_navigate…）和 agent-computer 的英文拒因；模型提示也认英文
 * 「A person has control」。这里只改人读的「操作 / 结果」列，历史行一并变中文。
 * 文风对齐「接管电脑 / 交还电脑」与 stopped-turn 的步骤名。
 */

/** computer_* 去掉前缀后的动词 → 中文；也接受带前缀的完整名。 */
const COMPUTER_ACTION_LABELS: Record<string, string> = {
  navigate: "打开网页",
  read: "读取页面",
  snapshot: "查看页面",
  screenshot: "截图",
  click: "点击",
  type: "填写",
  key: "按键",
  scroll: "滚动",
  tabs: "标签页",
  bookmarks: "收藏夹",
  run_command: "运行命令",
  read_file: "读取文件",
  write_file: "写入文件",
  list_files: "列出文件",
  download_file: "下载文件",
  upload_file: "上传文件",
  wait: "等待",
  drag: "拖拽",
  hover: "悬停",
  select: "选择",
  fill: "填写",
  press: "按键",
};

/** 审计里常见的英文失败 / 阻拦句 → 中文（认不全就原样）。 */
const FAILURE_PHRASES: Array<{ test: RegExp; zh: string }> = [
  {
    test: /A person has control or has been asked to take control/i,
    zh: "有人正在用电脑，或已被请去接管。等交还后再操作。",
  },
  {
    test: /A person has control/i,
    zh: "有人正在用电脑，等交还后再操作。",
  },
  {
    test: /Take control before driving the computer yourself/i,
    zh: "请先接管电脑再操作。",
  },
  {
    test: /Take a fresh browser snapshot after handback before acting/i,
    zh: "交还后请先重新查看页面，再用新的元素操作。",
  },
  {
    test: /Take a fresh browser snapshot/i,
    zh: "请先重新查看页面，再用新的元素操作。",
  },
  {
    test: /Nothing is waiting for a secret/i,
    zh: "当前没有在等密钥。",
  },
  {
    test: /not in the current snapshot/i,
    zh: "不在当前页面快照里",
  },
];

/** payload.action（常为 computer_navigate）→ 中文操作名；不认得则剥前缀后原样。 */
export function computerActionLabel(action: string): string {
  const raw = action.trim();
  if (!raw) return raw;
  const stripped = raw.startsWith("computer_") ? raw.slice("computer_".length) : raw;
  return COMPUTER_ACTION_LABELS[stripped] ?? COMPUTER_ACTION_LABELS[raw] ?? stripped;
}

/** 结果列里的英文拒因 / 失败句 → 中文；不认得则原样（便于排查）。 */
export function auditFailureLabel(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  for (const { test, zh } of FAILURE_PHRASES) {
    if (test.test(trimmed)) return zh;
  }
  return trimmed;
}
