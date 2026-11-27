import type { BrowserCompanionState } from "../types/protocol";

/**
 * 页内 HUD 浮层与人机礼让的纯逻辑层（与 DOM 解耦，方便全覆盖单元测试）。
 *
 * 职责：
 * - 管理 CDP 合成输入抑制窗口（避免 CDP 派发的鼠标/键盘/滚轮事件误触发真人礼让）；
 * - 判定浏览器事件是否属于「真人插手」（必须处于 controlling 态、isTrusted === true、
 *   不在合成输入窗口内、且事件目标不在 HUD 宿主内部）；
 * - 管理截屏隐身引用计数（支持嵌套调用而不提前恢复显示）；
 * - 生成规范的简体中文顶部胶囊文案。
 */

export interface HudViewModel {
  visible: boolean;
  hiddenForCapture: boolean;
  state: BrowserCompanionState;
  botName: string;
  botAvatarUrl: string | null;
  stepLabel: string;
  yieldReason: string | null;
}

export interface HudLogicControllerOptions {
  now?: () => number;
}

export function formatHudCapsuleText(model: HudViewModel): {
  title: string;
  subtitle: string;
  showResumeButton: boolean;
} {
  const bot = model.botName.trim() || "ChisaBot";
  if (model.state === "yielded_to_human") {
    return {
      title: `已暂停 · 点击继续交给 ${bot}`,
      subtitle: model.yieldReason?.trim() || "检测到你在操作页面，已自动礼让",
      showResumeButton: true,
    };
  }
  if (model.state === "awaiting_approval") {
    return {
      title: `${bot} · 等待确认`,
      subtitle: model.stepLabel.trim() || "请在侧边栏确认敏感操作",
      showResumeButton: false,
    };
  }
  return {
    title: bot,
    subtitle: model.stepLabel.trim() || "正在查看页面…",
    showResumeButton: false,
  };
}

export function createHudLogicController(
  options: HudLogicControllerOptions = {},
) {
  const now = options.now ?? Date.now;
  let syntheticUntil = 0;
  let captureHideDepth = 0;

  let model: HudViewModel = {
    visible: false,
    hiddenForCapture: false,
    state: "idle",
    botName: "ChisaBot",
    botAvatarUrl: null,
    stepLabel: "",
    yieldReason: null,
  };

  function getModel(): HudViewModel {
    return { ...model };
  }

  function update(patch: {
    state: BrowserCompanionState;
    botName?: string;
    botAvatarUrl?: string | null;
    stepLabel?: string;
    yieldReason?: string | null;
  }): HudViewModel {
    const activeStates = new Set<BrowserCompanionState>([
      "controlling",
      "yielded_to_human",
      "awaiting_approval",
    ]);
    model = {
      ...model,
      state: patch.state,
      visible: activeStates.has(patch.state),
      botName: patch.botName ?? model.botName,
      botAvatarUrl:
        patch.botAvatarUrl !== undefined
          ? patch.botAvatarUrl
          : model.botAvatarUrl,
      stepLabel: patch.stepLabel ?? model.stepLabel,
      yieldReason:
        patch.yieldReason !== undefined ? patch.yieldReason : model.yieldReason,
    };
    return getModel();
  }

  function remove(): HudViewModel {
    syntheticUntil = 0;
    captureHideDepth = 0;
    model = {
      ...model,
      visible: false,
      hiddenForCapture: false,
      state: "detached",
      stepLabel: "",
      yieldReason: null,
    };
    return getModel();
  }

  function markSyntheticWindow(durationMs: number): void {
    const safeDuration = Math.max(0, Math.min(durationMs, 10_000));
    syntheticUntil = Math.max(syntheticUntil, now() + safeDuration);
  }

  function isInSyntheticWindow(): boolean {
    return now() < syntheticUntil;
  }

  /**
   * 判定收到的 DOM 输入事件是否应当触发真人礼让暂停。
   */
  function shouldYieldOnInput(input: {
    isTrusted: boolean;
    fromHudHost: boolean;
  }): boolean {
    if (!model.visible) return false;
    if (model.state !== "controlling") return false;
    if (!input.isTrusted) return false;
    if (input.fromHudHost) return false;
    if (isInSyntheticWindow()) return false;
    return true;
  }

  function hideForCapture(): HudViewModel {
    captureHideDepth += 1;
    model = {
      ...model,
      hiddenForCapture: true,
    };
    return getModel();
  }

  function restoreAfterCapture(): HudViewModel {
    captureHideDepth = Math.max(0, captureHideDepth - 1);
    model = {
      ...model,
      hiddenForCapture: captureHideDepth > 0,
    };
    return getModel();
  }

  return {
    getModel,
    update,
    remove,
    markSyntheticWindow,
    isInSyntheticWindow,
    shouldYieldOnInput,
    hideForCapture,
    restoreAfterCapture,
  };
}

export type HudLogicController = ReturnType<typeof createHudLogicController>;
