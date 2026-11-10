/**
 * 在线更新（docs/online-update.md）：服务器版本、网页刷新提示、管理后台 → 系统更新 共用的类型与纯函数。
 *
 * 浏览器、服务器、单元测试都 import 这一份；宿主机上的更新程序（deploy/updater/）写的 state.json
 * 由服务器读出后经 `projectSystemUpdateState` 投影成 `SystemUpdateOverview`，字段一律白名单。
 */

/** GET /api/version：正在运行的这一版。不需要登录信息以外的任何东西，也不含任何秘密。 */
export type BuildVersion = {
  /** 根 package.json 的 version。 */
  version: string;
  /** 构建来源提交（完整 40 位），开发环境里没有。 */
  commit?: string;
  /** 本次构建的唯一标识（镜像标签，例如 glass-20261012a）；网页拿它和自己打包时的值比较。 */
  buildId: string;
  builtAt?: string;
};

export const SYSTEM_UPDATE_ACTIONS = ["check", "update", "rollback", "magpie"] as const;

/**
 * 页面要求的宿主机更新程序版本（deploy/updater/chisabot-updater.py 的 VERSION，state.json 的 updaterVersion）。
 * 低于它就提示「更新程序是旧版本」和升级命令。两边一起改。
 */
export const SYSTEM_UPDATE_UPDATER_VERSION = 4;

/** 宿主机报告的配置问题（只给代号；文字在页面上，`SYSTEM_UPDATE_WARNING_TEXT`）。不阻止更新。 */
export const SYSTEM_UPDATE_WARNINGS = [
  "health_url_missing",
  "health_url_example",
  "compose_missing",
  "buildx_missing",
] as const;
export type SystemUpdateWarning = (typeof SYSTEM_UPDATE_WARNINGS)[number];

/** 老部署 / 没装更新程序时，在服务器上运行一次的命令（仓库检出在 `sourceDir`，不知道时按 README 的 /opt/chisabot-src）。 */
export function installUpdaterCommand(sourceDir?: string) {
  const dir = sourceDir && /^\/[A-Za-z0-9._/-]{1,200}$/u.test(sourceDir) ? sourceDir : "/opt/chisabot-src";
  return `cd ${dir} && git pull && sudo sh deploy/install-updater.sh`;
}
export type SystemUpdateAction = (typeof SYSTEM_UPDATE_ACTIONS)[number];

export type SystemUpdateCommit = {
  sha: string;
  subject: string;
  author?: string;
  date?: string;
};

export type SystemUpdateJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled_back";

/** 快速更新（只替换代码层）或完整构建（仓库 Dockerfile 从头构建：依赖 + 前端 + 镜像）。 */
export type SystemUpdateMode = "code" | "full";

export type SystemUpdateJob = {
  id: string;
  action: SystemUpdateAction;
  status: SystemUpdateJobStatus;
  mode?: SystemUpdateMode;
  durationSec?: number;
  /** 当前步骤的 key（见 UPDATE_STEPS / ROLLBACK_STEPS）。 */
  step?: string;
  startedAt?: string;
  finishedAt?: string;
  actor?: string;
  targetCommit?: string;
  fromImage?: string;
  toImage?: string;
  error?: string;
  /** 日志最后若干行（宿主机已去掉控制字符）。 */
  log: string[];
};

export type SystemUpdateHistoryEntry = {
  id: string;
  action: SystemUpdateAction;
  status: SystemUpdateJobStatus | "rejected";
  at: string;
  actor?: string;
  fromImage?: string;
  toImage?: string;
  commit?: string;
  error?: string;
  mode?: SystemUpdateMode;
  durationSec?: number;
};

/**
 * 自托管 Magpie 网关的更新状态（宿主机 `spool/state/magpie.json`，由 `deploy/updater/magpie.sh` 写）。
 *
 * 判断「有没有新版」比的是**镜像摘要**，不是版本号：Magpie 的镜像只有 `latest` 这类标签，
 * 版本号要问它自己的接口（那份在 `MagpieOverview.version` 里）。摘要一样就是没有新版，
 * 查不到远端摘要就什么都不说。
 */
export type MagpieGatewayUpdate = {
  /** 宿主机上有没有这个容器。没有时页面说「还没安装」，按钮是「安装最新版」。 */
  installed: boolean;
  /** 正在用的镜像引用（例如 `ghcr.io/yetone/magpie:latest`，钉摘要时就是摘要）。 */
  image?: string;
  container?: string;
  /** 本机这个标签指向的摘要。 */
  currentDigest?: string;
  /** registry 上这个标签现在的摘要。 */
  latestDigest?: string;
  /** 两个摘要都在、而且不一样。任一缺失时为 false（宁可说「不知道」）。 */
  updateAvailable: boolean;
  /** 宿主机上次检查的时间。 */
  checkedAt?: string;
  /** 查询失败的原因（网络或 registry 不可达）。 */
  error?: string;
  /**
   * 宿主机上的 magpie.sh 会「一键安装」（更新程序目录里有随版本发布的 compose 模板）。
   * 旧更新程序不写这个字段：页面据此提示先做一次系统更新，而不是给一个按了必然失败的按钮。
   */
  installable?: boolean;
  /** 这套 Magpie 是 ChisaBot 一键安装的（宿主机有标记），管理密钥由宿主机交给应用，不用手动配置。 */
  managed?: boolean;
  /**
   * 安装时镜像来源怎么核对的：attested = 校验过官方 CI 的签名构建证明；digest = 宿主机没有校验工具，
   * 只核对了官方仓库与摘要；off = 部署者关掉了校验。
   */
  verification?: MagpieVerification;
};

export type MagpieVerification = "attested" | "digest" | "off";

/** 一键安装的步骤（magpie.sh do_install 的 ::step::），页面按这个顺序画进度。 */
export const MAGPIE_INSTALL_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "prepare", label: "准备" },
  { key: "pull", label: "拉取官方镜像" },
  { key: "verify", label: "校验来源" },
  { key: "swap", label: "启动" },
  { key: "health", label: "健康检查" },
  { key: "connect", label: "接入 ChisaBot" },
];

export type SystemUpdateOverview = {
  /** 宿主机更新程序是否在线（state.json 最近 2 分钟内写过）。 */
  updaterOnline: boolean;
  /** 部署里根本没挂更新程序的目录。 */
  configured: boolean;
  /** 宿主机更新程序报告的版本（state.json 的 updaterVersion）；从没写过状态时没有。 */
  updaterVersion?: number;
  /** 更新程序比页面要求的旧（SYSTEM_UPDATE_UPDATER_VERSION），需要在服务器上升级一次。 */
  updaterOutdated: boolean;
  /** 宿主机报告的配置问题。 */
  warnings: SystemUpdateWarning[];
  /** 宿主机上仓库检出的路径（容器环境变量 CHISABOT_SOURCE_DIR，deploy/start.sh 写进 .env），给升级命令用。 */
  sourceDir?: string;
  updatedAt?: string;
  running: BuildVersion & { image?: string };
  current?: { image: string; commit?: string; deployedAt?: string };
  previous?: { image: string; commit?: string } | null;
  source?: {
    kind: "github" | "mirror";
    repo: string;
    branch: string;
    fetchedAt?: string;
    error?: string;
  };
  latest?: SystemUpdateCommit;
  /** 当前版本落后 main 的提交数；未知（当前镜像没有提交信息）时为 null。 */
  behind: number | null;
  commits: SystemUpdateCommit[];
  /** 依赖或底座有变化：这次更新要完整构建（「一键完整更新」）。 */
  depsChanged: boolean;
  /** 为什么要完整构建（宿主机给的一句话）。 */
  fullReason?: string;
  /** 最近一次成功的快速 / 完整更新用了多少秒。 */
  estimates: Partial<Record<SystemUpdateMode, number>>;
  /** 宿主机上有人直接运行了 update.sh / rollback.sh（不经过队列）：暂时不能点更新。 */
  externalBusy: boolean;
  job: SystemUpdateJob | null;
  /** 还在队列里、宿主机没取走的请求。 */
  pending: SystemUpdateAction[];
  history: SystemUpdateHistoryEntry[];
  /** 自托管 Magpie 网关的更新状态；宿主机没写过 magpie.json 时为 undefined。 */
  magpie?: MagpieGatewayUpdate;
};

export const UPDATE_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "prepare", label: "准备" },
  { key: "deps", label: "检查依赖" },
  { key: "backup", label: "备份数据库" },
  { key: "frontend", label: "构建前端" },
  { key: "image", label: "构建镜像" },
  { key: "drain", label: "等正在回答的对话结束" },
  { key: "swap", label: "切换到新版本" },
  { key: "health", label: "健康检查" },
  { key: "done", label: "完成" },
];

/** 完整构建（update.sh --full 或依赖变了时自动）。 */
export const FULL_UPDATE_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "prepare", label: "准备" },
  { key: "deps", label: "检查依赖" },
  { key: "backup", label: "备份数据库" },
  { key: "build", label: "完整构建" },
  { key: "load", label: "导入镜像" },
  { key: "drain", label: "等正在回答的对话结束" },
  { key: "swap", label: "切换到新版本" },
  { key: "health", label: "健康检查" },
  { key: "done", label: "完成" },
];

/** 没有历史数据时的估计（FRA 6 核实测：完整构建无缓存约 6 分钟、有缓存约 4 分钟；快速更新约 1 分钟；小机器会慢）。 */
export const DEFAULT_UPDATE_ESTIMATE_SEC: Record<SystemUpdateMode, number> = { code: 120, full: 480 };

/** 「约 N 分钟」。 */
export function estimateText(seconds: number | undefined) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `约 ${minutes} 分钟`;
}

export const ROLLBACK_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "prepare", label: "准备" },
  { key: "swap", label: "切换到上一版" },
  { key: "health", label: "健康检查" },
  { key: "done", label: "完成" },
];

const SHA = /^[0-9a-f]{7,40}$/u;
const IMAGE = /^[a-z0-9][a-z0-9._/-]{0,120}(:[A-Za-z0-9._-]{1,80})?$/u;
const ID = /^[A-Za-z0-9_-]{6,64}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 不含控制字符、长度有限的字符串，否则 undefined。 */
export function safeText(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string" || !value || value.length > max * 4) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要去掉控制字符。
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function safeSha(value: unknown) {
  return typeof value === "string" && SHA.test(value) ? value : undefined;
}

function safeImage(value: unknown) {
  return typeof value === "string" && IMAGE.test(value) ? value : undefined;
}

function safeDate(value: unknown) {
  const text = safeText(value, 40);
  return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
}

function action(value: unknown): SystemUpdateAction | undefined {
  return (SYSTEM_UPDATE_ACTIONS as readonly string[]).includes(value as string)
    ? (value as SystemUpdateAction)
    : undefined;
}

const JOB_STATUSES: readonly string[] = ["queued", "running", "succeeded", "failed", "rolled_back"];

function commit(value: unknown): SystemUpdateCommit | undefined {
  if (!record(value)) return undefined;
  const sha = safeSha(value.sha);
  const subject = safeText(value.subject, 200);
  if (!sha || !subject) return undefined;
  return {
    sha,
    subject,
    ...(safeText(value.author, 80) ? { author: safeText(value.author, 80) } : {}),
    ...(safeDate(value.date) ? { date: safeDate(value.date) } : {}),
  };
}

function mode(value: unknown): SystemUpdateMode | undefined {
  return value === "code" || value === "full" ? value : undefined;
}

function seconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 24 * 3600 ? value : undefined;
}

function job(value: unknown): SystemUpdateJob | null {
  if (!record(value)) return null;
  const id = typeof value.id === "string" && ID.test(value.id) ? value.id : undefined;
  const kind = action(value.action);
  const status = JOB_STATUSES.includes(value.status as string)
    ? (value.status as SystemUpdateJobStatus)
    : undefined;
  if (!id || !kind || !status) return null;
  const log = Array.isArray(value.log)
    ? value.log.slice(-80).map((line) => safeText(line, 400) ?? "").filter(Boolean)
    : [];
  const out: SystemUpdateJob = { id, action: kind, status, log };
  const jobMode = mode(value.mode);
  if (jobMode) out.mode = jobMode;
  const duration = seconds(value.durationSec);
  if (duration) out.durationSec = duration;
  const step = safeText(value.step, 20);
  if (step) out.step = step;
  for (const key of ["startedAt", "finishedAt"] as const) {
    const date = safeDate(value[key]);
    if (date) out[key] = date;
  }
  const actor = safeText(value.actor, 80);
  if (actor) out.actor = actor;
  const target = safeSha(value.targetCommit);
  if (target) out.targetCommit = target;
  for (const key of ["fromImage", "toImage"] as const) {
    const image = safeImage(value[key]);
    if (image) out[key] = image;
  }
  const error = safeText(value.error, 400);
  if (error) out.error = error;
  return out;
}

function history(value: unknown): SystemUpdateHistoryEntry | undefined {
  if (!record(value)) return undefined;
  const id = typeof value.id === "string" && ID.test(value.id) ? value.id : undefined;
  const kind = action(value.action);
  const status =
    value.status === "rejected" || JOB_STATUSES.includes(value.status as string)
      ? (value.status as SystemUpdateHistoryEntry["status"])
      : undefined;
  const at = safeDate(value.at);
  if (!id || !kind || !status || !at) return undefined;
  const out: SystemUpdateHistoryEntry = { id, action: kind, status, at };
  const entryMode = mode(value.mode);
  if (entryMode) out.mode = entryMode;
  const duration = seconds(value.durationSec);
  if (duration) out.durationSec = duration;
  const actor = safeText(value.actor, 80);
  if (actor) out.actor = actor;
  for (const key of ["fromImage", "toImage"] as const) {
    const image = safeImage(value[key]);
    if (image) out[key] = image;
  }
  const sha = safeSha(value.commit);
  if (sha) out.commit = sha;
  const error = safeText(value.error, 300);
  if (error) out.error = error;
  return out;
}

/**
 * 宿主机 state.json → 给管理后台的投影。任何不认识或格式不对的字段都丢掉；
 * `now` 只用来判断更新程序是否在线。
 */
export function projectSystemUpdateState(
  raw: unknown,
  running: BuildVersion & { image?: string },
  pending: SystemUpdateAction[],
  now = Date.now(),
): SystemUpdateOverview {
  const base: SystemUpdateOverview = {
    updaterOnline: false,
    configured: true,
    updaterOutdated: false,
    warnings: [],
    running,
    behind: null,
    commits: [],
    depsChanged: false,
    estimates: {},
    externalBusy: false,
    job: null,
    pending,
    history: [],
  };
  if (!record(raw)) return base;
  const updatedAt = safeDate(raw.updatedAt);
  if (updatedAt) {
    base.updatedAt = updatedAt;
    base.updaterOnline = now - Date.parse(updatedAt) < 2 * 60_000;
  }
  const version =
    typeof raw.updaterVersion === "string" && /^[0-9]{1,4}$/u.test(raw.updaterVersion)
      ? Number(raw.updaterVersion)
      : typeof raw.updaterVersion === "number" && Number.isInteger(raw.updaterVersion)
        ? raw.updaterVersion
        : undefined;
  if (version !== undefined) base.updaterVersion = version;
  // 写过状态却没有版本号的是最早的更新程序，同样算旧。
  base.updaterOutdated = !!updatedAt && (version ?? 0) < SYSTEM_UPDATE_UPDATER_VERSION;
  base.warnings = Array.isArray(raw.warnings)
    ? SYSTEM_UPDATE_WARNINGS.filter((code) => (raw.warnings as unknown[]).includes(code))
    : [];
  if (record(raw.current)) {
    const image = safeImage(raw.current.image);
    if (image)
      base.current = {
        image,
        ...(safeSha(raw.current.commit) ? { commit: safeSha(raw.current.commit) } : {}),
        ...(safeDate(raw.current.deployedAt) ? { deployedAt: safeDate(raw.current.deployedAt) } : {}),
      };
  }
  if (record(raw.previous)) {
    const image = safeImage(raw.previous.image);
    base.previous = image
      ? { image, ...(safeSha(raw.previous.commit) ? { commit: safeSha(raw.previous.commit) } : {}) }
      : null;
  } else base.previous = null;
  if (record(raw.source) && (raw.source.kind === "github" || raw.source.kind === "mirror")) {
    base.source = {
      kind: raw.source.kind,
      repo: safeText(raw.source.repo, 120) ?? "",
      branch: safeText(raw.source.branch, 60) ?? "main",
      ...(safeDate(raw.source.fetchedAt) ? { fetchedAt: safeDate(raw.source.fetchedAt) } : {}),
      ...(safeText(raw.source.error, 300) ? { error: safeText(raw.source.error, 300) } : {}),
    };
  }
  const latest = commit(raw.latest);
  if (latest) base.latest = latest;
  base.behind =
    typeof raw.behind === "number" && Number.isInteger(raw.behind) && raw.behind >= 0
      ? raw.behind
      : null;
  base.commits = Array.isArray(raw.commits)
    ? raw.commits.slice(0, 50).map(commit).filter((c): c is SystemUpdateCommit => !!c)
    : [];
  base.depsChanged = raw.depsChanged === true;
  const reason = safeText(raw.fullReason, 200);
  if (base.depsChanged && reason) base.fullReason = reason;
  if (record(raw.estimates)) {
    for (const key of ["code", "full"] as const) {
      const value = seconds(raw.estimates[key]);
      if (value) base.estimates[key] = value;
    }
  }
  base.externalBusy = raw.externalBusy === true;
  base.job = job(raw.job);
  base.history = Array.isArray(raw.history)
    ? raw.history
        .slice(0, 30)
        .map(history)
        .filter((h): h is SystemUpdateHistoryEntry => !!h)
    : [];
  return base;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * 宿主机 `magpie.json` → 页面用的形状。和 state.json 一样：只认白名单字段，不认识的丢掉。
 * 没有文件、或文件不是一个对象时返回 undefined（页面据此不显示这张卡）。
 */
export function projectMagpieGatewayState(raw: unknown): MagpieGatewayUpdate | undefined {
  if (!record(raw)) return undefined;
  const out: MagpieGatewayUpdate = {
    installed: raw.installed === true,
    updateAvailable: raw.updateAvailable === true,
  };
  const image = safeImage(raw.image);
  if (image) out.image = image;
  const container = safeText(raw.container, 80);
  if (container) out.container = container;
  for (const key of ["currentDigest", "latestDigest"] as const) {
    const value = raw[key];
    if (typeof value === "string" && DIGEST.test(value)) out[key] = value;
  }
  const checkedAt = safeDate(raw.checkedAt);
  if (checkedAt) out.checkedAt = checkedAt;
  const error = safeText(raw.error, 300);
  if (error) out.error = error;
  if (raw.installable === true) out.installable = true;
  if (raw.managed === true) out.managed = true;
  if (raw.verification === "attested" || raw.verification === "digest" || raw.verification === "off")
    out.verification = raw.verification;
  // 摘要不齐就不宣称有新版：说「不知道」比说错好。两边摘要相同就是同一份镜像，宿主机写错了也不能说有新版。
  if (!out.currentDigest || !out.latestDigest || out.currentDigest === out.latestDigest) out.updateAvailable = false;
  return out;
}

/** 网页的「有新版本」判断：两边都有构建号、而且不一样。开发环境（dev）从不提示。 */
export function isNewerBuild(bundled: string | undefined, served: BuildVersion | null | undefined) {
  if (!bundled || bundled === "dev" || !served?.buildId || served.buildId === "dev") return false;
  return served.buildId !== bundled;
}
