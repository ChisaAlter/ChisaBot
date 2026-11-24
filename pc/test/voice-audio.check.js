"use strict";
/**
 * 桌面端实时语音增强（pc/src/voice-audio.js）单测与主进程 / preload 安全接线回归。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const voiceAudio = require("../src/voice-audio");

const SRC_DIR = path.join(__dirname, "..", "src");

function runWebPreload({ protocol, origin, isTopFrame, serverOrigin }) {
  const exposed = new Map();
  const invoked = [];
  const preloadSrc = fs.readFileSync(
    path.join(SRC_DIR, "web-preload.js"),
    "utf8",
  );
  const fakeWindow = {
    addEventListener() {},
  };
  fakeWindow.top = isTopFrame ? fakeWindow : {};
  const context = {
    process: { platform: "win32" },
    location: { protocol, origin },
    window: fakeWindow,
    document: { documentElement: {} },
    MutationObserver: class {
      observe() {}
    },
    setTimeout,
    clearTimeout,
    require(specifier) {
      if (specifier !== "electron") {
        throw new Error(`unexpected require: ${specifier}`);
      }
      return {
        contextBridge: {
          exposeInMainWorld(key, api) {
            exposed.set(key, api);
          },
        },
        ipcRenderer: {
          send() {},
          sendSync(channel) {
            if (channel === "pc:origin") return serverOrigin;
            return "";
          },
          invoke(channel, payload) {
            invoked.push({ channel, payload });
            return Promise.resolve({
              audioProcessing: "native-aec3-v1",
              constraints: { echoCancellation: true },
            });
          },
          on() {},
          removeListener() {},
        },
      };
    },
  };
  vm.runInNewContext(preloadSrc, context, { filename: "web-preload.js" });
  return { exposed, invoked };
}

test("applyDesktopVoiceAudioSwitches enables ChromeWideEchoCancellation on win32/darwin and accepts app.commandLine or app", () => {
  for (const platform of ["win32", "darwin"]) {
    const calls = [];
    const applied = voiceAudio.applyDesktopVoiceAudioSwitches(
      { appendSwitch: (k, v) => calls.push([k, v]) },
      platform,
    );
    assert.deepEqual(applied, ["ChromeWideEchoCancellation"]);
    assert.deepEqual(calls, [
      ["enable-features", "ChromeWideEchoCancellation"],
    ]);
  }

  // 兼容传入 Electron app 对象（读取 app.commandLine）
  const appCalls = [];
  const appliedViaApp = voiceAudio.applyDesktopVoiceAudioSwitches(
    { commandLine: { appendSwitch: (k, v) => appCalls.push([k, v]) } },
    "win32",
  );
  assert.deepEqual(appliedViaApp, ["ChromeWideEchoCancellation"]);
  assert.deepEqual(appCalls, [
    ["enable-features", "ChromeWideEchoCancellation"],
  ]);

  // Linux 不注入 Windows/macOS 专用硬件 AEC3 开关
  const linuxCalls = [];
  assert.deepEqual(
    voiceAudio.applyDesktopVoiceAudioSwitches(
      { appendSwitch: (k, v) => linuxCalls.push([k, v]) },
      "linux",
    ),
    [],
  );
  assert.deepEqual(linuxCalls, []);

  // 无效参数安全降级为空数组
  assert.deepEqual(
    voiceAudio.applyDesktopVoiceAudioSwitches(null, "win32"),
    [],
  );
  assert.deepEqual(voiceAudio.applyDesktopVoiceAudioSwitches({}, "win32"), []);
});

test("registerVoiceAudioIpc stays fail-closed by default and honors verifySender", () => {
  const handlers = new Map();
  const fakeIpc = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
  };

  voiceAudio.registerVoiceAudioIpc(fakeIpc);
  const failClosed = handlers.get("voice-audio:preferred-constraints");
  assert.equal(typeof failClosed, "function");
  assert.throws(() => failClosed({ sender: "any" }), /未授权/);

  voiceAudio.registerVoiceAudioIpc(fakeIpc, {
    platform: "darwin",
    verifySender: (event) => event?.trusted === true,
    getPreferredDeviceId: () => "mic-studio",
  });
  const guarded = handlers.get("voice-audio:preferred-constraints");
  assert.throws(() => guarded({ trusted: false }), /未授权/);
  const result = guarded({ trusted: true });
  assert.equal(result.audioProcessing, "native-aec3-v1");
  assert.equal(result.platform, "darwin");
  assert.equal(result.sampleRate, voiceAudio.VOICE_SAMPLE_RATE);
  assert.deepEqual(result.constraints.deviceId, { exact: "mic-studio" });
});

test("main.js wires voice-audio switches before app.whenReady() and registers IPC with fromServerPage", () => {
  const mainSrc = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");
  const switchIdx = mainSrc.indexOf(
    "voiceAudio.applyDesktopVoiceAudioSwitches(app.commandLine)",
  );
  const readyIdx = mainSrc.indexOf("app.whenReady().then(");
  assert.ok(
    switchIdx > 0,
    "main.js must invoke applyDesktopVoiceAudioSwitches",
  );
  assert.ok(readyIdx > 0, "main.js must contain app.whenReady()");
  assert.ok(
    switchIdx < readyIdx,
    "applyDesktopVoiceAudioSwitches must execute before app.whenReady()",
  );

  const registerIpcIdx = mainSrc.indexOf("function registerIpc()");
  assert.ok(registerIpcIdx > 0);
  const registerSnippet = mainSrc.slice(registerIpcIdx, readyIdx);
  assert.match(
    registerSnippet,
    /voiceAudio\.registerVoiceAudioIpc\(ipcMain,\s*\{\s*verifySender:\s*fromServerPage,?\s*\}\)/,
    "registerVoiceAudioIpc must be wired inside registerIpc() with verifySender: fromServerPage",
  );
});

test("web-preload.js exposes chisabotVoiceAudio only on trusted top-level server pages", async () => {
  // 1. 已登录服务器的顶层页面 -> 暴露并转发到 voice-audio:preferred-constraints
  const trusted = runWebPreload({
    protocol: "https:",
    origin: "https://chat.example.com",
    isTopFrame: true,
    serverOrigin: "https://chat.example.com",
  });
  const api = trusted.exposed.get("chisabotVoiceAudio");
  assert.ok(api && typeof api.getPreferredConstraints === "function");
  const hint = await api.getPreferredConstraints();
  assert.equal(hint.audioProcessing, "native-aec3-v1");
  assert.deepEqual(trusted.invoked, [
    { channel: "voice-audio:preferred-constraints", payload: undefined },
  ]);

  // 2. 本机离线页（file://）-> 不暴露 chisabotVoiceAudio
  const localPage = runWebPreload({
    protocol: "file:",
    origin: "null",
    isTopFrame: true,
    serverOrigin: "https://chat.example.com",
  });
  assert.equal(localPage.exposed.has("chisabotVoiceAudio"), false);

  // 3. 第三方跨源页面 -> 不暴露 chisabotVoiceAudio
  const foreignPage = runWebPreload({
    protocol: "https:",
    origin: "https://evil.example.com",
    isTopFrame: true,
    serverOrigin: "https://chat.example.com",
  });
  assert.equal(foreignPage.exposed.has("chisabotVoiceAudio"), false);

  // 4. 同源子 iframe -> 不暴露 chisabotVoiceAudio
  const subFrame = runWebPreload({
    protocol: "https:",
    origin: "https://chat.example.com",
    isTopFrame: false,
    serverOrigin: "https://chat.example.com",
  });
  assert.equal(subFrame.exposed.has("chisabotVoiceAudio"), false);
});
