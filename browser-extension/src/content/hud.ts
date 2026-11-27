import type { HudInboundMessage, HudOutboundMessage } from "../types/protocol";
import {
  createHudLogicController,
  formatHudCapsuleText,
  type HudViewModel,
} from "./hud-logic";

/**
 * 页内 HUD 浮层与真人礼让 Content Script（使用 Closed Shadow DOM 彻底隔离宿主样式）。
 *
 * 视觉与交互：
 * - 四周蓝色呼吸内发光边框（pointer-events: none，最高 z-index，绝不阻挡原页交互）；
 * - 顶部居中深色磨砂圆角胶囊：[Bot 圆形头像] <Bot名>  <当前动作文案>  ×；
 * - 真人在非 CDP 合成窗口内点击 / 按键 / 滚轮时自动通知后台进入「礼让暂停」，
 *   胶囊切换为「已暂停 · 点击继续交给 <Bot名>」；
 * - 点击 × 立即通知后台中止当前回合、detach CDP 并移除 HUD；
 * - 响应 HUD_HIDE_FOR_CAPTURE / HUD_RESTORE_AFTER_CAPTURE 瞬时隐身保证后台截图零遮挡。
 */

const HUD_MOUNT_FLAG = "__CHISABOT_COMPANION_HUD_INSTALLED__";
const HOST_ID = "chisabot-companion-hud-root";

const HUD_STYLES = `
:host {
  all: initial;
}

.cb-hud-layer {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  font-family: "Inter Variable", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", system-ui, -apple-system, sans-serif;
  transition: opacity 140ms ease;
}

.cb-hud-layer[data-hidden="true"] {
  opacity: 0;
  visibility: hidden;
}

.cb-hud-glow {
  position: fixed;
  inset: 0;
  pointer-events: none;
  box-sizing: border-box;
  border: 2px solid rgba(59, 130, 246, 0.72);
  box-shadow:
    inset 0 0 22px 4px rgba(59, 130, 246, 0.34),
    inset 0 0 56px 8px rgba(37, 99, 235, 0.18);
  animation: cb-hud-breathe 2.6s ease-in-out infinite;
}

.cb-hud-layer[data-state="yielded_to_human"] .cb-hud-glow {
  border-color: rgba(245, 158, 11, 0.78);
  box-shadow:
    inset 0 0 20px 3px rgba(245, 158, 11, 0.28),
    inset 0 0 46px 6px rgba(217, 119, 6, 0.14);
  animation: none;
}

.cb-hud-layer[data-state="awaiting_approval"] .cb-hud-glow {
  border-color: rgba(234, 88, 12, 0.8);
  box-shadow:
    inset 0 0 22px 4px rgba(234, 88, 12, 0.3),
    inset 0 0 48px 6px rgba(234, 88, 12, 0.15);
}

@keyframes cb-hud-breathe {
  0%, 100% {
    box-shadow:
      inset 0 0 18px 3px rgba(59, 130, 246, 0.28),
      inset 0 0 44px 6px rgba(37, 99, 235, 0.14);
    border-color: rgba(59, 130, 246, 0.6);
  }
  50% {
    box-shadow:
      inset 0 0 28px 6px rgba(96, 165, 250, 0.45),
      inset 0 0 64px 10px rgba(37, 99, 235, 0.24);
    border-color: rgba(96, 165, 250, 0.9);
  }
}

.cb-hud-dock {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
  display: flex;
  justify-content: center;
  max-width: min(560px, calc(100vw - 24px));
}

.cb-hud-capsule {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: 6px 10px 6px 8px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.84);
  backdrop-filter: blur(14px) saturate(160%);
  border: 1px solid rgba(148, 163, 184, 0.26);
  box-shadow:
    0 10px 28px rgba(2, 6, 23, 0.36),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  color: #f8fafc;
  font-size: 13px;
  line-height: 1.3;
  user-select: none;
}

.cb-hud-avatar {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  flex-shrink: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #2563eb, #38bdf8);
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.22);
}

.cb-hud-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cb-hud-pulse {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
  background: #38bdf8;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.85);
}

.cb-hud-layer[data-state="yielded_to_human"] .cb-hud-pulse {
  background: #fbbf24;
  box-shadow: 0 0 8px rgba(251, 191, 36, 0.85);
}

.cb-hud-layer[data-state="awaiting_approval"] .cb-hud-pulse {
  background: #fb923c;
  box-shadow: 0 0 8px rgba(251, 146, 60, 0.85);
}

.cb-hud-text {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cb-hud-name {
  font-weight: 600;
  color: #ffffff;
  white-space: nowrap;
  flex-shrink: 0;
}

.cb-hud-step {
  color: rgba(226, 232, 240, 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}

.cb-hud-resume {
  appearance: none;
  border: 0;
  border-radius: 999px;
  background: #2563eb;
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 140ms ease, transform 120ms ease;
}

.cb-hud-resume:hover {
  background: #3b82f6;
}

.cb-hud-resume:active {
  transform: scale(0.96);
}

.cb-hud-close {
  appearance: none;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: #e2e8f0;
  font-size: 14px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 140ms ease, color 140ms ease;
}

.cb-hud-close:hover {
  background: rgba(239, 68, 68, 0.85);
  color: #ffffff;
}

@media (prefers-reduced-motion: reduce) {
  .cb-hud-glow {
    animation: none;
  }
}
`;

function sendToBackground(message: HudOutboundMessage): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // 扩展重载或连接断开时忽略
  }
}

function installHud(): void {
  const win = globalThis as unknown as Record<string, unknown>;
  if (win[HUD_MOUNT_FLAG]) return;
  win[HUD_MOUNT_FLAG] = true;

  const logic = createHudLogicController();
  let hostEl: HTMLDivElement | null = null;
  let shadowRoot: ShadowRoot | null = null;
  let layerEl: HTMLDivElement | null = null;
  let avatarEl: HTMLDivElement | null = null;
  let nameEl: HTMLSpanElement | null = null;
  let stepEl: HTMLSpanElement | null = null;
  let resumeBtn: HTMLButtonElement | null = null;

  function ensureMounted(): void {
    if (hostEl && document.documentElement.contains(hostEl)) return;
    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    hostEl.setAttribute("data-chisabot-hud", "true");
    shadowRoot = hostEl.attachShadow({ mode: "closed" });

    const styleEl = document.createElement("style");
    styleEl.textContent = HUD_STYLES;

    layerEl = document.createElement("div");
    layerEl.className = "cb-hud-layer";
    layerEl.setAttribute("data-hidden", "true");
    layerEl.setAttribute("data-state", "idle");

    const glowEl = document.createElement("div");
    glowEl.className = "cb-hud-glow";

    const dockEl = document.createElement("div");
    dockEl.className = "cb-hud-dock";

    const capsuleEl = document.createElement("div");
    capsuleEl.className = "cb-hud-capsule";
    capsuleEl.setAttribute("role", "status");
    capsuleEl.setAttribute("aria-live", "polite");

    avatarEl = document.createElement("div");
    avatarEl.className = "cb-hud-avatar";
    avatarEl.textContent = "C";

    const pulseEl = document.createElement("span");
    pulseEl.className = "cb-hud-pulse";

    const textWrap = document.createElement("div");
    textWrap.className = "cb-hud-text";

    nameEl = document.createElement("span");
    nameEl.className = "cb-hud-name";
    nameEl.textContent = "ChisaBot";

    stepEl = document.createElement("span");
    stepEl.className = "cb-hud-step";

    textWrap.append(nameEl, stepEl);

    resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "cb-hud-resume";
    resumeBtn.textContent = "继续";
    resumeBtn.hidden = true;
    resumeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      sendToBackground({ type: "HUD_USER_RESUME" });
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-hud-close";
    closeBtn.setAttribute("aria-label", "停止接管并退出");
    closeBtn.title = "停止接管并退出";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      unmount();
      sendToBackground({ type: "HUD_USER_ABORT" });
    });

    capsuleEl.append(avatarEl, pulseEl, textWrap, resumeBtn, closeBtn);
    dockEl.append(capsuleEl);
    layerEl.append(glowEl, dockEl);
    shadowRoot.append(styleEl, layerEl);

    (document.documentElement || document.body).appendChild(hostEl);
  }

  function unmount(): void {
    logic.remove();
    if (hostEl) {
      hostEl.remove();
      hostEl = null;
      shadowRoot = null;
      layerEl = null;
      avatarEl = null;
      nameEl = null;
      stepEl = null;
      resumeBtn = null;
    }
  }

  function render(model: HudViewModel): void {
    if (!model.visible) {
      if (layerEl) {
        layerEl.setAttribute("data-hidden", "true");
      }
      return;
    }
    ensureMounted();
    if (!layerEl || !avatarEl || !nameEl || !stepEl || !resumeBtn) return;

    layerEl.setAttribute(
      "data-hidden",
      model.hiddenForCapture ? "true" : "false",
    );
    layerEl.setAttribute("data-state", model.state);

    const formatted = formatHudCapsuleText(model);
    nameEl.textContent = formatted.title;
    stepEl.textContent = formatted.subtitle;
    stepEl.hidden = !formatted.subtitle || formatted.showResumeButton;
    resumeBtn.hidden = !formatted.showResumeButton;

    // 更新圆形头像（优先用有效图片 URL，否则取首字）
    avatarEl.textContent = "";
    if (
      model.botAvatarUrl &&
      /^(https?:|data:image\/)/i.test(model.botAvatarUrl)
    ) {
      const img = document.createElement("img");
      img.src = model.botAvatarUrl;
      img.alt = model.botName;
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = (
        model.botName.trim().slice(0, 1) || "C"
      ).toUpperCase();
    }
  }

  function isEventFromHud(event: Event): boolean {
    if (!hostEl) return false;
    if (event.target === hostEl) return true;
    if (typeof event.composedPath === "function") {
      return event.composedPath().includes(hostEl);
    }
    return false;
  }

  function onHumanInput(kind: "mousedown" | "keydown" | "wheel", event: Event) {
    if (
      !logic.shouldYieldOnInput({
        isTrusted: event.isTrusted,
        fromHudHost: isEventFromHud(event),
      })
    ) {
      return;
    }
    const next = logic.update({
      state: "yielded_to_human",
      yieldReason: "检测到你在操作页面，已自动暂停礼让",
    });
    render(next);
    sendToBackground({ type: "HUD_HUMAN_INTERVENTION", kind });
  }

  window.addEventListener(
    "mousedown",
    (event) => onHumanInput("mousedown", event),
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => onHumanInput("keydown", event),
    true,
  );
  window.addEventListener("wheel", (event) => onHumanInput("wheel", event), {
    capture: true,
    passive: true,
  });

  chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
    const message = rawMessage as HudInboundMessage | null;
    if (
      !message ||
      typeof message !== "object" ||
      typeof message.type !== "string"
    ) {
      return undefined;
    }

    switch (message.type) {
      case "HUD_UPDATE": {
        const next = logic.update({
          state: message.payload.state,
          botName: message.payload.botName,
          botAvatarUrl: message.payload.botAvatarUrl ?? null,
          stepLabel: message.payload.stepLabel,
          yieldReason: message.payload.yieldReason ?? null,
        });
        render(next);
        sendResponse({ ok: true });
        return false;
      }
      case "HUD_REMOVE": {
        unmount();
        sendResponse({ ok: true });
        return false;
      }
      case "HUD_SYNTHETIC_WINDOW": {
        logic.markSyntheticWindow(message.durationMs);
        sendResponse({ ok: true });
        return false;
      }
      case "HUD_HIDE_FOR_CAPTURE": {
        const next = logic.hideForCapture();
        render(next);
        sendResponse({ ok: true });
        return false;
      }
      case "HUD_RESTORE_AFTER_CAPTURE": {
        const next = logic.restoreAfterCapture();
        render(next);
        sendResponse({ ok: true });
        return false;
      }
      default:
        return undefined;
    }
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  installHud();
}
