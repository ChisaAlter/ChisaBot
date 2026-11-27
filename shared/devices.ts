/**
 * ChisaBot 设备（PC 节点与浏览器伴侣扩展）的共享类型与能力表。服务器、网页、PC 客户端与扩展读同一份定义。
 * 设计见 docs/pc-node.md。
 */
import type {
  CompanionServerCommand,
  CompanionSettingsPatch,
  CompanionStateReport,
} from "./browser-companion";

/** 可单独开关的能力。system_info（只读基本信息）不算能力，始终可用并照常审计。 */
export const DEVICE_CAPABILITIES = [
  "shell",
  "files_read",
  "files_write",
  "screenshot",
  "input",
  "open",
  "clipboard",
] as const;

export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

/** off：关闭；ask：每次在 PC 或网页上审批；allow：直接执行（仍审计）。 */
export type CapabilityPolicy = "off" | "ask" | "allow";

export type DeviceCapabilities = Record<DeviceCapability, CapabilityPolicy>;

export const CAPABILITY_INFO: Record<
  DeviceCapability,
  { label: string; description: string; dangerous: boolean }
> = {
  shell: {
    label: "命令行",
    description:
      "在这台设备上运行命令（Windows 上是 PowerShell，Linux / macOS 上是 sh / bash；有超时和输出上限）。也用于 git 提交 / 拉取、后台命令和进程管理。",
    dangerous: true,
  },
  files_read: {
    label: "读取文件",
    description:
      "列出、搜索和读取「允许的文件夹」里的文件，以及 git status / diff / log 这类只读操作。",
    dangerous: false,
  },
  files_write: {
    label: "写入文件",
    description:
      "在「允许的文件夹」里新建或修改文件（精确替换、补丁、整文件写入），改前自动备份，审批时能看到改动。",
    dangerous: true,
  },
  screenshot: {
    label: "截图",
    description: "截取屏幕画面发给机器人。",
    dangerous: false,
  },
  input: {
    label: "鼠标键盘",
    description: "移动鼠标、点击、输入文字和按键。",
    dangerous: true,
  },
  open: {
    label: "打开网址 / 文件",
    description:
      "用默认浏览器打开 http/https 网址，或用默认程序打开允许的文件夹里的文件 / 文件夹。不启动程序、不带参数、不打开可执行文件和脚本。",
    dangerous: true,
  },
  clipboard: {
    label: "剪贴板",
    description: "读取或写入剪贴板文字。",
    dangerous: false,
  },
};

export function defaultCapabilities(): DeviceCapabilities {
  return Object.fromEntries(
    DEVICE_CAPABILITIES.map((capability) => [capability, "off"]),
  ) as DeviceCapabilities;
}

/**
 * 新登记电脑的初始权限（2026-10-14 起）：全部「询问」——机器人一开口就能用，每次操作在 PC 弹窗或网页上批准，
 * 高风险操作还要 PC 本机确认。以前默认全部「关闭」，用户不进 设置 → 设备 → 权限 就什么都做不了，
 * 机器人也只会说「请去打开能力」（用户报告「桌面端还是不能操作本地」）。「关闭」仍可随时设置。
 * normalizeCapabilities 缺字段时仍按「关闭」补，安全兜底不变。
 */
export function initialCapabilities(): DeviceCapabilities {
  return Object.fromEntries(
    DEVICE_CAPABILITIES.map((capability) => [capability, "ask"]),
  ) as DeviceCapabilities;
}

/** 能力是不是还停在旧版出厂值（全部关闭）。 */
export function isFactoryOff(capabilities: DeviceCapabilities): boolean {
  return DEVICE_CAPABILITIES.every(
    (capability) => capabilities[capability] === "off",
  );
}

export function normalizeCapabilities(value: unknown): DeviceCapabilities {
  const result = defaultCapabilities();
  if (!value || typeof value !== "object") return result;
  for (const capability of DEVICE_CAPABILITIES) {
    const policy = (value as Record<string, unknown>)[capability];
    if (policy === "off" || policy === "ask" || policy === "allow")
      result[capability] = policy;
  }
  return result;
}

export type PairingUriOptions = {
  alternates?: string[];
  e2eePub?: string;
};

/**
 * 手机扫码绑定（DESIGN.md §33）：二维码内容 `chisabot://pair?server=<https 源>&code=<一次性绑定码>`。
 * Android 端 Pairing.kt 解析同一格式；存在备选地址或公钥时附加 `&alt=` / `&pk=`。
 */
export function pairingUri(
  server: string,
  code: string,
  options?: PairingUriOptions,
): string {
  let base = `chisabot://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
  if (!options) return base;

  const seen = new Set<string>([server]);
  const alts: string[] = [];
  for (const raw of options.alternates ?? []) {
    const clean = raw.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    alts.push(clean);
  }
  if (alts.length > 0) {
    base += `&alt=${encodeURIComponent(alts.join(","))}`;
  }

  const pk = options.e2eePub?.trim();
  if (pk) {
    base += `&pk=${encodeURIComponent(pk)}`;
  }
  return base;
}

/** 手机设备只用来登录聊天，不是机器人可操作的节点（不进设备工具、不接 /agent/ws）。 */
export const MOBILE_PLATFORMS: readonly string[] = ["android", "ios"];
export function isMobilePlatform(platform: string | null | undefined): boolean {
  return !!platform && MOBILE_PLATFORMS.includes(platform);
}
/** 手机最近一次会话校验在这个时间内 = 显示「在线」（网关约每 30 秒校验一次）。 */
export const MOBILE_ONLINE_WINDOW_MS = 3 * 60_000;

/** 浏览器伴侣扩展（Chrome / Edge MV3）的设备平台标识。 */
export const BROWSER_EXTENSION_PLATFORM = "browser_extension" as const;
export function isBrowserExtensionPlatform(
  platform: string | null | undefined,
): boolean {
  return platform === BROWSER_EXTENSION_PLATFORM;
}

/** 每个设备操作需要的能力；system_info / activity / browser_control 为 null（始终可用，仍受急停与审计约束）。 */
export const OPERATION_CAPABILITY: Record<
  DeviceOperation,
  DeviceCapability | null
> = {
  system_info: null,
  shell: "shell",
  list_files: "files_read",
  read_file: "files_read",
  write_file: "files_write",
  screenshot: "screenshot",
  input: "input",
  open: "open",
  clipboard_read: "clipboard",
  clipboard_write: "clipboard",
  // 编码 / 完全访问（docs/pc-node.md §12、§13）：读 = 读取文件，改 = 写入文件，git 写 / 命令 / 进程 = 命令行。
  search: "files_read",
  read_range: "files_read",
  edit_file: "files_write",
  apply_patch: "files_write",
  git: "shell",
  shell_session: "shell",
  exec_start: "shell",
  exec_poll: "shell",
  exec_kill: "shell",
  exec_list: "shell",
  process_list: "shell",
  process_kill: "shell",
  file_upload: "files_write",
  file_download: "files_read",
  activity: null,
  mcp_call: "shell",
  mcp_discover: "files_read",
  desktop_windows: "screenshot",
  desktop_snapshot: "screenshot",
  desktop_act: "input",
  window_screenshot: "screenshot",
  // 浏览器伴侣扩展（shared/browser-companion.ts）：读/快照/滚屏/悬停/截图/列标签 = screenshot，导航 = open，点击/填表/按键 = input，会话控制 = null。
  browser_tabs: "screenshot",
  browser_snapshot: "screenshot",
  browser_read: "screenshot",
  browser_navigate: "open",
  browser_click: "input",
  browser_hover: "screenshot",
  browser_type: "input",
  browser_key: "input",
  browser_scroll: "screenshot",
  browser_screenshot: "screenshot",
  browser_control: null,
};

/** git 只读子命令（status / diff / log / show / 列分支…）只要「读取文件」能力；其余要「命令行」。 */
export const GIT_READ_SUBCOMMANDS = [
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "remote",
  "blame",
  "ls-files",
  "stash-list",
] as const;
export const GIT_SUBCOMMANDS = [
  ...GIT_READ_SUBCOMMANDS,
  "add",
  "commit",
  "checkout",
  "switch",
  "restore",
  "reset",
  "pull",
  "push",
  "fetch",
  "clone",
  "init",
  "stash",
  "merge",
  "rebase",
  "tag",
  "rm",
  "mv",
  "apply",
  "cherry-pick",
  "config",
] as const;

export function gitIsRead(
  subcommand: string,
  args: readonly string[] = [],
): boolean {
  if (!(GIT_READ_SUBCOMMANDS as readonly string[]).includes(subcommand))
    return false;
  if (subcommand === "branch")
    return args.every(
      (a) =>
        /^-(a|r|v|vv|l|-list|-all|-remotes|-show-current|-contains|-merged|-no-merged)$/.test(
          a,
        ) || a.startsWith("--format"),
    );
  if (subcommand === "remote")
    return args.length === 0 || (args.length === 1 && args[0] === "-v");
  return true;
}

/** 某次调用需要的能力（PC 端 core.js 的 capabilityFor 同一规则）。 */
export function capabilityFor(
  operation: DeviceOperation,
  args: Record<string, unknown> = {},
): DeviceCapability | null {
  if (operation === "git")
    return gitIsRead(
      String(args.subcommand ?? ""),
      Array.isArray(args.args) ? args.args.map(String) : [],
    )
      ? "files_read"
      : "shell";
  return OPERATION_CAPABILITY[operation];
}

/** 完全访问的时长选项。permanent = 一直开着，直到手动关闭或紧急停止。 */
export const FULL_ACCESS_DURATIONS = {
  "1h": 3600_000,
  "24h": 24 * 3600_000,
  permanent: null,
} as const;
export type FullAccessDuration = keyof typeof FULL_ACCESS_DURATIONS;
/** 「永久」在库里存成这个时间。 */
export const FULL_ACCESS_FOREVER = "9999-12-31T00:00:00.000Z";

export type DeviceOperation =
  | "system_info"
  | "shell"
  | "list_files"
  | "read_file"
  | "write_file"
  | "screenshot"
  | "input"
  | "open"
  | "clipboard_read"
  | "clipboard_write"
  | "search"
  | "read_range"
  | "edit_file"
  | "apply_patch"
  | "git"
  | "shell_session"
  | "exec_start"
  | "exec_poll"
  | "exec_kill"
  | "exec_list"
  | "process_list"
  | "process_kill"
  | "file_upload"
  | "file_download"
  | "activity"
  | "mcp_call"
  | "mcp_discover"
  | "desktop_windows"
  | "desktop_snapshot"
  | "desktop_act"
  | "window_screenshot"
  | "browser_tabs"
  | "browser_snapshot"
  | "browser_read"
  | "browser_navigate"
  | "browser_click"
  | "browser_hover"
  | "browser_type"
  | "browser_key"
  | "browser_scroll"
  | "browser_screenshot"
  | "browser_control";

export const OPERATION_LABEL: Record<DeviceOperation, string> = {
  system_info: "读取系统信息",
  shell: "运行命令",
  list_files: "列出文件",
  read_file: "读取文件",
  write_file: "写入文件",
  screenshot: "截图",
  input: "鼠标键盘",
  open: "打开网址 / 文件",
  clipboard_read: "读取剪贴板",
  clipboard_write: "写入剪贴板",
  search: "搜索文件",
  read_range: "读取文件",
  edit_file: "修改文件",
  apply_patch: "应用补丁",
  git: "git",
  shell_session: "命令行会话",
  exec_start: "后台命令",
  exec_poll: "查看命令输出",
  exec_kill: "结束命令",
  exec_list: "列出后台命令",
  process_list: "查看进程",
  process_kill: "结束进程",
  file_upload: "传文件到设备",
  file_download: "从设备取文件",
  activity: "查看运行中的命令",
  mcp_call: "调用本地 MCP",
  mcp_discover: "发现本地 MCP 配置",
  desktop_windows: "列出桌面窗口",
  desktop_snapshot: "读取桌面控件树",
  desktop_act: "后台操控桌面控件",
  window_screenshot: "后台截取窗口",
  browser_tabs: "管理浏览器标签页",
  browser_snapshot: "读取网页控件树",
  browser_read: "读取网页正文",
  browser_navigate: "打开网页",
  browser_click: "点击网页元素",
  browser_hover: "悬停网页元素",
  browser_type: "填写网页表单",
  browser_key: "网页按键",
  browser_scroll: "滚动网页",
  browser_screenshot: "截取网页画面",
  browser_control: "控制浏览器接管会话",
};

/** 网页 / PC 看到的设备。不含令牌。 */
export type DeviceView = {
  id: string;
  ownerUserId: string;
  name: string;
  platform: string;
  osVersion: string | null;
  hostname: string | null;
  arch: string | null;
  clientVersion: string | null;
  capabilities: DeviceCapabilities;
  allowedRoots: string[];
  /** 紧急停止：为 true 时拒绝一切远程操作。 */
  paused: boolean;
  revoked: boolean;
  online: boolean;
  lastSeenAt: string | null;
  lastIp: string | null;
  createdAt: string;
  /**
   * 旧版「按机器人授权」留下的列表，已不再起作用：从 2026-10 起设备属于账号，用户的每个机器人都能使用
   * 在线设备（仍受能力开关、允许的文件夹、审批、紧急停止限制）。保留字段只为兼容旧客户端。
   */
  botIds: string[];
  /** 最近一次由机器人发起的操作（来自设备审计记录）；从未被机器人用过为 null。 */
  lastUsedBy: {
    botId: string | null;
    botName: string | null;
    at: string;
  } | null;
  /**
   * 完全访问（docs/pc-node.md §13）：只能由用户在 设置 → 设备 → 权限 打开，机器人没有工具能打开。
   * 开着时所有能力按「允许」、不限文件夹、命令不限 10 分钟、可以用管理员身份运行；仍全部审计，紧急停止立即关闭它。
   * fullAccessUntil = 到期时间（永久 = FULL_ACCESS_FOREVER），没开为 null。
   */
  fullAccess?: boolean;
  fullAccessUntil?: string | null;
  /** 按服务器时钟算的剩余毫秒数（下发配置那一刻），PC 用它倒数，不依赖 PC 时钟。 */
  fullAccessRemainingMs?: number | null;
  /** 在线时：这个客户端支持哪些操作（hello.features）。旧客户端没有。 */
  features?: string[] | null;
  /** 已签发的桌面桥接 / 无障碍 scopes（如 accessibility_control），同步给 PC 端。 */
  grantedScopes?: string[];
  /** 浏览器伴侣扩展实时会话状态（仅 platform === "browser_extension" 在线时提供）。 */
  companionState?: CompanionStateReport | null;
};

export type DeviceAuditEntry = {
  id: string;
  deviceId: string;
  at: string;
  actorType: "bot" | "user" | "device" | "system";
  actorId: string | null;
  actorName: string | null;
  action: string;
  summary: string | null;
  outcome: string;
  detail: string | null;
  durationMs: number | null;
};

export type DeviceApprovalView = {
  id: string;
  deviceId: string;
  deviceName: string;
  botId: string;
  botName: string | null;
  operation: DeviceOperation;
  summary: string;
  /** 改文件类操作的改动（unified diff），审批卡片里显示。 */
  diff?: string | null;
  createdAt: string;
  expiresAt: string;
};

/** WebSocket 协议（PC → 服务器）。 */
export type DeviceToServer =
  | {
      type: "hello";
      clientVersion?: string;
      platform?: string;
      osVersion?: string;
      hostname?: string;
      arch?: string;
      /**
       * PC 0.1.7 起：建议的默认「允许的文件夹」（桌面、文档、下载）。服务器只在这台电脑的文件夹列表为空、
       * 而且从没被人改过配置时采用，之后以用户设置为准。
       */
      suggestedRoots?: string[];
      /** 0.1.8 起：客户端支持的操作名单。 */
      features?: string[];
    }
  | {
      type: "result";
      id: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | { type: "approval"; id: string; decision: "approve" | "deny" }
  | {
      type: "set_config";
      name?: string;
      capabilities?: Partial<DeviceCapabilities>;
      allowedRoots?: string[];
      paused?: boolean;
      /** PC 本机只能关闭完全访问（拒绝 / 托盘关闭），不能打开。 */
      fullAccess?: "off";
    }
  | { type: "local_audit"; action: string; outcome: string; summary?: string }
  | ({ type: "companion_state" } & CompanionStateReport)
  | { type: "pong" };

/** WebSocket 协议（服务器 → PC / 浏览器扩展）。 */
export type ServerToDevice =
  | { type: "welcome"; device: DeviceView; serverTime: string }
  | { type: "config"; device: DeviceView }
  | {
      type: "approval_request";
      id: string;
      operation: DeviceOperation;
      summary: string;
      botName: string | null;
      expiresAt: string;
      diff?: string | null;
      /** 按服务器时钟算的剩余毫秒数（PC 时钟可能不准，倒数用它）。 */
      remainingMs?: number;
    }
  | {
      type: "approval_closed";
      id: string;
      decision: "approve" | "deny" | "expired";
    }
  | {
      type: "call";
      id: string;
      operation: DeviceOperation;
      args: Record<string, unknown>;
      botName: string | null;
      timeoutMs: number;
    }
  | { type: "cancel"; id: string }
  | { type: "revoked" }
  | { type: "ping" }
  | {
      type: "check_update";
      /** 服务端已知的最新 PC 客户端版本号（仅作去重/日志参考；客户端始终以自身更新源 + Ed25519 验签为准）。 */
      version?: string;
      /** 触发原因（release_watch / hello_behind / admin_push）。 */
      reason?: string;
    }
  | { type: "direction_epoch_advance"; conversationId: string }
  | ({ type: "companion_state" } & CompanionStateReport)
  | {
      type: "companion_command";
      command: CompanionServerCommand;
      tabId?: number | null;
      reason?: string;
      config?: CompanionSettingsPatch;
    };

/** 打开就等于运行的文件类型（CB-030）。和 pc/src/agent/open-target.js 的 EXECUTABLE_EXT 一致。 */
export const OPEN_EXECUTABLE_EXT: ReadonlySet<string> = new Set(
  (
    "exe com bat cmd ps1 psm1 psd1 ps1xml vbs vbe js jse wsf wsh wsc msi msp mst scr pif lnk cpl hta jar reg inf " +
    "application appref-ms gadget msc url scf iqy settingcontent-ms library-ms search-ms appx appxbundle msix msixbundle " +
    "sh bash zsh fish csh ksh command tool app desktop run bin appimage py pyw pyc pl rb php deb rpm dmg pkg mpkg action workflow"
  ).split(" "),
);

/**
 * 「打开」只做安全的打开（CB-030，docs/pc-node.md §5）：http/https 网址，或文件 / 文件夹的路径。
 * 不启动程序（光写程序名不行）、不打开可执行文件和脚本、不打开别的协议和网络路径。返回 null = 可以，否则是中文原因。
 * 服务器在发给设备之前先查一次；PC 客户端（open-target.js）用同一套规则再查一次，并要求文件在允许的文件夹里且存在。
 */
export function checkOpenTarget(raw: unknown): string | null {
  const target = typeof raw === "string" ? raw.trim() : "";
  if (!target) return "没有要打开的目标。";
  if (/[\u0000-\u001f\u007f]/.test(target))
    return "目标里有控制字符，不能打开。";
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      return url.protocol === "http:" || url.protocol === "https:"
        ? null
        : "只能打开 http / https 网址。";
    } catch {
      return "网址格式不对。";
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target))
    return "不允许打开这种地址：只能打开 http / https 网址或文件 / 文件夹。";
  if (/^(\\\\|\/\/)/.test(target))
    return "不打开网络路径（\\\\服务器\\共享）。";
  if (target.startsWith("-")) return "目标不能以 - 开头。";
  const base =
    target
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const looksLikePath =
    /^([a-z]:[\\/]|[\\/]|~)/i.test(target) ||
    /[\\/]/.test(target) ||
    /\.[^.\\/]+$/.test(base) ||
    target === "." ||
    target === "~";
  if (!looksLikePath)
    return "「打开」不再启动程序：只能打开网址，或允许的文件夹里的文件 / 文件夹（给出路径）。要运行程序请用命令行能力。";
  const ext = /\.([^.\\/]+)$/
    .exec(base.replace(/[. ]+$/, ""))?.[1]
    ?.toLowerCase();
  if (ext && OPEN_EXECUTABLE_EXT.has(ext))
    return `不打开 .${ext} 文件：打开它等于运行程序。要运行请用命令行能力。`;
  // 没有扩展名的只当文件夹，并且要以 / 或 \ 结尾：Windows 打开「C:\…\calc」这类没扩展名的路径时会按 PATHEXT 补成 calc.exe 去运行（旧版 PC 客户端）。
  if (!ext && !/[\\/]$/.test(target) && target !== "." && target !== "~")
    return "没有扩展名的路径只当文件夹打开，请以 / 或 \\ 结尾（例如 D:\\报告\\）；文件请写全文件名和扩展名。";
  return null;
}

/** 后台无感操控允许的语义动作集合（刻意不含 focus，防止抢占前景焦点）。 */
export const DESKTOP_BG_ACTIONS = [
  "click",
  "set_value",
  "clear",
  "toggle",
  "check",
  "uncheck",
  "select",
  "expand",
  "collapse",
  "scroll",
  "scroll_to",
  "type",
] as const;

export type DesktopBgAction = (typeof DESKTOP_BG_ACTIONS)[number];

/** 后台无感操控的结构化错误码（服务端与 PC 端统一使用，禁止隐式前台降级）。 */
export const DESKTOP_BG_ERROR_CODES = [
  "POLICY_DENIED",
  "ACTION_NOT_SUPPORTED",
  "STALE_REF",
  "AMBIGUOUS_TARGET",
  "WINDOW_MINIMIZED",
  "WINDOW_NOT_FOUND",
  "SELF_TARGET_FORBIDDEN",
  "NEEDS_PERMISSION",
  "DRIVER_UNAVAILABLE",
  "TIMEOUT",
] as const;

export type DesktopBgErrorCode = (typeof DESKTOP_BG_ERROR_CODES)[number];

/** 禁止被后台操控的 ChisaBot 自身进程名 / Bundle ID 黑名单（防自审批自提权）。 */
export const DESKTOP_SELF_PROCESS_NAMES = [
  "chisabot",
  "chisabot-pc",
  "cn.ayase.chisabot.pc",
] as const;

const DESKTOP_SELF_PROCESS_SET: ReadonlySet<string> = new Set(
  DESKTOP_SELF_PROCESS_NAMES,
);

const PROTECTED_SELF_TITLE_PATTERNS = [
  "chisabot 审批",
  "chisabot 确认",
] as const;

function normalizeDesktopProcessToken(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  let normalized = raw.trim().toLowerCase();
  if (!normalized) return "";
  const sepIdx = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (sepIdx >= 0) {
    normalized = normalized.slice(sepIdx + 1);
  }
  if (normalized.endsWith(".exe")) {
    normalized = normalized.slice(0, -4);
  }
  return normalized;
}

/**
 * 判断目标窗口 / 进程是否属于 ChisaBot 自身受保护对象（防自审批、自提权与自关闭）。
 */
export function isProtectedSelfTarget(target: {
  pid?: number | null;
  selfPid?: number | null;
  processName?: string | null;
  bundleId?: string | null;
  title?: string | null;
}): boolean {
  if (!target || typeof target !== "object") return false;
  if (
    typeof target.pid === "number" &&
    typeof target.selfPid === "number" &&
    Number.isInteger(target.pid) &&
    Number.isInteger(target.selfPid) &&
    target.pid > 0 &&
    target.selfPid > 0 &&
    target.pid === target.selfPid
  ) {
    return true;
  }
  const proc = normalizeDesktopProcessToken(target.processName);
  if (proc && DESKTOP_SELF_PROCESS_SET.has(proc)) {
    return true;
  }
  const bundle = normalizeDesktopProcessToken(target.bundleId);
  if (bundle && DESKTOP_SELF_PROCESS_SET.has(bundle)) {
    return true;
  }
  if (typeof target.title === "string" && target.title.length > 0) {
    const lowerTitle = target.title.toLowerCase();
    for (const pattern of PROTECTED_SELF_TITLE_PATTERNS) {
      if (lowerTitle.includes(pattern)) return true;
    }
  }
  return false;
}

const DESKTOP_REF_PATTERN = /^@([1-9]\d*):(e[1-9]\d*)$/;

/**
 * 严格解析快照限定的控件引用 `@<正整数>:e<正整数>`（例如 `@12:e4`）。
 * 拒绝裸 `@e4`、负数、0、前导零、大小写偏差或任何多余字符。
 */
export function parseDesktopRef(
  ref: unknown,
): { snapshotId: number; elementKey: string } | null {
  if (typeof ref !== "string") return null;
  const match = DESKTOP_REF_PATTERN.exec(ref);
  if (!match) return null;
  const rawSnapshotId = match[1];
  const elementKey = match[2];
  if (!rawSnapshotId || !elementKey) return null;
  const snapshotId = Number(rawSnapshotId);
  const elementNum = Number(elementKey.slice(1));
  if (!Number.isSafeInteger(snapshotId) || !Number.isSafeInteger(elementNum)) {
    return null;
  }
  return { snapshotId, elementKey };
}
