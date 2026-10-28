/**
 * 计算机活动记录的中文文案（CB-101）。服务端只存动作种类、状态、原因代码；给人看的话都在这里。
 *
 * 拒绝原因不显示给模型的原文（那是写给模型的「没有执行：这台计算机现在由用户接管着…」），
 * 而是按原因代码写给人看的状态。
 */
export type ActivityStepLike = {
  actorKind: "agent" | "human";
  kind: string;
  status: string;
  refusalReason?: string | null;
  subject: string;
  detail?: Record<string, unknown>;
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const TAB_ACTIONS: Record<string, string> = {
  new: "新开了标签页",
  open: "新开了标签页",
  close: "关闭了标签页",
  switch: "切换了标签页",
  select: "切换了标签页",
  activate: "切换了标签页",
  back: "后退",
  forward: "前进",
  reload: "刷新了页面",
};

/** 一步的动词短语：「打开了 example.com」「运行了命令」。进行中用「正在…」。 */
export function stepVerb(step: ActivityStepLike): string {
  const running = step.status === "running";
  const human = step.actorKind === "human";
  const detail = step.detail ?? {};
  const count =
    typeof detail.count === "number" && detail.count > 1 ? detail.count : 0;
  const done = (past: string, present: string) =>
    running ? `正在${present}` : past;
  switch (step.kind) {
    case "navigate":
      return done("打开了", "打开");
    case "click":
      return done(count ? `点击了 ${count} 次` : "点击了", "点击");
    case "type":
      if (human || detail.humanText === true)
        return done("输入了文字", "输入文字");
      return done("输入了", "输入");
    case "key":
      return done(count ? `按了 ${count} 次键` : "按了", "按");
    case "scroll":
      return done(count ? `滚动了 ${count} 次` : "滚动了页面", "滚动页面");
    case "screenshot":
      return done("截了一张图", "截图");
    case "snapshot":
      return done("读取了页面结构", "读取页面结构");
    case "read":
      return done("读取了页面内容", "读取页面内容");
    case "tabs":
      return running
        ? "正在操作标签页"
        : (TAB_ACTIONS[String(detail.action ?? "")] ?? "操作了标签页");
    case "run_command":
      return done("运行了命令", "运行命令");
    case "read_file":
      return done("读取了文件", "读取文件");
    case "write_file":
      return done(
        detail.append === true ? "追加写入了文件" : "保存了文件",
        "保存文件",
      );
    case "list_files":
      return done("列出了文件夹", "列出文件夹");
    case "download_file":
      return done("下载了文件", "下载文件");
    case "secret":
      return done("请你填写了一项私密信息", "等你填写私密信息");
    case "help":
      if (human || step.subject === "我来接管浏览器。")
        return done("接管了浏览器", "接管浏览器");
      return done("请你帮忙", "等你帮忙");
    default:
      return done("执行了操作", "执行操作");
  }
}

/** 动作的对象：网址只显示站点 + 路径，命令原样，文件给路径。 */
export function stepObject(step: ActivityStepLike): string {
  const detail = step.detail ?? {};
  switch (step.kind) {
    case "navigate":
    case "read":
      return step.subject ? shortUrl(step.subject) : "";
    case "click": {
      const element = detail.element as { name?: string } | undefined;
      return element?.name || step.subject || "";
    }
    case "type":
      if (step.actorKind === "human" || detail.humanText === true) return "";
      return step.subject ? `「${step.subject}」` : "";
    case "help":
      if (step.actorKind === "human" || step.subject === "我来接管浏览器。")
        return "";
      return step.subject;
    case "list_files":
      return step.subject || "工作区";
    default:
      return step.subject;
  }
}

const NOISY_QUERY_PARAM =
  /^(__cf_chl_|cf_chl_|utm_|_ga$|_gl$|fbclid$|gclid$|msclkid$|spm$|vd_source$)/i;

export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    const kept = new URLSearchParams();
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!NOISY_QUERY_PARAM.test(key)) kept.append(key, value);
    }
    const queryStr = kept.toString();
    const search = queryStr
      ? `?${queryStr.length > 32 ? `${queryStr.slice(0, 32)}…` : queryStr}`
      : "";
    let shown = `${parsed.host}${path}${search}`;
    try {
      // 打码的 •••• 被 URL 编码成 %E2%80%A2…，给人看时还原。
      shown = decodeURI(shown);
    } catch {
      // 编码坏了就原样显示。
    }
    return shown;
  } catch {
    return url;
  }
}

/**
 * 清理轮次提示词：把后台面板刷新、中途插话包装等内部提示语转成简短的人话标题。
 */
export function formatTurnPrompt(
  raw: string | null | undefined,
): { title: string; isSystem: boolean } | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("【后台刷新面板")) {
    const match = /面板「([^」]+)」/.exec(trimmed);
    return {
      title: match?.[1] ? `刷新面板「${match[1]}」` : "后台刷新面板",
      isSystem: true,
    };
  }
  const stripped = trimmed
    .replace(/^（你在处理上一条消息的过程中，[^）]+）\s*\n*/, "")
    .trim();
  const firstLine =
    stripped
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? stripped;
  return { title: firstLine, isSystem: false };
}

/** 被拒绝的一步写给人看的状态。 */
export function refusalText(reason: string | null | undefined): string {
  switch (reason) {
    case "user_in_control":
      return "已拒绝：电脑当前由你控制";
    case "awaiting_approval":
      return "等你批准";
    case "approval_denied":
      return "已拒绝：你没有批准";
    case "policy_denied":
      return "已拒绝：不在权限规则允许范围内";
    case "site_blocked":
      return "已拒绝：这个网站不允许访问";
    case "workspace_refused":
      return "已拒绝：不能访问工作区以外的位置";
    default:
      return "已拒绝";
  }
}

/** 状态徽标的文字。成功时不显示（只显示耗时）。 */
export function statusText(step: ActivityStepLike): string {
  const exitCode = step.detail?.exitCode;
  switch (step.status) {
    case "running":
      return "进行中";
    case "refused":
      return refusalText(step.refusalReason);
    case "timeout":
      return "超时";
    case "cancelled":
      return "已取消";
    case "failed":
      if (step.refusalReason === "live_cast") return "失败：大屏正在直播";
      return typeof exitCode === "number"
        ? `失败 · 退出码 ${exitCode}`
        : "失败";
    default:
      return "";
  }
}

/** 只读的探查命令：连续几条这样的命令合成「运行了 N 条命令」。 */
const PROBE =
  /^\s*(ls|ll|pwd|cat|head|tail|wc|which|whoami|date|uname|echo|env|printenv|id|hostname|df|du|free|ps|file|stat|find|rg|grep|tree|type|command -v|[\w.-]+ (--version|-v|-V|version))\b/;

export function isProbeCommand(command: string): boolean {
  if (
    !command ||
    /[>|]\s*(tee|sh|bash)\b|>\s*\S|\brm\b|\bmv\b|\bcp\b|\bsudo\b/.test(command)
  )
    return false;
  return PROBE.test(command);
}

/** 合并的最少条数。 */
export const BATCH_MIN = 3;
