"use strict";
/**
 * ChisaBot 内置 agent 循环，在电脑上跑（docs/local-agents.md §6）。
 *
 * 工具（读 / 写 / 改文件、搜索、运行命令）在这台电脑上执行，不经过服务器一步一步转发；模型调用二选一：
 * - server（默认）：每一步把对话发给服务器，服务器用你给这个机器人配置的模型代调（密钥不出服务器）；
 * - local：直接调电脑上的 OpenAI 兼容模型（Ollama、LM Studio…），对话和文件内容都不出这台电脑。
 * 档位之外的工具调用先向服务器要审批（网页 / 手机的审批卡片），拒绝就告诉模型。
 * 工具定义和 shared/local-agents.ts 的 BUILTIN_TOOLS 一致。
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { builtinToolGate, isInside, real } = require("./profile");
const { wrap } = require("./sandbox");

const OUTPUT_CAP = 30_000;
const MAX_STEPS = 40;

const TOOLS = [
  { name: "list_files", description: "列出目录（相对工作目录，默认工作目录本身）。", parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } },
  {
    name: "read_file",
    description: "读取文本文件。offset/limit 按行（从 1 开始），默认读前 400 行。",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "新建或整个覆盖一个文件。",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  },
  {
    name: "edit_file",
    description: "把文件里的 old_string 换成 new_string（old_string 必须唯一，除非 replace_all）。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "在工作目录里按正则搜索文件内容（跳过 .git、node_modules），最多 200 条。glob 例如 *.ts。",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "run",
    description: "在工作目录里运行一条命令（Windows 是 PowerShell，其它是 sh），默认 120 秒超时。",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_sec: { type: "integer" } }, required: ["command"], additionalProperties: false },
  },
];

function clip(text, max = OUTPUT_CAP) {
  return text.length > max ? `${text.slice(0, max)}\n…（输出太长，后面省略 ${text.length - max} 字）` : text;
}

/** 一次性副本：原文件夹（ctx.origin）下的绝对路径改写成副本（ctx.workdir）里的同一位置。 */
function mapIntoCopy(args, ctx) {
  if (!ctx.disposable || !ctx.origin || !args) return args;
  // 命令里写了原文件夹的路径（cd /原文件夹 && …）：换成副本的路径。
  if (typeof args.command === "string" && args.command.includes(ctx.origin)) {
    return { ...args, command: args.command.split(ctx.origin).join(ctx.workdir) };
  }
  if (typeof args.path !== "string" || !path.isAbsolute(args.path)) return args;
  const win = process.platform === "win32";
  const norm = (p) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));
  const origin = norm(ctx.origin);
  const target = norm(args.path);
  if (target !== origin && !target.startsWith(origin.endsWith(path.sep) ? origin : origin + path.sep)) return args;
  return { ...args, path: path.join(ctx.workdir, path.relative(origin, target)) };
}

function resolveIn(workdir, p, ctx) {
  const resolved = path.resolve(workdir, String(p || "."));
  if (ctx && ctx.disposable && !isInside(resolved, [workdir])) {
    throw new Error(`路径不能跳出工作目录：${p}`);
  }
  return real(resolved);
}

function globToRegex(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/\u0000/g, ".*");
  return new RegExp(`(^|/)${escaped}$`);
}

async function search(workdir, args) {
  let regex;
  try {
    regex = new RegExp(String(args.pattern), "i");
  } catch (error) {
    return `正则写错了：${error.message}`;
  }
  const filter = args.glob ? globToRegex(args.glob) : null;
  const start = resolveIn(workdir, args.path);
  const hits = [];
  const stack = [start];
  let scanned = 0;
  while (stack.length && hits.length < 200 && scanned < 20_000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const rel = path.relative(workdir, full).replace(/\\/g, "/");
        if (filter && !filter.test(rel)) continue;
        scanned++;
        let text;
        try {
          const stat = await fsp.stat(full);
          if (stat.size > 1_000_000) continue;
          text = await fsp.readFile(full, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < 200; i++) if (regex.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 240)}`);
      }
    }
  }
  return hits.length ? hits.join("\n") : "没有找到。";
}

function runCommand(command, { workdir, timeoutSec, signal, isolation, network, containerImage }) {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    let file;
    let args;
    if (isolation === "docker" || isolation === "podman") ({ file, args } = wrap({ isolation, workdir, network, file: "sh", args: ["-c", command], containerImage }));
    else if (win) {
      file = "powershell.exe";
      const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" + command;
      args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
      if (isolation === "wsl") ({ file, args } = wrap({ isolation, workdir, network, file: "sh", args: ["-c", command] }));
    } else ({ file, args } = wrap({ isolation, workdir, network, file: "/bin/sh", args: ["-c", command] }));
    let out = "";
    let child;
    try {
      child = spawn(file, args, { cwd: workdir, windowsHide: true, detached: !win, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve(`无法运行：${error.message}`);
      return;
    }
    const kill = () => {
      try {
        if (win) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      out += `\n（超过 ${timeoutSec} 秒，已停止）`;
      kill();
    }, timeoutSec * 1000);
    const onAbort = () => kill();
    signal.addEventListener("abort", onAbort, { once: true });
    const take = (d) => {
      if (out.length < OUTPUT_CAP * 2) out += d;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(`无法运行：${error.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(clip(`${out}\n（退出码 ${code}）`.trim()));
    });
  });
}

async function executeTool(name, args, ctx) {
  const workdir = ctx.workdir;
  switch (name) {
    case "list_files": {
      const dir = resolveIn(workdir, args.path, ctx);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries
        .slice(0, 500)
        .map((e) => `${e.isDirectory() ? "[目录] " : ""}${e.name}`)
        .join("\n") || "（空目录）";
    }
    case "read_file": {
      const file = resolveIn(workdir, args.path, ctx);
      const text = await fsp.readFile(file, "utf8");
      const lines = text.split(/\r?\n/);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 400));
      const slice = lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${offset + i}\t${l}`);
      return clip(`${slice.join("\n")}${offset - 1 + limit < lines.length ? `\n…（共 ${lines.length} 行）` : ""}`);
    }
    case "write_file": {
      const file = resolveIn(workdir, args.path, ctx);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, String(args.content ?? ""), "utf8");
      return `已写入 ${path.relative(workdir, file) || file}（${Buffer.byteLength(String(args.content ?? ""))} 字节）`;
    }
    case "edit_file": {
      const file = resolveIn(workdir, args.path, ctx);
      const text = await fsp.readFile(file, "utf8");
      let oldString = String(args.old_string ?? "");
      let newString = String(args.new_string ?? "");
      if (!oldString) return "old_string 不能为空。";
      if (text.includes("\r\n") && !text.includes(oldString) && !oldString.includes("\r\n")) {
        oldString = oldString.replace(/\n/g, "\r\n");
        newString = newString.replace(/\r?\n/g, "\r\n");
      }
      const count = text.split(oldString).length - 1;
      if (count === 0) return "没有找到 old_string（要和文件内容逐字一致，包括缩进）。";
      if (count > 1 && !args.replace_all) return `old_string 出现了 ${count} 次，请给更多上下文让它唯一，或用 replace_all。`;
      const next = args.replace_all ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
      await fsp.writeFile(file, next, "utf8");
      return `已修改 ${path.relative(workdir, file)}（${args.replace_all ? count : 1} 处）`;
    }
    case "search":
      return search(workdir, args);
    case "run":
      return runCommand(String(args.command || ""), {
        workdir,
        timeoutSec: Math.min(600, Math.max(1, Number(args.timeout_sec) || 120)),
        signal: ctx.signal,
        isolation: ctx.isolation,
        network: ctx.network,
        containerImage: ctx.containerImage,
      });
    default:
      return `没有这个工具：${name}`;
  }
}

function describe(name, args) {
  switch (name) {
    case "list_files":
      return `列出 ${args.path || "."}`;
    case "read_file":
      return `读取 ${args.path}`;
    case "write_file":
      return `写入 ${args.path}`;
    case "edit_file":
      return `修改 ${args.path}`;
    case "search":
      return `搜索「${String(args.pattern).slice(0, 60)}」`;
    case "run":
      return `运行 ${String(args.command).replace(/\s+/g, " ").slice(0, 120)}`;
    default:
      return name;
  }
}

/** 直接调电脑上的 OpenAI 兼容模型。 */
async function localModel({ baseUrl, model }, system, messages, signal) {
  const toOpenAi = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") toOpenAi.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      const text = m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const calls = m.content.filter((p) => p.type === "tool-call").map((p) => ({ id: p.toolCallId, type: "function", function: { name: p.toolName, arguments: p.input || "{}" } }));
      toOpenAi.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === "tool") toOpenAi.push({ role: "tool", tool_call_id: m.toolCallId, content: m.output });
  }
  const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: toOpenAi,
      tools: TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    }),
    signal,
  });
  if (!response.ok) throw new Error(`本地模型返回 ${response.status}：${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  const message = body.choices && body.choices[0] && body.choices[0].message;
  if (!message) throw new Error("本地模型没有返回内容。");
  const content = [];
  if (message.content) content.push({ type: "text", text: String(message.content) });
  for (const call of message.tool_calls || []) content.push({ type: "tool-call", toolCallId: call.id || `call_${content.length}`, toolName: call.function.name, input: call.function.arguments || "{}" });
  return content;
}

function systemPrompt(ctx) {
  return [
    "你是 ChisaBot 的本地 agent，正在用户自己的电脑上替云端机器人完成一件事。用工具读写文件、搜索、运行命令，做完用中文写一段简短的结果（做了什么、改了哪些文件、还有什么没做）。",
    `工作目录：${ctx.workdir}（相对路径都相对它）。系统：${process.platform}。`,
    `权限档位：${ctx.profile === "readonly" ? "只读——不要改文件、不要运行会改东西的命令" : ctx.profile === "workspace" ? "工作区——只改工作目录里的文件" : "完全访问"}。档位之外的操作会先请用户批准，被拒绝就换别的办法或说明。`,
    ctx.disposable
      ? `你在一次性副本里工作（原文件夹 ${ctx.origin || "?"} 的副本就是工作目录）：只用相对路径或工作目录里的路径，不要 cd 到原文件夹；改动要用户确认后才会合回原文件夹，放心改，但只改和任务有关的。`
      : "你直接在用户的文件夹里工作，改动立即生效，谨慎。",
    ctx.network ? "" : "这台电脑的这个任务不能联网（命令访问网络会失败）。",
    "不要输出密钥、密码。不要一次读很大的文件，用 search 和 read_file 的 offset/limit。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 跑一次内置循环。
 * ctx: { workdir, profile, roots, isolation, network, containerImage, disposable, signal, prompt,
 *        model: (messages, system) => Promise<content[]>, approve: (operation, summary) => Promise<boolean>, emit(kind, text, step) }
 */
async function runBuiltin(ctx) {
  const messages = [{ role: "user", text: ctx.prompt }];
  const system = systemPrompt(ctx);
  let finalText = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    if (ctx.signal.aborted) throw new Error("已停止");
    const content = await ctx.model(messages, system);
    messages.push({ role: "assistant", content });
    const texts = content.filter((p) => p.type === "text" && p.text && p.text.trim()).map((p) => p.text.trim());
    for (const text of texts) ctx.emit("text", text);
    const calls = content.filter((p) => p.type === "tool-call");
    if (!calls.length) {
      finalText = texts.join("\n\n");
      return { summary: finalText || "（做完了，没有写结果。）", steps: step + 1 };
    }
    for (const call of calls) {
      if (ctx.signal.aborted) throw new Error("已停止");
      let args = {};
      try {
        args = JSON.parse(call.input || "{}");
      } catch {
        messages.push({ role: "tool", toolCallId: call.toolCallId, toolName: call.toolName, output: "参数不是合法的 JSON。" });
        continue;
      }
      // 一次性副本里：模型常按原文件夹的绝对路径写（任务里就是这么说的）——换成副本里的同一个位置，
      // 免得绕过「应用改动」直接改了原文件夹（2026-10-15 e2e 里真的发生过）。
      args = mapIntoCopy(args, ctx);
      const line = describe(call.toolName, args);
      ctx.emit("tool", line, line);
      const reason = builtinToolGate(ctx.profile, call.toolName, args, ctx);
      if (reason) {
        ctx.emit("approval", `需要你批准：${line}（${reason}）`, "等待你批准");
        const approved = await ctx.approve(call.toolName === "run" ? "shell" : "write_file", `${line}（${reason}）`);
        if (!approved) {
          ctx.emit("status", "你没有批准这一步，agent 会换别的办法");
          messages.push({ role: "tool", toolCallId: call.toolCallId, toolName: call.toolName, output: "用户没有批准这一步（档位之外）。不要再试同样的操作，换别的办法或在结果里说明。" });
          continue;
        }
      }
      let output;
      try {
        output = await executeTool(call.toolName, args, ctx);
      } catch (error) {
        output = `失败：${error && error.message ? error.message : String(error)}`;
      }
      messages.push({ role: "tool", toolCallId: call.toolCallId, toolName: call.toolName, output: clip(String(output)) });
    }
  }
  return { summary: `${finalText || "步骤用完了（最多 40 步），没有做完。"}`, steps: MAX_STEPS, incomplete: true };
}

module.exports = { runBuiltin, executeTool, localModel, TOOLS, describe, systemPrompt, mapIntoCopy };
