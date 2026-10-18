import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CAPABILITY_INFO,
  capabilityFor,
  checkOpenTarget,
  type DeviceOperation,
  GIT_SUBCOMMANDS,
} from "../../../shared/devices";
import type { AuditInitiator } from "../audit";
import { REFUSAL_MARKER, type GrantedTool } from "../plugins/tools";
import { DeviceRefusedError, type DeviceHub } from "./hub";
import { type DeviceRecord, type DeviceStore, fullAccessActive } from "./store";

/** 机器人工作区（服务器上的云端电脑）：device_upload / device_download 用它读写。 */
export type DeviceWorkspace = {
  read: (path: string) => Promise<{ bytes: Buffer; name: string }>;
  write: (path: string, bytes: Buffer) => Promise<boolean>;
};

/**
 * 把设备节点的能力变成机器人工具（docs/pc-node.md §7）。
 *
 * 设备属于账号，不属于某个机器人：这次运行的人名下的每台在线设备，这个人的任何机器人都能用。
 * 调用方 index.ts 传入这个人名下全部未撤销的设备：一台都没有 → 不给工具；有但都离线 → 只给 device_list
 * （只读，用来如实回答「电脑离线」）；至少一台在线 → 全套。不论哪种，都带一段提示词（{@link deviceGuidance}），
 * 告诉机器人用户的电脑已关联、现在是否在线、开了哪些能力。不再有「按机器人勾选」这一层；安全边界仍是每台设备
 * 自己的能力开关（默认全关）、允许的文件夹、审批、紧急停止和审计，全部在 hub 里。
 * 每次执行都重新读设备（开关可能刚被改过）。多台在线时用 deviceId 选（id 或名称）；只有一台在线时可省略。
 */

const deviceId = z
  .string()
  .min(1)
  .optional()
  .describe("目标设备：设备 id 或设备名称（见 device_list）。只有一台在线设备时可以省略；多台在线时必须指定。");

const schemas = {
  list: z.object({}),
  info: z.object({ deviceId }),
  shell: z.object({
    deviceId,
    command: z.string().min(1).max(20_000).describe("要运行的命令：Windows 上是 PowerShell，Linux / macOS 上是 bash（没有 bash 时 sh）"),
    cwd: z.string().optional().describe("工作目录（绝对路径，可选）"),
    timeoutSec: z.number().int().min(1).max(600).optional().describe("前台等待的超时秒数，默认 60，最多 600；更久的（编译、测试、开发服务器）用 background: true"),
    background: z.boolean().optional().describe("true = 后台运行，立刻返回 jobId 和开头的输出；之后用 device_shell_output 看输出、device_shell_kill 结束。适合构建、测试、开发服务器、长时间任务"),
    session: z.string().max(64).optional().describe("持久会话名（例如 \"main\"）：同名会话里 cd、export / $env: 设置的目录和环境变量会保留到下一条命令"),
    elevated: z.boolean().optional().describe("以管理员 / root 身份运行（只在完全访问模式下可用；Windows 首次会弹一次 UAC，Linux/macOS 需要节点是 root 或有免密 sudo）"),
  }),
  shellOutput: z.object({
    deviceId,
    jobId: z.string().optional().describe("后台命令的 jobId；省略时列出这台设备上的全部后台命令"),
    since: z.number().int().min(0).optional().describe("从第几个字节开始（上次返回的 nextOffset），省略 = 从头"),
    waitSec: z.number().int().min(0).max(25).optional().describe("没有新输出时最多等几秒（默认 0）"),
  }),
  shellKill: z.object({ deviceId, jobId: z.string().min(1) }),
  search: z.object({
    deviceId,
    path: z.string().optional().describe("从哪里开始搜（文件夹或文件；省略 = 第一个允许的文件夹）"),
    pattern: z.string().max(1000).optional().describe("要搜索的内容（正则；按字面搜索设 literal: true）。省略 = 只按 glob 列文件名"),
    glob: z.union([z.string(), z.array(z.string()).max(20)]).optional().describe("文件名过滤，例如 \"*.ts\"、\"src/**/*.py\"、\"*.{js,jsx}\""),
    literal: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
    contextLines: z.number().int().min(0).max(5).optional().describe("每个匹配前后带几行上下文"),
    maxResults: z.number().int().min(1).max(1000).optional().describe("最多返回多少条，默认 100"),
    includeIgnored: z.boolean().optional().describe("true = 也搜 node_modules、.git、dist 等通常跳过的目录"),
  }),
  edit: z.object({
    deviceId,
    path: z.string().min(1),
    edits: z
      .array(
        z.object({
          oldText: z.string().min(1).describe("要替换的原文，必须和文件里逐字一致（含缩进），并且在文件里唯一；带上前后几行让它唯一"),
          newText: z.string().describe("替换成的内容"),
          replaceAll: z.boolean().optional().describe("true = 替换所有出现的地方"),
        }),
      )
      .min(1)
      .max(50)
      .describe("一处或多处精确替换，按顺序应用；任何一处对不上就整个不改"),
    dryRun: z.boolean().optional().describe("true = 只返回 diff，不写文件"),
  }),
  patch: z.object({
    deviceId,
    patch: z.string().min(1).max(1_000_000).describe("unified diff（git diff 格式：--- a/路径、+++ b/路径、@@ -行,数 +行,数 @@），可以包含多个文件；新建文件用 --- /dev/null"),
    cwd: z.string().optional().describe("补丁里的相对路径相对于哪个目录（通常是仓库根目录）"),
    dryRun: z.boolean().optional(),
  }),
  git: z.object({
    deviceId,
    cwd: z.string().min(1).describe("仓库目录（clone / init 时是目标目录的上级或目标目录）"),
    subcommand: z.enum(GIT_SUBCOMMANDS).describe("status / diff / log / show / branch… 是只读；add / commit / checkout / pull / push… 会改动（push 每次都要用户批准）"),
    args: z.array(z.string().max(2000)).max(50).optional().describe("其余参数，例如 [\"-m\", \"修复测试\"]、[\"--stat\"]、[\"https://github.com/x/y.git\", \"y\"]"),
  }),
  processes: z.object({
    deviceId,
    action: z.enum(["list", "kill"]),
    filter: z.string().max(200).optional().describe("list：按名称 / 命令行过滤"),
    limit: z.number().int().min(1).max(300).optional(),
    pid: z.number().int().optional().describe("kill：进程号"),
    signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]).optional(),
  }),
  upload: z.object({
    deviceId,
    from: z.string().min(1).describe("你工作区（云端电脑）里的文件路径"),
    to: z.string().min(1).describe("设备上的目标路径"),
    overwrite: z.boolean().optional().describe("目标已存在时是否覆盖（覆盖前备份），默认 true"),
  }),
  download: z.object({
    deviceId,
    from: z.string().min(1).describe("设备上的文件路径"),
    to: z.string().min(1).describe("存到你工作区（云端电脑）里的路径"),
  }),
  listFiles: z.object({
    deviceId,
    path: z.string().optional().describe("绝对路径，或相对于第一个允许文件夹的路径；省略时列出允许的文件夹"),
  }),
  readFile: z.object({
    deviceId,
    path: z.string().min(1),
    startLine: z.number().int().min(1).optional().describe("从第几行开始（1 起）。给了 startLine / endLine 就按行读取并带行号，适合大文件；一次最多 2000 行"),
    endLine: z.number().int().min(1).optional().describe("读到第几行（含）"),
    maxBytes: z.number().int().min(1).max(1_048_576).optional().describe("不按行读时最多读取的字节数，默认 262144"),
  }),
  writeFile: z.object({
    deviceId,
    path: z.string().min(1),
    content: z.string().max(2_000_000),
    append: z.boolean().optional().describe("true 时追加到末尾，否则覆盖（覆盖前 PC 会备份原文件）"),
  }),
  screenshot: z.object({
    deviceId,
    maxWidth: z.number().int().min(320).max(3840).optional().describe("缩放后的最大宽度，默认 1600"),
  }),
  input: z.object({
    deviceId,
    action: z
      .enum(["move", "click", "double_click", "right_click", "scroll", "type", "key"])
      .describe("move/click/double_click/right_click 需要 x,y；scroll 用 amount（正数向上）；type 输入 text；key 发送按键，如 {ENTER}、^c、%{F4}（SendKeys 语法）"),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    amount: z.number().int().optional(),
    text: z.string().max(5000).optional(),
    keys: z.string().max(200).optional(),
  }),
  open: z.object({
    deviceId,
    target: z.string().min(1).max(2000).describe("http/https 网址，或允许的文件夹里的文件 / 文件夹路径，例如 https://example.com、D:\\报告\\周报.pdf；文件夹以 \\ 或 / 结尾，例如 D:\\报告\\"),
  }),
  clipboard: z.object({
    deviceId,
    action: z.enum(["read", "write"]),
    text: z.string().max(100_000).optional(),
  }),
};

/**
 * 把模型给的设备选择（id / 名称 / 主机名，或省略）解析成这个人名下的一台未撤销设备。
 * 返回字符串 = 拒绝原因（给模型看）。
 */
export async function resolveDevice(
  store: Pick<DeviceStore, "forOwner">,
  ownerUserId: string,
  selector: string | undefined,
  isOnline: (id: string) => boolean,
): Promise<DeviceRecord | string> {
  const owned = await store.forOwner(ownerUserId);
  const wanted = selector?.trim();
  if (wanted) {
    const byId = owned.find((device) => device.id === wanted);
    if (byId) return byId;
    const key = wanted.toLowerCase();
    const byName = owned.filter((device) => device.name.toLowerCase() === key);
    const matches = byName.length ? byName : owned.filter((device) => device.hostname?.toLowerCase() === key);
    if (matches.length === 1) return matches[0] as DeviceRecord;
    if (matches.length > 1) {
      const online = matches.filter((device) => isOnline(device.id));
      if (online.length === 1) return online[0] as DeviceRecord;
      return `有 ${matches.length} 台设备都叫「${wanted}」，请改用设备 id。`;
    }
    return `用户名下没有「${wanted}」这台设备（或它已被撤销）。`;
  }
  const online = owned.filter((device) => isOnline(device.id));
  if (online.length === 1) return online[0] as DeviceRecord;
  if (online.length === 0) return "用户名下现在没有在线的设备。";
  return `现在有 ${online.length} 台设备在线，请用 deviceId 指定是哪一台。`;
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** diff 头里的路径：去掉开头的 / 或盘符前的 /，避免「a//work/x」。 */
function diffPath(path: string) {
  return path.replace(/^\/+/, "");
}

/** 审批卡片里看的改动预览：edit_file 的每处 oldText → newText（不读文件，所以不带行号）。 */
export function editsPreview(path: string, edits: readonly { oldText: string; newText: string; replaceAll?: boolean | undefined }[]): string {
  const lines = [`--- a/${diffPath(path)}`, `+++ b/${diffPath(path)}`];
  for (const edit of edits.slice(0, 20)) {
    lines.push(`@@ ${edit.replaceAll ? "全部替换" : "替换"} @@`);
    for (const l of edit.oldText.split(/\r?\n/).slice(0, 60)) lines.push(`-${l}`);
    for (const l of edit.newText.split(/\r?\n/).slice(0, 60)) lines.push(`+${l}`);
  }
  if (edits.length > 20) lines.push(`…另外 ${edits.length - 20} 处`);
  const text = lines.join("\n");
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…` : text;
}

/** write_file 的预览：新内容的开头（覆盖时旧内容不在服务器上，看不到删了什么）。 */
function contentPreview(path: string, content: string, append: boolean): string {
  const lines = content.split(/\r?\n/);
  const head = lines.slice(0, 80).map((l) => `+${l}`);
  return [`--- a/${diffPath(path)}`, `+++ b/${diffPath(path)}`, `@@ ${append ? "追加到末尾" : "整个文件写成"}（${lines.length} 行）@@`, ...head, ...(lines.length > 80 ? [`…另外 ${lines.length - 80} 行`] : [])].join("\n");
}

/** 「3 分钟前」「约 15 小时前」「2 天前」；没有记录时「从未连接过」。服务器不知道用户时区，所以只说相对时间。 */
export function agoText(iso: string | null, now = Date.now()) {
  if (!iso) return "从未连接过";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "刚刚";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `约 ${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function platformName(platform: string) {
  return platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
}

/**
 * 给机器人的「用户的电脑」提示词。没有这一段时，计算机那段很长的提示词（「你有自己的浏览器」）说了算，
 * 机器人手里拿着 device_* 工具也会回答「我看不到你的电脑，只有隔离的浏览器」（2026-10-13 用户报告）。
 * 设备列表为空时返回空字符串（什么都不说，和以前一样）。
 */
export function deviceGuidance(
  devices: readonly (Pick<DeviceRecord, "id" | "name" | "platform" | "osVersion" | "paused" | "capabilities" | "lastSeenAt"> &
    Partial<Pick<DeviceRecord, "fullAccessUntil" | "revoked">>)[],
  isOnline: (id: string) => boolean,
  now = Date.now(),
): string {
  if (!devices.length) return "";
  const describe = (device: (typeof devices)[number]) => {
    const enabled = Object.entries(device.capabilities)
      .filter(([, policy]) => policy !== "off")
      .map(([cap, policy]) => `${CAPABILITY_INFO[cap as keyof typeof CAPABILITY_INFO]?.label ?? cap}${policy === "ask" ? "（每次需用户批准）" : ""}`);
    const full = fullAccessActive({ fullAccessUntil: device.fullAccessUntil ?? null, paused: device.paused, revoked: device.revoked ?? false }, now);
    if (full && isOnline(device.id))
      return `- 「${device.name}」 (${device.osVersion || platformName(device.platform)}, deviceId ${device.id}): ONLINE now, 完全访问 FULL ACCESS is ON (the person turned it on${device.fullAccessUntil && device.fullAccessUntil.startsWith("9999") ? ", no expiry" : ` until ${device.fullAccessUntil}`}): every device_* tool runs without approval, any path on the whole computer, long/background commands without the 10-minute cap, elevated: true allowed. Everything is still logged and the person can hit 紧急停止 at any time.`;
    const state = isOnline(device.id)
      ? device.paused
        ? "online but on emergency stop (紧急停止): every remote action is refused until the person lifts it"
        : "ONLINE now"
      : `offline (last connected ${agoText(device.lastSeenAt, now)})`;
    return `- 「${device.name}」 (${device.osVersion || platformName(device.platform)}, deviceId ${device.id}): ${state}; enabled capabilities: ${enabled.length ? enabled.join("、") : "none yet (只能读系统信息)"}.`;
  };
  const online = devices.filter((device) => isOnline(device.id));
  const lines = [
    "The person's own computers. Besides your own cloud browser (the computer_* tools), the person has linked these computers of theirs to their account through the ChisaBot PC client. They are shared by all of the person's Bots, including you:",
    ...devices.map(describe),
  ];
  if (online.length) {
    lines.push(
      "When the person asks whether you can see, reach or use their computer, the answer is yes for the online one(s): say so plainly and use the device_* tools (device_* acts on THEIR computer; computer_* acts on your cloud browser / workspace). Listing allowed folders or files on their PC MUST use device_list_files — never computer_list_files (that is your cloud workspace, often a projects/ folder, and it does not show a confirm card or device audit). Never claim you only have an isolated browser.",
      "Capabilities marked 每次需用户批准 (the default for a newly linked computer) work right away: just call the device_* tool; ChisaBot shows the person an approval prompt on that computer and on the web/phone, and the call returns once they approve (or is refused if they deny or nobody answers within 2 minutes). Say in one short line that they will see a prompt to approve; do not ask for permission in chat first. File tools work inside the computer's 允许的文件夹 (listed by device_list as allowedRoots). For an absolute path outside them (e.g. C:\\AI) just call the file tool with that path: the approval prompt tells the person the folder will be added to 允许的文件夹, and once they approve it is added and the call runs. Do not tell them to add the folder by hand first.",
      "A capability that is off was switched off by the person (命令行、读取文件、写入文件、截图、鼠标键盘、打开网址 / 文件、剪贴板). If a request needs one that is off, say which one and tell them they can set it to 询问 in 设置 → 设备 → the computer → 权限, then try again; do not pretend to have done it.",
      "完全访问 (full access) can only be turned on by the person in 设置 → 设备 → the computer → 权限; you cannot turn it on. If a task genuinely needs it (whole-disk access, admin rights, unattended long jobs) say so once and let them decide.",
      "Coding / changing files on their device (also servers running chisabot-node): work like a careful engineer. 1) Find: device_search (pattern + glob) and device_list_files. 2) Read only what you need: device_read_file with startLine/endLine (numbered lines; never dump whole large files into the chat). 3) Change: device_edit_file with exact oldText/newText (copy the text from what you read, without the line-number prefix; add surrounding lines until it is unique), or device_apply_patch for multi-file changes; device_write_file only for new files or full rewrites. 4) Verify: run the tests / build with device_run_shell (cwd = the project; background: true + device_shell_output for anything longer than a minute, e.g. dev servers, big builds). 5) Report: a short summary plus the diffs the tools returned (only the relevant hunks), test results, and git status if it is a repo; commit with device_git only when the person asked or clearly expects it, and push only when asked (push always needs their approval). Use a session name (e.g. session: \"main\") when later commands depend on cd / env from earlier ones.",
    );
  } else {
    lines.push(
      "None of them is online right now, so you cannot operate them at this moment. If the person asks about their computer, say it is linked but not connected, give the name and when it was last online, and ask them to open ChisaBot PC on it (the tray icon turns blue when it is connected). If ChisaBot PC is open but it still shows offline, they can use the tray menu 「重新登记这台电脑」 or sign out and sign in again in ChisaBot PC.",
    );
  }
  return lines.join("\n");
}


export function deviceTools(options: {
  store: DeviceStore;
  hub: DeviceHub;
  botId: string;
  actorId: string;
  devices: DeviceRecord[];
  botName?: string | null;
  initiator?: AuditInitiator;
  /** 机器人自己的云端工作区：有了才给 device_upload / device_download。 */
  workspace?: DeviceWorkspace;
}): GrantedTool[] {
  const { store, hub, botId, actorId } = options;
  if (!options.devices.length) return [];
  const botName = options.botName ?? null;
  const onlineDevices = options.devices.filter((device) => hub.isOnline(device.id));
  const guidance = deviceGuidance(options.devices, (id) => hub.isOnline(id));

  const roster = options.devices
    .map((device) => {
      const caps = Object.entries(device.capabilities)
        .filter(([, policy]) => policy !== "off")
        .map(([cap, policy]) => `${cap}${policy === "ask" ? "(需审批)" : ""}`)
        .join(",");
      return `${device.id}「${device.name}」${hub.isOnline(device.id) ? "在线" : "离线"}·${device.platform}${device.paused ? "·已紧急停止" : ""}${fullAccessActive(device) ? "·完全访问" : ""}·能力:${caps || "无"}`;
    })
    .join("；");

  async function run(
    operation: DeviceOperation,
    selector: string | undefined,
    args: Record<string, unknown>,
    summary: string,
    timeoutMs?: number,
    diff?: string | null,
  ): Promise<string> {
    const result = await raw(operation, selector, args, summary, timeoutMs, diff);
    return typeof result === "string" ? result : JSON.stringify(result ?? {});
  }

  /** 和 run 一样，但成功时返回原始结果对象（上传 / 下载要分块循环）。失败返回给模型看的字符串。 */
  async function raw(
    operation: DeviceOperation,
    selector: string | undefined,
    args: Record<string, unknown>,
    summary: string,
    timeoutMs?: number,
    diff?: string | null,
  ): Promise<unknown> {
    const picked = await resolveDevice(store, actorId, selector, (id) => hub.isOnline(id));
    if (typeof picked === "string") return `${REFUSAL_MARKER} ${picked} 可用设备：${roster}`;
    const device = picked;
    try {
      const result = await hub.invoke({
        device,
        operation,
        args,
        bot: { id: botId, name: botName },
        summary,
        timeoutMs,
        diff: diff ?? null,
      });
      if (operation === "screenshot" && result && typeof result === "object" && "url" in result) {
        const shot = result as { url: string; width?: number; height?: number };
        return JSON.stringify({
          ...shot,
          note: `截图已保存（30 分钟内有效）。在回复中可用 Markdown 展示：![截图](${shot.url})`,
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "设备操作失败。";
      return error instanceof DeviceRefusedError
        ? `${REFUSAL_MARKER} ${message}`
        : `设备操作失败：${message}`;
    }
  }

  const enabledAnywhere = (operation: DeviceOperation, args: Record<string, unknown> = {}) => {
    const capability = capabilityFor(operation, args);
    return !capability || onlineDevices.some((device) => fullAccessActive(device) || device.capabilities[capability] !== "off");
  };

  const tools: GrantedTool[] = [
    {
      name: "device_list",
      ref: "devices/list",
      description: `列出用户账号下关联的全部设备（ChisaBot PC / 手机客户端）及其在线状态和已开启的能力。这些设备由用户的所有机器人共用。被问到「能不能看到 / 用我的电脑」时先调用它。当前：${roster}`,
      parameters: schemas.list,
      execute: async () => {
        const fresh = await store.forOwner(actorId);
        return JSON.stringify({
          devices: fresh.map((device) => ({
            deviceId: device.id,
            name: device.name,
            platform: device.platform,
            clientVersion: device.clientVersion,
            hostname: device.hostname,
            online: hub.isOnline(device.id),
            lastSeenAt: device.lastSeenAt,
            lastSeen: hub.isOnline(device.id) ? "在线" : agoText(device.lastSeenAt),
            paused: device.paused,
            allowedRoots: device.allowedRoots,
            capabilities: device.capabilities,
            fullAccess: fullAccessActive(device),
            fullAccessUntil: fullAccessActive(device) ? device.fullAccessUntil : null,
            codingTools: hub.isOnline(device.id) ? (hub.supports?.(device.id, "edit_file") ?? false) : undefined,
          })),
          legend: Object.fromEntries(
            Object.entries(CAPABILITY_INFO).map(([key, info]) => [key, info.label]),
          ),
        });
      },
    },
    {
      name: "device_system_info",
      ref: "devices/system_info",
      description: "读取设备的系统信息（系统版本、主机名、用户、CPU、内存、屏幕分辨率）。",
      parameters: schemas.info,
      execute: async (input) => {
        const args = schemas.info.parse(input ?? {});
        return run("system_info", args.deviceId, {}, "读取系统信息");
      },
    },
  ];

  // 有关联设备但都不在线：只留 device_list（只读），让机器人能如实说「电脑已关联，但现在离线」，
  // 而不是因为什么工具都没有就说「我看不到你的电脑」。操作类工具等设备上线后才出现。
  if (!onlineDevices.length)
    return tools
      .filter((tool) => tool.name === "device_list")
      .map((tool) => ({ ...tool, guidance, initiator: options.initiator }));

  if (enabledAnywhere("shell"))
    tools.push(
      {
        name: "device_run_shell",
        ref: "devices/run_shell",
        description:
          "在用户设备上运行命令（Windows = PowerShell，Linux / macOS = bash），返回退出码、stdout、stderr（各最多 64KB，超长保留开头和结尾）。cwd 设工作目录；session 让 cd / 环境变量在多条命令间保留；background: true 后台运行（构建、测试、开发服务器），之后用 device_shell_output / device_shell_kill。可能需要用户审批。不要运行破坏性命令。",
        parameters: schemas.shell,
        execute: async (input) => {
          const args = schemas.shell.parse(input ?? {});
          const where = `${args.cwd ? `（目录 ${args.cwd}）` : ""}${args.session ? `［会话 ${args.session}］` : ""}${args.elevated ? "［管理员］" : ""}`;
          if (args.background)
            return run(
              "exec_start",
              args.deviceId,
              { command: args.command, cwd: args.cwd, session: args.session, elevated: args.elevated === true, timeoutSec: args.timeoutSec && args.timeoutSec > 600 ? args.timeoutSec : undefined },
              `后台运行：${clip(args.command, 300)}${where}`,
              60_000,
            );
          const timeoutSec = args.timeoutSec ?? 60;
          return run(
            "shell",
            args.deviceId,
            { command: args.command, cwd: args.cwd, timeoutSec, session: args.session, elevated: args.elevated === true },
            `运行命令：${clip(args.command, 300)}${where}`,
            (timeoutSec + 20) * 1000,
          );
        },
      },
      {
        name: "device_shell_output",
        ref: "devices/shell_output",
        description: "查看后台命令（device_run_shell background: true 启动的）的状态和新输出：带上上次的 nextOffset 只拿新增部分；waitSec 可以等新输出。省略 jobId = 列出全部后台命令。",
        parameters: schemas.shellOutput,
        execute: async (input) => {
          const args = schemas.shellOutput.parse(input ?? {});
          if (!args.jobId) return run("exec_list", args.deviceId, {}, "列出后台命令", 30_000);
          return run("exec_poll", args.deviceId, { jobId: args.jobId, since: args.since ?? 0, waitMs: (args.waitSec ?? 0) * 1000 }, `查看输出：${args.jobId}`, ((args.waitSec ?? 0) + 30) * 1000);
        },
      },
      {
        name: "device_shell_kill",
        ref: "devices/shell_kill",
        description: "结束一个后台命令（连同它的子进程）。",
        parameters: schemas.shellKill,
        execute: async (input) => {
          const args = schemas.shellKill.parse(input ?? {});
          return run("exec_kill", args.deviceId, { jobId: args.jobId }, `结束后台命令：${args.jobId}`, 30_000);
        },
      },
      {
        name: "device_processes",
        ref: "devices/processes",
        description: "查看设备上正在运行的进程（按 CPU 排序，可按名称过滤），或按进程号结束一个进程。",
        parameters: schemas.processes,
        execute: async (input) => {
          const args = schemas.processes.parse(input ?? {});
          if (args.action === "kill") {
            if (!args.pid) return `${REFUSAL_MARKER} 结束进程需要 pid（先 action: list 查）。`;
            return run("process_kill", args.deviceId, { pid: args.pid, signal: args.signal }, `结束进程 ${args.pid}`, 30_000);
          }
          return run("process_list", args.deviceId, { filter: args.filter, limit: args.limit }, `查看进程${args.filter ? `（${args.filter}）` : ""}`, 45_000);
        },
      },
    );

  if (enabledAnywhere("list_files"))
    tools.push(
      {
        name: "device_list_files",
        ref: "devices/list_files",
        description: "列出【用户电脑】上的文件和子文件夹（不是云端工作区）。不给 path 列出「允许的文件夹」；给允许的文件夹之外的绝对路径时，用户批准后会把它加入允许的文件夹。机器人自己的云端目录请用 computer_list_files。",
        parameters: schemas.listFiles,
        execute: async (input) => {
          const args = schemas.listFiles.parse(input ?? {});
          return run("list_files", args.deviceId, { path: args.path }, `列出：${args.path ?? "允许的文件夹"}`);
        },
      },
      {
        name: "device_read_file",
        ref: "devices/read_file",
        description:
          "读取用户设备上的文本文件。给 startLine / endLine 时按行读取（带行号，一次最多 2000 行，返回 totalLines），大文件、代码文件用这个只读需要的部分；不给时读整个文件（默认最多 256KB）。",
        parameters: schemas.readFile,
        execute: async (input) => {
          const args = schemas.readFile.parse(input ?? {});
          const ranged = args.startLine !== undefined || args.endLine !== undefined;
          return run(
            "read_file",
            args.deviceId,
            ranged ? { path: args.path, startLine: args.startLine ?? 1, endLine: args.endLine } : { path: args.path, maxBytes: args.maxBytes },
            `读取：${args.path}${ranged ? `（第 ${args.startLine ?? 1}–${args.endLine ?? "…"} 行）` : ""}`,
          );
        },
      },
      {
        name: "device_search",
        ref: "devices/search",
        description:
          "在用户设备上搜索代码 / 文本（类似 ripgrep）：pattern 搜内容（返回 文件:行号:内容），glob 过滤文件名；只给 glob 就是按名字找文件。默认跳过 node_modules、.git、dist 等目录和二进制文件，最多 100 条。",
        parameters: schemas.search,
        execute: async (input) => {
          const args = schemas.search.parse(input ?? {});
          if (!args.pattern && !args.glob) return `${REFUSAL_MARKER} 至少给 pattern 或 glob 之一。`;
          return run("search", args.deviceId, { ...args, deviceId: undefined }, `搜索：${args.pattern ? clip(args.pattern, 100) : ""}${args.glob ? ` ${JSON.stringify(args.glob)}` : ""}${args.path ? ` 于 ${args.path}` : ""}`, 70_000);
        },
      },
    );

  if (enabledAnywhere("write_file"))
    tools.push({
      name: "device_write_file",
      ref: "devices/write_file",
      description: "在用户设备上写入整个文本文件（新建文件或整体重写；覆盖前自动备份为 .chisabot-bak）。改已有代码请用 device_edit_file。可能需要用户审批。",
      parameters: schemas.writeFile,
      execute: async (input) => {
        const args = schemas.writeFile.parse(input ?? {});
        return run(
          "write_file",
          args.deviceId,
          { path: args.path, content: args.content, append: args.append === true },
          `${args.append ? "追加" : "写入"}：${args.path}（${Buffer.byteLength(args.content)} 字节）`,
          60_000,
          contentPreview(args.path, args.content, args.append === true),
        );
      },
    });

  if (enabledAnywhere("edit_file"))
    tools.push(
      {
        name: "device_edit_file",
        ref: "devices/edit_file",
        description:
          "精确修改用户设备上的文件：edits 里每处 oldText → newText（oldText 必须逐字一致且唯一，否则整个不改并说明原因）。改前自动备份（git 仓库里在 .git/chisabot-backups/），返回 unified diff。改代码优先用它，不要整文件重写。",
        parameters: schemas.edit,
        execute: async (input) => {
          const args = schemas.edit.parse(input ?? {});
          return run(
            "edit_file",
            args.deviceId,
            { path: args.path, edits: args.edits, dryRun: args.dryRun === true },
            `修改：${args.path}（${args.edits.length} 处）`,
            60_000,
            editsPreview(args.path, args.edits),
          );
        },
      },
      {
        name: "device_apply_patch",
        ref: "devices/apply_patch",
        description:
          "把 unified diff（git diff 格式，可多文件、可新建 / 删除文件）应用到用户设备上。全部校验通过才写盘（任何一段对不上就一个都不改），改前备份，返回实际 diff。行号有偏移也能找到位置。",
        parameters: schemas.patch,
        execute: async (input) => {
          const args = schemas.patch.parse(input ?? {});
          const files = [...args.patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((m) => m[1]?.trim()).filter(Boolean);
          return run(
            "apply_patch",
            args.deviceId,
            { patch: args.patch, cwd: args.cwd, dryRun: args.dryRun === true },
            `应用补丁：${files.slice(0, 5).join("、") || "（无文件名）"}${files.length > 5 ? ` 等 ${files.length} 个文件` : ""}${args.cwd ? `（目录 ${args.cwd}）` : ""}`,
            90_000,
            args.patch.length > 60_000 ? `${args.patch.slice(0, 60_000)}\n…` : args.patch,
          );
        },
      },
    );

  if (enabledAnywhere("git", { subcommand: "status" }))
    tools.push({
      name: "device_git",
      ref: "devices/git",
      description:
        "在用户设备上运行 git（不经过 shell，参数逐个给）：status / diff / log / show / branch 等只读子命令只要「读取文件」能力；add / commit / checkout / pull / clone 等需要「命令行」能力；push 每次都要用户批准。",
      parameters: schemas.git,
      execute: async (input) => {
        const args = schemas.git.parse(input ?? {});
        const long = ["pull", "push", "fetch", "clone"].includes(args.subcommand);
        return run(
          "git",
          args.deviceId,
          { cwd: args.cwd, subcommand: args.subcommand, args: args.args ?? [] },
          `git ${args.subcommand} ${clip((args.args ?? []).join(" "), 200)}（${args.cwd}）`,
          (long ? 330 : 90) * 1000,
        );
      },
    });

  if (options.workspace && enabledAnywhere("file_upload"))
    tools.push({
      name: "device_upload",
      ref: "devices/upload",
      description: "把你工作区（云端电脑）里的文件传到用户设备上（最大 200MB；覆盖前备份）。",
      parameters: schemas.upload,
      execute: async (input) => {
        const args = schemas.upload.parse(input ?? {});
        let file: { bytes: Buffer; name: string };
        try {
          file = await options.workspace!.read(args.from);
        } catch (error) {
          return `${REFUSAL_MARKER} 读不到工作区文件 ${args.from}：${error instanceof Error ? error.message : String(error)}`;
        }
        if (file.bytes.length > 200 * 1024 * 1024) return `${REFUSAL_MARKER} 文件超过 200MB。`;
        const sha256 = createHash("sha256").update(file.bytes).digest("hex");
        const chunk = 3 * 1024 * 1024;
        let last: unknown = null;
        for (let offset = 0; ; offset += chunk) {
          const part = file.bytes.subarray(offset, offset + chunk);
          const final = offset + chunk >= file.bytes.length;
          last = await raw(
            "file_upload",
            args.deviceId,
            { path: args.to, offset, base64: part.toString("base64"), final, overwrite: args.overwrite !== false, ...(final ? { sha256 } : {}) },
            offset === 0 ? `传文件到设备：${args.from} → ${args.to}（${file.bytes.length} 字节）` : `传文件到设备（续 ${Math.round(offset / chunk) + 1}）：${args.to}`,
            120_000,
          );
          if (typeof last === "string") return last;
          if (final) break;
        }
        return JSON.stringify(last ?? {});
      },
    });

  if (options.workspace && enabledAnywhere("file_download"))
    tools.push({
      name: "device_download",
      ref: "devices/download",
      description: "把用户设备上的文件取回你的工作区（云端电脑），之后可以处理它或用 file_share 交给用户（最大 200MB）。",
      parameters: schemas.download,
      execute: async (input) => {
        const args = schemas.download.parse(input ?? {});
        const parts: Buffer[] = [];
        let offset = 0;
        let name = args.from;
        for (let i = 0; i < 100; i++) {
          const result = await raw("file_download", args.deviceId, { path: args.from, offset }, i === 0 ? `从设备取文件：${args.from}` : `从设备取文件（续 ${i + 1}）：${args.from}`, 120_000);
          if (typeof result === "string") return result;
          const r = result as { base64?: string; size?: number; done?: boolean; name?: string };
          if ((r.size ?? 0) > 200 * 1024 * 1024) return `${REFUSAL_MARKER} 文件超过 200MB。`;
          const bytes = Buffer.from(r.base64 ?? "", "base64");
          parts.push(bytes);
          offset += bytes.length;
          name = r.name ?? name;
          if (r.done || !bytes.length) break;
        }
        const all = Buffer.concat(parts);
        try {
          await options.workspace!.write(args.to, all);
        } catch (error) {
          return `${REFUSAL_MARKER} 写入工作区失败：${error instanceof Error ? error.message : String(error)}`;
        }
        return JSON.stringify({ from: args.from, to: args.to, bytes: all.length, name });
      },
    });

  if (enabledAnywhere("screenshot"))
    tools.push({
      name: "device_screenshot",
      ref: "devices/screenshot",
      description: "截取用户电脑的主屏幕，返回截图地址和尺寸。",
      parameters: schemas.screenshot,
      execute: async (input) => {
        const args = schemas.screenshot.parse(input ?? {});
        return run("screenshot", args.deviceId, { maxWidth: args.maxWidth ?? 1600 }, "截取屏幕", 60_000);
      },
    });

  if (enabledAnywhere("input"))
    tools.push({
      name: "device_input",
      ref: "devices/input",
      description:
        "在用户电脑上操作鼠标和键盘（坐标为屏幕像素，基于真实分辨率，不是缩放后的截图）。可能需要用户审批。",
      parameters: schemas.input,
      execute: async (input) => {
        const args = schemas.input.parse(input ?? {});
        const { deviceId: id, ...rest } = args;
        const what =
          args.action === "type"
            ? `输入文字：${clip(args.text ?? "", 80)}`
            : args.action === "key"
              ? `按键：${args.keys ?? ""}`
              : `${args.action}${args.x !== undefined ? ` (${args.x}, ${args.y})` : ""}${args.amount ? ` ${args.amount}` : ""}`;
        return run("input", id, rest, `鼠标键盘：${what}`, 60_000);
      },
    });

  if (enabledAnywhere("open"))
    tools.push({
      name: "device_open",
      ref: "devices/open",
      description:
        "在用户电脑上用默认浏览器打开 http/https 网址，或用默认程序打开允许的文件夹里的文件 / 文件夹。不能启动程序、不能带参数、不打开 .exe / .bat / .ps1 / .lnk 这类可执行文件和脚本（要运行程序用 device_run_shell，走命令行的审批）。",
      parameters: schemas.open,
      execute: async (input) => {
        const args = schemas.open.parse(input ?? {});
        // CB-030：只做安全的打开，发给设备前先拦（旧版 PC 客户端还接受程序名和参数，靠这里挡住）。
        const refused = checkOpenTarget(args.target);
        if (refused) return `${REFUSAL_MARKER} ${refused}`;
        return run("open", args.deviceId, { target: args.target.trim() }, `打开：${clip(args.target, 200)}`, 60_000);
      },
    });

  if (enabledAnywhere("clipboard_read"))
    tools.push({
      name: "device_clipboard",
      ref: "devices/clipboard",
      description: "读取或写入用户电脑的剪贴板文字。",
      parameters: schemas.clipboard,
      execute: async (input) => {
        const args = schemas.clipboard.parse(input ?? {});
        return args.action === "read"
          ? run("clipboard_read", args.deviceId, {}, "读取剪贴板", 60_000)
          : run(
              "clipboard_write",
              args.deviceId,
              { text: args.text ?? "" },
              `写入剪贴板：${clip(args.text ?? "", 80)}`,
              60_000,
            );
      },
    });

  // 提示词只挂在 device_list 上：工具被筛掉时提示也跟着消失，不会告诉机器人它没拿到的东西。
  return tools.map((tool) => ({
    ...tool,
    ...(tool.name === "device_list" ? { guidance } : {}),
    initiator: options.initiator,
  }));
}
