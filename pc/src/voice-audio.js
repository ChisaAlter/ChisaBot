"use strict";
/**
 * ChisaBot Electron 桌面端实时语音通话音频增强钩子：
 * - 提供硬件回声消除（AEC3 / ChromeWideEchoCancellation）启动开关与首选约束生成；
 * - 提供系统音频输入/输出设备枚举与规范化；
 * - 提供面向 `ipcMain` 的注册入口，供受控窗口按同源策略透传首选采集约束。
 */

const VOICE_SAMPLE_RATE = 24_000;
const HARDWARE_AEC3_PLATFORMS = new Set(["win32", "darwin"]);

/** 判断当前桌面平台是否优先协商硬件级回声消除能力。 */
function detectDesktopAudioProcessing(platform = process.platform) {
  return HARDWARE_AEC3_PLATFORMS.has(platform)
    ? "native-aec3-v1"
    : "web-aec-v1";
}

/**
 * 为 Electron 主进程附加 Chromium 音频处理开关（需在 `app.whenReady()` 前调用）。
 * 启用 ChromeWideEchoCancellation 以在系统混音层消除扬声器回声。
 */
function applyDesktopVoiceAudioSwitches(
  commandLine,
  platform = process.platform,
) {
  if (!commandLine || typeof commandLine.appendSwitch !== "function") {
    return [];
  }
  const applied = [];
  if (HARDWARE_AEC3_PLATFORMS.has(platform)) {
    commandLine.appendSwitch("enable-features", "ChromeWideEchoCancellation");
    applied.push("ChromeWideEchoCancellation");
  }
  return applied;
}

/** 生成传给渲染进程 `getUserMedia({ audio })` 的硬件回声消除首选约束。 */
function buildPreferredVoiceConstraints(options = {}) {
  const platform = options.platform ?? process.platform;
  const audioProcessing = detectDesktopAudioProcessing(platform);
  const constraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: { ideal: VOICE_SAMPLE_RATE },
  };
  if (typeof options.deviceId === "string" && options.deviceId.trim()) {
    constraints.deviceId = { exact: options.deviceId.trim() };
  }
  return {
    audioProcessing,
    platform,
    sampleRate: VOICE_SAMPLE_RATE,
    constraints,
  };
}

/** 规范化并过滤音频设备列表，供桌面端麦克风与扬声器切换使用。 */
function normalizeAudioDeviceList(rawDevices) {
  if (!Array.isArray(rawDevices)) {
    return { inputs: [], outputs: [] };
  }
  const inputs = [];
  const outputs = [];
  for (const item of rawDevices) {
    if (!item || typeof item !== "object") continue;
    const kind = item.kind;
    if (kind !== "audioinput" && kind !== "audiooutput") continue;
    const deviceId = typeof item.deviceId === "string" ? item.deviceId : "";
    const groupId = typeof item.groupId === "string" ? item.groupId : "";
    const label =
      typeof item.label === "string" && item.label.trim()
        ? item.label.trim()
        : kind === "audioinput"
          ? "默认麦克风"
          : "默认扬声器";
    const normalized = {
      deviceId,
      groupId,
      kind,
      label,
      isDefault: deviceId === "default" || deviceId === "communications",
    };
    if (kind === "audioinput") {
      inputs.push(normalized);
    } else {
      outputs.push(normalized);
    }
  }
  return { inputs, outputs };
}

/** 从浏览器或渲染进程的 `navigator.mediaDevices` 枚举系统音频输入/输出设备。 */
async function enumerateAudioDevices(mediaDevices) {
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== "function") {
    return { inputs: [], outputs: [] };
  }
  const raw = await mediaDevices.enumerateDevices();
  return normalizeAudioDeviceList(raw);
}

/**
 * 向 Electron `ipcMain` 注册实时语音通话音频约束查询通道。
 * 调用方可传入 `verifySender(event)` 以校验来源窗口与服务器 Origin。
 */
function registerVoiceAudioIpc(ipcMain, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") return;
  // 默认 fail-closed：要求调用方显式传入来源窗口与 Origin 校验器，严禁未校验直接放行。
  const verifySender =
    typeof options.verifySender === "function"
      ? options.verifySender
      : () => false;
  const getPreferredDeviceId =
    typeof options.getPreferredDeviceId === "function"
      ? options.getPreferredDeviceId
      : () => undefined;

  ipcMain.handle("voice-audio:preferred-constraints", (event) => {
    if (!verifySender(event)) {
      throw new Error("未授权的语音音频配置查询。");
    }
    const deviceId = getPreferredDeviceId();
    return buildPreferredVoiceConstraints({
      platform: options.platform ?? process.platform,
      ...(deviceId ? { deviceId } : {}),
    });
  });
}

module.exports = {
  VOICE_SAMPLE_RATE,
  detectDesktopAudioProcessing,
  applyDesktopVoiceAudioSwitches,
  buildPreferredVoiceConstraints,
  normalizeAudioDeviceList,
  enumerateAudioDevices,
  registerVoiceAudioIpc,
};
