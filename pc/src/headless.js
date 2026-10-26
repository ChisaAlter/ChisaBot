#!/usr/bin/env node
"use strict";
/**
 * chisabot-node：服务器 / 无桌面电脑上的 ChisaBot 设备节点（docs/pc-node.md §14）。
 * 和 PC 客户端同一套 agent 代码（agent/core.js + agent/ops.js + agent/code-ops.js），同一个协议，
 * 只是没有窗口：命令行是 bash / zsh（Windows 上 PowerShell），没有截图 / 鼠标键盘（除非有 X 显示和 xdotool）。
 *
 *   node chisabot-node.cjs pair --server https://host:8443 --code cbp_xxx [--name 名称] [--dir DIR] [--no-full-access]
 *   node chisabot-node.cjs run [--dir DIR]
 *   node chisabot-node.cjs install-service [--dir DIR] [--node /path/to/node]    （systemd / launchd）
 *   node chisabot-node.cjs uninstall-service [--dir DIR]
 *   node chisabot-node.cjs status [--dir DIR]
 *   node chisabot-node.cjs logout [--dir DIR]      （作废令牌并删除配置）
 *
 * 配置 DIR/config.json（权限 600）：{ server, token, name, allowFullAccess }。
 * allowFullAccess = 网页上为这台机器打开「完全访问」时本机是否接受（默认接受；安装时 --no-full-access 关掉，
 * 之后网页即使打开也会被本机立刻关回去）。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createNodeAgent } = require("./agent/core");
const { createOps } = require("./agent/ops");
const { attachAgentRuntime } = require("./agent-runtime/attach");
const auth = require("./agent/auth");

const VERSION = typeof __CHISABOT_NODE_VERSION__ !== "undefined" ? __CHISABOT_NODE_VERSION__ : require("../package.json").version; // eslint-disable-line no-undef
const SERVICE = "chisabot-node";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function defaultDir() {
  if (process.env.CHISABOT_NODE_DIR) return process.env.CHISABOT_NODE_DIR;
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  return uid === 0 ? "/opt/chisabot-node" : path.join(os.homedir(), ".chisabot-node");
}

function configPath(dir) {
  return path.join(dir, "config.json");
}

function readConfig(dir) {
  try {
    return JSON.parse(fs.readFileSync(configPath(dir), "utf8"));
  } catch {
    return null;
  }
}

function writeConfig(dir, config) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath(dir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function clientInfo(name) {
  return {
    clientVersion: `${VERSION}-node`,
    platform: process.platform,
    osVersion: osVersion(),
    hostname: os.hostname(),
    arch: os.arch(),
    ...(name ? { name } : {}),
  };
}

function osVersion() {
  try {
    if (process.platform === "linux" && fs.existsSync("/etc/os-release")) {
      const text = fs.readFileSync("/etc/os-release", "utf8");
      const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text);
      if (pretty) return `${pretty[1]} (${os.release()})`;
    }
    if (process.platform === "darwin") {
      const r = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
      if (r.status === 0) return `macOS ${r.stdout.trim()}`;
    }
  } catch {}
  return `${os.type()} ${os.release()}`;
}

async function pair(dir) {
  const server = auth.normalizeServerUrl(arg("server"));
  const code = arg("code");
  if (!code) throw new Error("缺少 --code");
  const name = arg("name", os.hostname());
  const response = await fetch(`${server}/api/devices/agent/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: server, "User-Agent": `chisabot-node/${VERSION}` },
    body: JSON.stringify({ code, ...clientInfo(name) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) throw new Error(body.error || `配对失败（HTTP ${response.status}）`);
  const previous = readConfig(dir);
  if (previous && previous.token && previous.server) {
    // 重新安装：作废旧令牌（失败也不要紧，网页上能撤销）
    await auth.unenroll({ serverUrl: previous.server, token: previous.token }).catch(() => false);
  }
  writeConfig(dir, { server, token: body.token, name: body.device?.name || name, deviceId: body.device?.id, allowFullAccess: !flag("no-full-access") });
  console.log(`已登记为「${body.device?.name || name}」（${body.device?.id}），配置在 ${configPath(dir)}`);
}

function run(dir) {
  const config = readConfig(dir);
  if (!config || !config.token || !config.server) {
    console.error(`没有配置（${configPath(dir)}）。先运行安装命令或 pair。`);
    process.exit(2);
  }
  const ops = createOps({ clientVersion: `${VERSION}-node` });
  // 本地 agent（Claude Code / Codex / 内置循环…，docs/local-agents.md）：和节点共用这条连接。
  const agentRuntime = attachAgentRuntime({ log: (line) => console.log(new Date().toISOString(), `[本地 agent] ${line}`) });
  const agent = createNodeAgent({
    onExtra: agentRuntime.onExtra,
    serverUrl: config.server,
    getToken: () => config.token,
    ops,
    clientInfo: clientInfo(),
    allowFullAccess: config.allowFullAccess !== false,
    unrefTimers: false,
  });
  agentRuntime.bind(agent);
  const log = (...parts) => console.log(new Date().toISOString(), ...parts);
  agent.events.on("state", ({ state, detail }) => log(`[状态] ${state}${detail ? `（${detail}）` : ""}`));
  agent.events.on("config", (device) =>
    log(`[配置] ${device.name} paused=${device.paused} fullAccess=${!!device.fullAccess} roots=${JSON.stringify(device.allowedRoots)}`),
  );
  agent.events.on("full_access", (e) => log(`[完全访问] ${e.on ? "已生效" : e.expired ? "已到期" : "已关闭"}`));
  agent.events.on("audit", (entry) => log(`[审计] ${entry.actor} ${entry.operation} ${entry.outcome} ${entry.summary || ""}${entry.detail ? ` — ${String(entry.detail).slice(0, 200)}` : ""}`));
  agent.events.on("revoked", () => {
    log("[撤销] 设备已在网页上被撤销，节点退出。重新安装请在网页上生成新的安装命令。");
    ops.stopAll?.("revoked");
    // 退出码 0：systemd Restart=on-failure 不会再拉起
    process.exit(0);
  });
  agent.events.on("error", (error) => log(`[错误] ${error.message}`));
  agent.start();
  const stop = () => {
    ops.stopAll?.("shutdown");
    agentRuntime.runtime.stopAll?.();
    agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log(`chisabot-node ${VERSION} 启动，服务器 ${config.server}`);
}

function installService(dir) {
  const node = arg("node", process.execPath);
  const script = path.resolve(process.argv[1]);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (process.platform === "linux") {
    if (!fs.existsSync("/run/systemd/system")) {
      console.log(`这台机器没有 systemd。手动运行（可放进 crontab @reboot 或 supervisord）：\n  ${node} ${script} run --dir ${dir}`);
      return;
    }
    const unit = `[Unit]
Description=ChisaBot device node
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${node} ${script} run --dir ${dir}
Restart=on-failure
RestartSec=5
Environment=CHISABOT_NODE_DIR=${dir}
${uid === 0 ? "User=root\n" : ""}
[Install]
WantedBy=${uid === 0 ? "multi-user.target" : "default.target"}
`;
    if (uid === 0) {
      fs.writeFileSync(`/etc/systemd/system/${SERVICE}.service`, unit);
      spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
      spawnSync("systemctl", ["enable", "--now", SERVICE], { stdio: "inherit" });
      spawnSync("systemctl", ["restart", SERVICE], { stdio: "inherit" });
      console.log(`已安装系统服务 ${SERVICE}（systemctl status ${SERVICE}；日志 journalctl -u ${SERVICE} -f）`);
    } else {
      const unitDir = path.join(os.homedir(), ".config/systemd/user");
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(path.join(unitDir, `${SERVICE}.service`), unit);
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
      spawnSync("systemctl", ["--user", "enable", "--now", SERVICE], { stdio: "inherit" });
      spawnSync("systemctl", ["--user", "restart", SERVICE], { stdio: "inherit" });
      const linger = spawnSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "ignore" });
      console.log(`已安装用户服务 ${SERVICE}（systemctl --user status ${SERVICE}）。${linger.status === 0 ? "已开启 linger：退出登录后也会继续运行。" : "提示：要在退出登录后继续运行，请让管理员执行 loginctl enable-linger " + os.userInfo().username}`);
    }
    return;
  }
  if (process.platform === "darwin") {
    const label = "cn.ayase.chisabot.node";
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${node}</string><string>${script}</string><string>run</string><string>--dir</string><string>${dir}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${dir}/node.log</string>
<key>StandardErrorPath</key><string>${dir}/node.log</string>
</dict></plist>
`;
    const target = uid === 0 ? `/Library/LaunchDaemons/${label}.plist` : path.join(os.homedir(), `Library/LaunchAgents/${label}.plist`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    spawnSync("launchctl", ["unload", target], { stdio: "ignore" });
    fs.writeFileSync(target, plist);
    spawnSync("launchctl", ["load", "-w", target], { stdio: "inherit" });
    console.log(`已安装 launchd 服务 ${label}（日志 ${dir}/node.log）`);
    return;
  }
  console.log(`这个系统不支持自动安装服务。手动运行：${node} ${script} run --dir ${dir}`);
}

function uninstallService() {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (process.platform === "linux") {
    const user = uid === 0 ? [] : ["--user"];
    spawnSync("systemctl", [...user, "disable", "--now", SERVICE], { stdio: "inherit" });
    const file = uid === 0 ? `/etc/systemd/system/${SERVICE}.service` : path.join(os.homedir(), `.config/systemd/user/${SERVICE}.service`);
    fs.rmSync(file, { force: true });
    spawnSync("systemctl", [...user, "daemon-reload"], { stdio: "ignore" });
  } else if (process.platform === "darwin") {
    const label = "cn.ayase.chisabot.node";
    const target = uid === 0 ? `/Library/LaunchDaemons/${label}.plist` : path.join(os.homedir(), `Library/LaunchAgents/${label}.plist`);
    spawnSync("launchctl", ["unload", target], { stdio: "inherit" });
    fs.rmSync(target, { force: true });
  }
  console.log("服务已移除。");
}

async function main() {
  const command = process.argv[2];
  const dir = path.resolve(arg("dir", defaultDir()));
  switch (command) {
    case "pair":
      return pair(dir);
    case "run":
      return run(dir);
    case "install-service":
      return installService(dir);
    case "uninstall-service":
      return uninstallService(dir);
    case "status": {
      const config = readConfig(dir);
      console.log(config ? JSON.stringify({ server: config.server, name: config.name, deviceId: config.deviceId, allowFullAccess: config.allowFullAccess !== false, version: VERSION }, null, 2) : "未配置");
      return;
    }
    case "logout": {
      const config = readConfig(dir);
      if (config && config.token) console.log((await auth.unenroll({ serverUrl: config.server, token: config.token })) ? "已作废令牌" : "作废令牌失败（可以在网页上撤销）");
      fs.rmSync(configPath(dir), { force: true });
      return;
    }
    case "version":
    case "--version":
      console.log(VERSION);
      return;
    default:
      console.log("用法：chisabot-node pair|run|install-service|uninstall-service|status|logout [--dir DIR]");
      process.exit(2);
  }
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
