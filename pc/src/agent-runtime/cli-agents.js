"use strict";
/**
 * 命令行 agent 的启动参数和输出解析（docs/local-agents.md §5）。
 *
 * 档位怎么落到每个 agent 自己的权限模式上：
 * - Claude Code：只读 → --permission-mode plan；工作区 → --permission-mode acceptEdits（改文件直接做，
 *   没预先允许的命令会被它拒绝并在输出里说明）；完全访问或在系统级沙盒里 → --dangerously-skip-permissions
 *   （root 运行时它要求 IS_SANDBOX=1，ChisaCloudCode 踩过）。
 * - Codex CLI：只读 → --sandbox read-only；工作区 → --sandbox workspace-write（联网开关映射到
 *   sandbox_workspace_write.network_access）；完全访问 → --dangerously-bypass-approvals-and-sandbox。
 * - Antigravity CLI 回退：无 agy_acp_server 时通过命令行执行。
 * - 自定义命令（custom）：支持 {{prompt}} / {{workdir}} / {{model}} 占位符或 stdin 传入提示词。
 * - OpenCode / Gemini CLI / Aider 没有可靠的只读模式：服务器只在完全访问、一次性副本或系统级沙盒里交给它们。
 */

function short(value, max = 160) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function describeToolUse(name, input) {
  const i = input || {};
  switch (name) {
    case "Read":
      return `读取 ${i.file_path || i.path || ""}`;
    case "Write":
      return `写入 ${i.file_path || ""}`;
    case "Edit":
    case "MultiEdit":
      return `修改 ${i.file_path || ""}`;
    case "Bash":
      return `运行 ${short(i.command, 120)}`;
    case "Grep":
      return `搜索「${short(i.pattern, 60)}」`;
    case "Glob":
      return `查找文件 ${short(i.pattern, 60)}`;
    case "LS":
      return `列出 ${i.path || ""}`;
    case "TodoWrite":
      return "更新待办清单";
    case "WebFetch":
      return `打开 ${short(i.url, 80)}`;
    case "WebSearch":
      return `搜索网页「${short(i.query, 60)}」`;
    default:
      return `${name} ${short(i, 100)}`;
  }
}

/** Claude Code `--output-format stream-json --verbose` 一行一个 JSON。 */
function claudeParser() {
  let summary = "";
  let isError = false;
  return {
    line(raw, emit) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        if (raw.trim()) emit("text", raw.trim());
        return;
      }
      if (event.type === "system" && event.subtype === "init") {
        emit("status", `Claude Code 已启动${event.model ? `（${event.model}）` : ""}`, "Claude Code 已启动");
      } else if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
        for (const part of event.message.content) {
          if (part.type === "text" && part.text && part.text.trim()) emit("text", part.text.trim());
          else if (part.type === "tool_use") {
            const line = describeToolUse(part.name, part.input);
            emit("tool", line, line);
          }
        }
      } else if (event.type === "result") {
        summary = typeof event.result === "string" ? event.result : summary;
        isError = !!event.is_error || (event.subtype && event.subtype !== "success");
        const cost = typeof event.total_cost_usd === "number" ? ` · 约 $${event.total_cost_usd.toFixed(3)}` : "";
        emit("status", `Claude Code 结束（${event.num_turns ?? "?"} 轮${cost}）`);
      }
    },
    result() {
      return { summary, isError };
    },
  };
}

/** Codex `exec --json`：新旧版本事件格式不同，宽松地取文字和命令。 */
function codexParser() {
  let summary = "";
  let failed = "";
  return {
    line(raw, emit) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        if (raw.trim()) emit("text", raw.trim());
        return;
      }
      const item = event.item || event.msg || event;
      const type = item.type || event.type || "";
      if (/agent_message/.test(type)) {
        const text = item.text || item.message || "";
        if (text && (event.type === "item.completed" || !event.type || event.type === "agent_message" || event.msg)) {
          summary = text;
          emit("text", text.trim());
        }
      } else if (/command_execution|exec_command_begin/.test(type)) {
        if (event.type === "item.completed") return;
        const command = Array.isArray(item.command) ? item.command.join(" ") : item.command || "";
        const line = `运行 ${short(command, 120)}`;
        emit("tool", line, line);
      } else if (/file_change|patch_apply_begin/.test(type)) {
        const files = Array.isArray(item.changes) ? item.changes.map((c) => c.path).join("、") : "";
        const line = `修改文件 ${short(files, 120)}`;
        emit("tool", line, line);
      } else if (/reasoning/.test(type) && item.text) {
        emit("status", short(item.text, 160));
      } else if (/error|turn.failed/.test(type)) {
        failed = item.message || (item.error && item.error.message) || short(item);
        emit("stderr", failed);
      }
    },
    result() {
      return { summary, isError: !!failed && !summary };
    },
  };
}

/** 通用 JSONL 解析器（给自定义命令 outputFormat='jsonl' 使用）。 */
function genericJsonlParser(label = "Custom") {
  let summary = "";
  let isError = false;
  const tail = [];
  return {
    line(raw, emit) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        const clean = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
        if (clean.trim()) {
          tail.push(clean);
          if (tail.length > 40) tail.shift();
          emit("text", clean);
        }
        return;
      }
      if (!event || typeof event !== "object") return;
      if (event.type === "tool" || event.tool) {
        const toolText = String(event.title || event.tool || event.name || "工具操作");
        emit("tool", toolText, toolText);
        return;
      }
      if (event.type === "error" || event.is_error) {
        isError = true;
        emit("stderr", String(event.error || event.message || raw));
        return;
      }
      const text = event.result || event.summary || event.text || event.message || event.content;
      if (typeof text === "string" && text.trim()) {
        summary = text.trim();
        emit("text", summary);
      }
    },
    result() {
      return { summary: summary || tail.join("\n").slice(-4000), isError, label };
    },
  };
}

/** 纯文字输出的 agent：最后 40 行当结果。 */
function textParser(label) {
  const tail = [];
  return {
    line(raw, emit) {
      const text = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
      if (!text.trim()) return;
      tail.push(text);
      if (tail.length > 40) tail.shift();
      emit("text", text);
    },
    result() {
      return { summary: tail.join("\n").slice(-4000), isError: false, label };
    },
  };
}

/**
 * 组装命令。返回 { name, args, env, stdin, parser }；name 是可执行文件名（由调用方换成检测到的路径）。
 */
function buildCommand(
  kind,
  {
    prompt,
    profile,
    skipPermissions,
    network,
    workdir,
    root,
    viaStdin,
    model,
    extraArgs,
    claudeMcpConfigPath,
    codexConfigArgs,
    stdinPrompt,
    outputFormat,
  },
) {
  const extra = Array.isArray(extraArgs) ? extraArgs.map(String).filter((s) => s.length > 0) : [];
  const trimmedModel = typeof model === "string" && model.trim() ? model.trim() : null;

  switch (kind) {
    case "claude": {
      const args = ["-p"];
      if (!viaStdin) args.push(prompt);
      args.push("--output-format", "stream-json", "--verbose");
      if (trimmedModel) args.push("--model", trimmedModel);
      if (claudeMcpConfigPath) args.push("--mcp-config", claudeMcpConfigPath);
      if (skipPermissions) args.push("--dangerously-skip-permissions");
      else if (profile === "readonly") args.push("--permission-mode", "plan");
      else args.push("--permission-mode", "acceptEdits");
      if (extra.length) args.push(...extra);
      const env = root && skipPermissions ? { IS_SANDBOX: "1" } : {};
      return { name: "claude", args, env, stdin: viaStdin ? prompt : null, parser: claudeParser() };
    }
    case "codex": {
      const args = ["exec", "--json", "--skip-git-repo-check", "-C", workdir];
      if (trimmedModel) args.push("-m", trimmedModel);
      if (Array.isArray(codexConfigArgs) && codexConfigArgs.length) args.push(...codexConfigArgs);
      if (skipPermissions && profile === "full") args.push("--dangerously-bypass-approvals-and-sandbox");
      else if (profile === "readonly") args.push("--sandbox", "read-only");
      else {
        args.push("--sandbox", "workspace-write");
        if (network) args.push("-c", "sandbox_workspace_write.network_access=true");
      }
      if (extra.length) args.push(...extra);
      args.push(viaStdin ? "-" : prompt);
      return { name: "codex", args, env: {}, stdin: viaStdin ? prompt : null, parser: codexParser() };
    }
    case "antigravity": {
      const args = ["chat", "-m", prompt];
      if (trimmedModel) args.push("--model", trimmedModel);
      if (extra.length) args.push(...extra);
      return { name: "agy", args, env: {}, stdin: null, parser: textParser("Antigravity") };
    }
    case "opencode": {
      const args = ["run"];
      if (trimmedModel) args.push("-m", trimmedModel);
      if (extra.length) args.push(...extra);
      args.push(prompt);
      return { name: "opencode", args, env: {}, stdin: null, parser: textParser("OpenCode") };
    }
    case "gemini": {
      const args = ["-p", prompt];
      if (trimmedModel) args.push("-m", trimmedModel);
      if (skipPermissions) args.push("--yolo");
      if (extra.length) args.push(...extra);
      return { name: "gemini", args, env: {}, stdin: null, parser: textParser("Gemini CLI") };
    }
    case "aider": {
      const args = ["--message", prompt, "--yes-always", "--no-pretty", "--no-auto-commits", "--no-check-update"];
      if (trimmedModel) args.push("--model", trimmedModel);
      if (extra.length) args.push(...extra);
      return {
        name: "aider",
        args,
        env: {},
        stdin: null,
        parser: textParser("Aider"),
      };
    }
    case "custom": {
      let usedPromptTemplate = false;
      const renderedArgs = extra.map((item) => {
        if (item.includes("{{prompt}}")) usedPromptTemplate = true;
        return item
          .replace(/\{\{prompt\}\}/g, prompt)
          .replace(/\{\{workdir\}\}/g, workdir || "")
          .replace(/\{\{model\}\}/g, trimmedModel || "");
      });
      const useStdin = stdinPrompt !== false && !usedPromptTemplate;
      if (!useStdin && !usedPromptTemplate) {
        renderedArgs.push(prompt);
      }
      return {
        name: "custom",
        args: renderedArgs,
        env: {},
        stdin: useStdin ? prompt : null,
        parser: outputFormat === "jsonl" ? genericJsonlParser("Custom") : textParser("Custom"),
      };
    }
    default:
      throw new Error(`不认识的本地 agent：${kind}`);
  }
}

/** Windows 上 .cmd 要经过 cmd.exe：去掉会被 cmd 解释的字符（提示词走参数时）。claude / codex 走标准输入，不受影响。 */
function cmdSafe(text) {
  return String(text).replace(/[\r\n]+/g, " ").replace(/["%^&|<>]/g, " ");
}

module.exports = {
  buildCommand,
  claudeParser,
  codexParser,
  genericJsonlParser,
  textParser,
  describeToolUse,
  cmdSafe,
};
