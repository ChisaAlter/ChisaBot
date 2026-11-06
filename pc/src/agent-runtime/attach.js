"use strict";
/**
 * 把本地 agent 运行时接到设备节点上（PC 客户端 main.js 和无界面节点 cli.js 共用）：
 * 先建运行时（它通过 agent.sendRaw 回消息），再把 onExtra 交给 createNodeAgent。
 *
 *   const runtime = attachAgentRuntime();             // 在 createNodeAgent 之前
 *   const agent = createNodeAgent({ ..., onExtra: runtime.onExtra });
 *   runtime.bind(agent, { isPaused: () => ... });
 */
const { createAgentRuntime } = require("./index");

function attachAgentRuntime(options = {}) {
  let agent = null;
  let isPaused = options.isPaused || null;
  const runtime = createAgentRuntime({
    send: (message) => (agent ? agent.sendRaw(message) : false),
    log: options.log,
    isPaused: () => (isPaused ? isPaused() : false) || !!(agent && agent.device && agent.device.paused),
  });
  return {
    runtime,
    onExtra: (message) => runtime.handle(message),
    bind(nodeAgent, more = {}) {
      agent = nodeAgent;
      if (more.isPaused) isPaused = more.isPaused;
      nodeAgent.events.on("state", (event) => {
        if (event && event.state === "online") runtime.onOnline();
        if (event && (event.state === "stopped" || event.state === "revoked")) runtime.stopAll();
      });
      // 紧急停止（网页 / 托盘 / 本机）：本地 agent 任务立刻停。
      nodeAgent.events.on("config", (device) => {
        if (device && device.paused) runtime.stopAll();
      });
      return runtime;
    },
  };
}

module.exports = { attachAgentRuntime };
