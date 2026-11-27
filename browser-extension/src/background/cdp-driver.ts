import type { ChromeApi, ChromeDebuggee } from "../types/chrome";
import type {
  BrowserSnapshotElement,
  BrowserSnapshotResult,
} from "../types/protocol";

/**
 * 会话级按需 Chrome Debugger (CDP 1.3) 驱动。
 *
 * 设计红线：
 * - 纯聊天绝不 attach debugger（零浏览器调试横幅）；
 * - 首次浏览器工具调用时按需 attach("1.3") 并保持至会话结束、点页内 ×、关闭侧栏、
 *   用户点 Chrome 顶栏「取消」或空闲超时自动 detach；
 * - snapshot() 提取与 ChisaBot agent-computer 同构的无障碍控件列表，并严格按
 *   snapshotId -> ref -> backendDOMNodeId 映射，拒绝过期 snapshotId 防止误点；
 * - 所有硬件级鼠标/键盘注入前先标记合成输入窗口，避免误触发页内 HUD 真人礼让；
 * - screenshot() 截前通知 HUD 隐藏一帧、截完在 finally 中恢复，支持后台标签页截图。
 */

const CDP_PROTOCOL_VERSION = "1.3";
const SNAPSHOT_ELEMENT_LIMIT = 200;
const OPTION_LIMIT = 60;
const READ_TEXT_LIMIT = 24_000;
const DEFAULT_IDLE_DETACH_MS = 10 * 60_000;
const SYNTHETIC_WINDOW_BUFFER_MS = 380;

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

const CHECKABLE_ROLES = new Set([
  "checkbox",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "switch",
]);

const CDP_ROLE_MAP: Record<string, string> = {
  button: "button",
  checkbox: "checkbox",
  combobox: "combobox",
  comboboxgrouping: "combobox",
  comboboxmenuButton: "combobox",
  link: "link",
  listbox: "listbox",
  listboxoption: "option",
  menuitem: "menuitem",
  menuitemcheckbox: "menuitemcheckbox",
  menuitemradio: "menuitemradio",
  option: "option",
  popupbutton: "combobox",
  radio: "radio",
  searchbox: "searchbox",
  slider: "slider",
  spinbutton: "spinbutton",
  switch: "switch",
  tab: "tab",
  textbox: "textbox",
  textfield: "textbox",
  togglebutton: "button",
};

export interface AXValue {
  type?: string;
  value?: unknown;
}

export interface AXProperty {
  name: string;
  value?: AXValue;
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface MappedSnapshotEntry {
  ref: string;
  backendDOMNodeId: number;
  element: BrowserSnapshotElement;
}

export interface ParsedAXSnapshot {
  elements: BrowserSnapshotElement[];
  entries: Map<string, MappedSnapshotEntry>;
  truncated: boolean;
}

export interface CdpReadResult {
  tabId: number;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export interface CdpNavigateResult extends CdpReadResult {
  elapsedMs: number;
}

export interface CdpActionResult {
  action: "click" | "hover" | "type" | "key" | "scroll";
  tabId: number;
  ref?: string;
  element?: { role: string; name: string };
  characters?: number;
  submitted?: boolean;
  key?: string;
  deltaY?: number;
  url: string;
  title: string;
  elapsedMs: number;
}

export interface CdpScreenshotResult {
  tabId: number;
  base64: string;
  mimeType: "image/jpeg";
  dataUrl: string;
  width: number;
  height: number;
  url: string;
  title: string;
  capturedAt: string;
}

export class StaleSnapshotError extends Error {
  readonly code = "STALE_SNAPSHOT";
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

/**
 * 与 agent-computer/src/aria-snapshot.ts 同构的 UTF-16 安全截断，避免截断半个 surrogate pair。
 */
export function cutAtCodeUnits(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const sliced = text.slice(0, limit);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

function normalizeAxRole(rawRole: unknown): string {
  if (typeof rawRole !== "string") return "";
  const cleaned = rawRole.trim().toLowerCase().replace(/^ax/, "");
  return CDP_ROLE_MAP[cleaned] ?? cleaned;
}

function axString(value: AXValue | undefined): string {
  if (!value || value.value === undefined || value.value === null) return "";
  if (typeof value.value === "string") return value.value.trim();
  if (typeof value.value === "number" || typeof value.value === "boolean") {
    return String(value.value);
  }
  return "";
}

function axProp(node: AXNode, name: string): AXValue | undefined {
  return node.properties?.find((prop) => prop.name === name)?.value;
}

/**
 * 将 CDP `Accessibility.getFullAXTree` 返回的节点列表转换为与 ChisaBot 同构的扁平交互控件列表，
 * 同时产出 `ref -> { backendDOMNodeId, element }` 精确映射。
 */
export function parseAXTreeNodes(nodes: readonly AXNode[]): ParsedAXSnapshot {
  const byId = new Map<string, AXNode>();
  const childSet = new Set<string>();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
    for (const cid of node.childIds ?? []) {
      childSet.add(cid);
    }
  }

  const roots = nodes.filter((node) => !childSet.has(node.nodeId));
  const walkRoots = roots.length > 0 ? roots : nodes.slice(0, 1);

  const elements: BrowserSnapshotElement[] = [];
  const entries = new Map<string, MappedSnapshotEntry>();
  const visited = new Set<string>();
  let truncated = false;
  let refCounter = 0;

  const collectComboboxOptions = (
    node: AXNode,
  ): { labels: string[]; selected?: string; total: number } | null => {
    const labels: string[] = [];
    let selected: string | undefined;
    const queue = [...(node.childIds ?? [])];
    const seenLocal = new Set<string>();

    while (queue.length > 0) {
      const cid = queue.shift();
      if (!cid || seenLocal.has(cid)) continue;
      seenLocal.add(cid);
      const child = byId.get(cid);
      if (!child) continue;
      const role = normalizeAxRole(child.role?.value);
      if (role === "option") {
        const label = cutAtCodeUnits(axString(child.name), 100);
        if (label) {
          labels.push(label);
          const selVal = axProp(child, "selected")?.value;
          if (selVal === true || selVal === "true") {
            selected = label;
          }
        }
      } else if (
        child.ignored ||
        role === "menulistpopup" ||
        role === "generic" ||
        role === "group" ||
        role === "none"
      ) {
        for (const grandChild of child.childIds ?? []) {
          queue.push(grandChild);
        }
      }
    }

    if (labels.length === 0) return null;
    return {
      labels,
      ...(selected !== undefined ? { selected } : {}),
      total: labels.length,
    };
  };

  const walk = (nodeId: string): void => {
    if (truncated || visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) return;

    const role = normalizeAxRole(node.role?.value);
    let skipChildren = false;

    if (
      !node.ignored &&
      INTERACTIVE_ROLES.has(role) &&
      typeof node.backendDOMNodeId === "number" &&
      node.backendDOMNodeId > 0
    ) {
      if (elements.length >= SNAPSHOT_ELEMENT_LIMIT) {
        truncated = true;
        return;
      }

      refCounter += 1;
      const ref = `e${refCounter}`;
      const name = cutAtCodeUnits(axString(node.name), 200);
      const element: BrowserSnapshotElement = { ref, role, name };

      const rawValue = axString(node.value);
      if (rawValue) {
        element.value = cutAtCodeUnits(rawValue, 200);
      }

      const disabledProp = axProp(node, "disabled")?.value;
      if (disabledProp === true || disabledProp === "true") {
        element.disabled = true;
      }

      const checkedProp = axProp(node, "checked")?.value;
      if (checkedProp !== undefined) {
        element.checked = checkedProp === true || checkedProp === "true";
      } else if (CHECKABLE_ROLES.has(role)) {
        element.checked = false;
      }

      if (role === "combobox") {
        const opts = collectComboboxOptions(node);
        if (opts) {
          element.options = opts.labels.slice(0, OPTION_LIMIT);
          if (opts.total > OPTION_LIMIT) {
            element.options.push(`……共 ${opts.total} 项`);
          }
          if (opts.selected !== undefined && !element.value) {
            element.value = opts.selected;
          }
          skipChildren = true;
        }
      }

      elements.push(element);
      entries.set(ref, {
        ref,
        backendDOMNodeId: node.backendDOMNodeId,
        element,
      });
    }

    if (!skipChildren) {
      for (const childId of node.childIds ?? []) {
        walk(childId);
        if (truncated) break;
      }
    }
  };

  for (const root of walkRoots) {
    walk(root.nodeId);
    if (truncated) break;
  }

  return { elements, entries, truncated };
}

interface KeyDefinition {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  return: {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
};

export function parseKeyChord(rawKey: string): {
  def: KeyDefinition;
  modifiers: number;
} {
  const parts = rawKey
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  let modifiers = 0;
  let mainToken = parts.at(-1) ?? rawKey.trim();

  for (let i = 0; i < parts.length - 1; i += 1) {
    const mod = (parts[i] ?? "").toLowerCase();
    if (mod === "alt" || mod === "option") modifiers |= 1;
    else if (mod === "control" || mod === "ctrl") modifiers |= 2;
    else if (mod === "meta" || mod === "cmd" || mod === "command")
      modifiers |= 4;
    else if (mod === "shift") modifiers |= 8;
  }

  if (!mainToken) mainToken = "Enter";
  const named = NAMED_KEYS[mainToken.toLowerCase()];
  if (named) {
    return { def: named, modifiers };
  }
  const ch = mainToken.slice(0, 1);
  const upper = ch.toUpperCase();
  const code = /^[A-Z]$/.test(upper)
    ? `Key${upper}`
    : /^[0-9]$/.test(ch)
      ? `Digit${ch}`
      : mainToken;
  return {
    def: {
      key: ch,
      code,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: modifiers === 0 || modifiers === 8 ? ch : undefined,
    },
    modifiers,
  };
}

interface SnapshotCacheRecord {
  snapshotId: number;
  url: string;
  title: string;
  entries: Map<string, MappedSnapshotEntry>;
}

export interface CdpDriverOptions {
  chromeApi?: ChromeApi;
  idleDetachMs?: number;
  onBeforeSyntheticInput?: (tabId: number, durationMs: number) => Promise<void>;
  onBeforeScreenshot?: (tabId: number) => Promise<void>;
  onAfterScreenshot?: (tabId: number) => Promise<void>;
  onExternalDetach?: (tabId: number, reason: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function createCdpDriver(options: CdpDriverOptions = {}) {
  const api = options.chromeApi ?? chrome;
  const idleDetachMs = options.idleDetachMs ?? DEFAULT_IDLE_DETACH_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const attachedTabs = new Set<number>();
  const attachingPromises = new Map<number, Promise<void>>();
  const latestSnapshots = new Map<number, SnapshotCacheRecord>();
  const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let snapshotSeq = 0;

  function targetOf(tabId: number): ChromeDebuggee {
    return { tabId };
  }

  function clearIdleTimer(tabId: number) {
    const timer = idleTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(tabId);
    }
  }

  function touchIdleTimer(tabId: number) {
    clearIdleTimer(tabId);
    if (idleDetachMs <= 0) return;
    const timer = setTimeout(() => {
      void detach(tabId).catch(() => {});
    }, idleDetachMs);
    idleTimers.set(tabId, timer);
  }

  const handleDebuggerDetach = (source: ChromeDebuggee, reason: string) => {
    const tabId = source.tabId;
    if (typeof tabId !== "number") return;
    if (!attachedTabs.has(tabId)) return;
    attachedTabs.delete(tabId);
    attachingPromises.delete(tabId);
    latestSnapshots.delete(tabId);
    clearIdleTimer(tabId);
    options.onExternalDetach?.(tabId, reason);
  };

  api.debugger.onDetach.addListener(handleDebuggerDetach);

  async function ensureAttached(tabId: number): Promise<void> {
    if (attachedTabs.has(tabId)) {
      touchIdleTimer(tabId);
      return;
    }
    const inflight = attachingPromises.get(tabId);
    if (inflight) {
      await inflight;
      touchIdleTimer(tabId);
      return;
    }
    const target = targetOf(tabId);
    const promise = (async () => {
      await api.debugger.attach(target, CDP_PROTOCOL_VERSION);
      attachedTabs.add(tabId);
      try {
        await Promise.all([
          api.debugger.sendCommand(target, "Page.enable").catch(() => {}),
          api.debugger.sendCommand(target, "DOM.enable").catch(() => {}),
          api.debugger
            .sendCommand(target, "Accessibility.enable")
            .catch(() => {}),
        ]);
      } catch {
        // 某些受限帧域可能部分返回错误，保持 attach 状态并在具体命令中处理
      }
      touchIdleTimer(tabId);
    })();
    attachingPromises.set(tabId, promise);
    try {
      await promise;
    } finally {
      if (attachingPromises.get(tabId) === promise) {
        attachingPromises.delete(tabId);
      }
    }
  }

  async function send<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    await ensureAttached(tabId);
    touchIdleTimer(tabId);
    return api.debugger.sendCommand<T>(targetOf(tabId), method, params);
  }

  async function detach(tabId: number): Promise<void> {
    clearIdleTimer(tabId);
    latestSnapshots.delete(tabId);
    if (!attachedTabs.has(tabId)) return;
    attachedTabs.delete(tabId);
    try {
      await api.debugger.detach(targetOf(tabId));
    } catch {
      // 标签页可能已经关闭或已被用户手动断开
    }
  }

  async function detachAll(): Promise<void> {
    const tabs = [...attachedTabs];
    await Promise.all(tabs.map((tabId) => detach(tabId)));
  }

  function isAttached(tabId: number): boolean {
    return attachedTabs.has(tabId);
  }

  function getAttachedTabIds(): number[] {
    return [...attachedTabs];
  }

  function resolveSnapshotEntry(
    tabId: number,
    snapshotId: number,
    ref: string,
  ): MappedSnapshotEntry {
    const record = latestSnapshots.get(tabId);
    if (!record || record.snapshotId !== snapshotId) {
      throw new StaleSnapshotError(
        `快照 #${snapshotId} 已过期或不存在，请重新调用 browser_snapshot 获取最新页面控件后再操作。`,
      );
    }
    const entry = record.entries.get(ref);
    if (!entry) {
      throw new StaleSnapshotError(
        `快照 #${snapshotId} 中找不到控件引用 ${ref}，请重新获取快照。`,
      );
    }
    return entry;
  }

  function lookupElement(
    tabId: number,
    snapshotId: number,
    ref: string,
  ): BrowserSnapshotElement | null {
    const record = latestSnapshots.get(tabId);
    if (!record || record.snapshotId !== snapshotId) return null;
    return record.entries.get(ref)?.element ?? null;
  }

  async function readPageMeta(
    tabId: number,
  ): Promise<{ url: string; title: string }> {
    try {
      const evaluated = await send<{
        result?: { value?: { url?: string; title?: string } };
      }>(tabId, "Runtime.evaluate", {
        expression:
          "({ url: window.location.href || '', title: document.title || '' })",
        returnByValue: true,
      });
      const val = evaluated.result?.value;
      if (val && typeof val.url === "string") {
        return {
          url: val.url,
          title: typeof val.title === "string" ? val.title : "",
        };
      }
    } catch {
      // 回退到 tabs.get
    }
    try {
      const tab = await api.tabs.get(tabId);
      return {
        url: tab.url ?? tab.pendingUrl ?? "",
        title: tab.title ?? "",
      };
    } catch {
      return { url: "", title: "" };
    }
  }

  async function snapshot(tabId: number): Promise<BrowserSnapshotResult> {
    const [treeResp, meta] = await Promise.all([
      send<{ nodes?: AXNode[] }>(tabId, "Accessibility.getFullAXTree"),
      readPageMeta(tabId),
    ]);
    const parsed = parseAXTreeNodes(treeResp.nodes ?? []);
    snapshotSeq += 1;
    const snapshotId = snapshotSeq;
    latestSnapshots.set(tabId, {
      snapshotId,
      url: meta.url,
      title: meta.title,
      entries: parsed.entries,
    });
    return {
      snapshotId,
      tabId,
      url: meta.url,
      title: meta.title,
      elements: parsed.elements,
      truncated: parsed.truncated,
    };
  }

  async function read(
    tabId: number,
    maxChars = READ_TEXT_LIMIT,
  ): Promise<CdpReadResult> {
    const limit = Math.max(200, Math.min(maxChars, 100_000));
    const evaluated = await send<{
      result?: {
        value?: {
          url?: string;
          title?: string;
          text?: string;
        };
      };
    }>(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const root = document.querySelector("main, article, [role='main']") || document.body;
        const raw = root ? (root.innerText || root.textContent || "") : "";
        const cleaned = raw.replace(/\\n{3,}/g, "\\n\\n").trim();
        return {
          url: window.location.href || "",
          title: document.title || "",
          text: cleaned,
        };
      })()`,
      returnByValue: true,
    });
    const val = evaluated.result?.value;
    const rawText = typeof val?.text === "string" ? val.text : "";
    const truncated = rawText.length > limit;
    const text = truncated ? cutAtCodeUnits(rawText, limit) : rawText;
    const url =
      typeof val?.url === "string" ? val.url : (await readPageMeta(tabId)).url;
    const title =
      typeof val?.title === "string"
        ? val.title
        : (await readPageMeta(tabId)).title;
    return { tabId, url, title, text, truncated };
  }

  async function waitTabComplete(
    tabId: number,
    timeoutMs = 15_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const tab = await api.tabs.get(tabId);
        if (tab.status === "complete") return;
      } catch {
        return;
      }
      await sleep(180);
    }
  }

  async function navigate(
    tabId: number,
    url: string,
  ): Promise<CdpNavigateResult> {
    const startedAt = Date.now();
    latestSnapshots.delete(tabId);
    await send(tabId, "Page.navigate", { url });
    await sleep(250);
    await waitTabComplete(tabId, 15_000);
    const content = await read(tabId);
    return {
      ...content,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function locateNodeCenter(
    tabId: number,
    backendNodeId: number,
  ): Promise<{ x: number; y: number }> {
    try {
      await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch {
      // 某些不可滚动或 SVG 节点可能拒绝 scrollIntoViewIfNeeded，继续取坐标
    }

    try {
      const box = await send<{
        model?: { content?: number[]; border?: number[] };
      }>(tabId, "DOM.getBoxModel", { backendNodeId });
      const quad = box.model?.border ?? box.model?.content;
      if (Array.isArray(quad) && quad.length >= 8) {
        const xs = [quad[0], quad[2], quad[4], quad[6]].filter(
          (n): n is number => typeof n === "number",
        );
        const ys = [quad[1], quad[3], quad[5], quad[7]].filter(
          (n): n is number => typeof n === "number",
        );
        if (xs.length === 4 && ys.length === 4) {
          const x = (Math.min(...xs) + Math.max(...xs)) / 2;
          const y = (Math.min(...ys) + Math.max(...ys)) / 2;
          if (Number.isFinite(x) && Number.isFinite(y)) {
            return { x: Math.round(x), y: Math.round(y) };
          }
        }
      }
    } catch {
      // 回退到 DOM.resolveNode + getBoundingClientRect
    }

    const resolved = await send<{ object?: { objectId?: string } }>(
      tabId,
      "DOM.resolveNode",
      { backendNodeId },
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error("无法定位该控件的屏幕坐标，可能已被隐藏或移出页面。");
    }
    const rectResp = await send<{
      result?: { value?: { x?: number; y?: number; visible?: boolean } };
    }>(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        if (typeof this.scrollIntoView === "function") {
          this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        }
        const rect = this.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          visible: rect.width > 0 || rect.height > 0,
        };
      }`,
      returnByValue: true,
    });
    const pt = rectResp.result?.value;
    if (!pt?.visible || typeof pt.x !== "number" || typeof pt.y !== "number") {
      throw new Error("目标控件当前不可见，无法交互。");
    }
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  }

  async function markSynthetic(
    tabId: number,
    durationMs: number,
  ): Promise<void> {
    if (options.onBeforeSyntheticInput) {
      await options
        .onBeforeSyntheticInput(tabId, durationMs + SYNTHETIC_WINDOW_BUFFER_MS)
        .catch(() => {});
    }
  }

  async function hoverAt(
    tabId: number,
    x: number,
    y: number,
  ): Promise<CdpActionResult> {
    const startedAt = Date.now();
    const rx = Math.max(0, Math.round(x));
    const ry = Math.max(0, Math.round(y));

    await markSynthetic(tabId, 450);
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.max(0, rx - 12),
      y: Math.max(0, ry - 8),
      pointerType: "mouse",
    });
    await sleep(40);
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rx,
      y: ry,
      pointerType: "mouse",
    });
    await sleep(120);

    const meta = await readPageMeta(tabId);
    return {
      action: "hover",
      tabId,
      url: meta.url,
      title: meta.title,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function hover(
    tabId: number,
    snapshotId: number,
    ref: string,
  ): Promise<CdpActionResult> {
    const startedAt = Date.now();
    const entry = resolveSnapshotEntry(tabId, snapshotId, ref);
    const { x, y } = await locateNodeCenter(tabId, entry.backendDOMNodeId);

    await markSynthetic(tabId, 450);
    // 先从邻近位置平滑移入目标中心，确保触发 ECharts / Canvas / Highcharts Tooltip
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.max(0, x - 12),
      y: Math.max(0, y - 8),
      pointerType: "mouse",
    });
    await sleep(40);
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      pointerType: "mouse",
    });
    await sleep(120);

    const meta = await readPageMeta(tabId);
    return {
      action: "hover",
      tabId,
      ref,
      element: { role: entry.element.role, name: entry.element.name },
      url: meta.url,
      title: meta.title,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function click(
    tabId: number,
    snapshotId: number,
    ref: string,
  ): Promise<CdpActionResult> {
    const startedAt = Date.now();
    const entry = resolveSnapshotEntry(tabId, snapshotId, ref);
    const { x, y } = await locateNodeCenter(tabId, entry.backendDOMNodeId);

    await markSynthetic(tabId, 500);
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      pointerType: "mouse",
    });
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });
    await sleep(120);

    const meta = await readPageMeta(tabId);
    return {
      action: "click",
      tabId,
      ref,
      element: { role: entry.element.role, name: entry.element.name },
      url: meta.url,
      title: meta.title,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function pressKeyRaw(tabId: number, rawKey: string): Promise<void> {
    const { def, modifiers } = parseKeyChord(rawKey);
    await send(tabId, "Input.dispatchKeyEvent", {
      type: def.text ? "keyDown" : "rawKeyDown",
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.windowsVirtualKeyCode,
      modifiers,
      ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}),
    });
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.windowsVirtualKeyCode,
      modifiers,
    });
  }

  async function type(
    tabId: number,
    snapshotId: number,
    ref: string,
    text: string,
    submit = false,
  ): Promise<CdpActionResult> {
    const startedAt = Date.now();
    const entry = resolveSnapshotEntry(tabId, snapshotId, ref);

    await markSynthetic(tabId, 750);

    // 原生 <select> 控件直接按选项文案/值选定；其余表单项先聚焦清空再用 Input.insertText 写入
    let handledAsSelect = false;
    try {
      const resolved = await send<{ object?: { objectId?: string } }>(
        tabId,
        "DOM.resolveNode",
        { backendNodeId: entry.backendDOMNodeId },
      );
      const objectId = resolved.object?.objectId;
      if (objectId) {
        const res = await send<{
          result?: { value?: { isSelect?: boolean; matched?: boolean } };
        }>(tabId, "Runtime.callFunctionOn", {
          objectId,
          arguments: [{ value: text }],
          functionDeclaration: `function(targetText) {
            if (this && this.tagName === "SELECT") {
              const opts = Array.from(this.options || []);
              const found = opts.find((o) => o.text.trim() === targetText.trim() || o.value === targetText);
              if (found) {
                this.value = found.value;
                this.dispatchEvent(new Event("input", { bubbles: true }));
                this.dispatchEvent(new Event("change", { bubbles: true }));
                return { isSelect: true, matched: true };
              }
              return { isSelect: true, matched: false };
            }
            if (typeof this.focus === "function") this.focus();
            if ("value" in this && typeof this.value === "string") {
              this.value = "";
              this.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (this.isContentEditable) {
              this.textContent = "";
            }
            return { isSelect: false, matched: false };
          }`,
          returnByValue: true,
        });
        if (res.result?.value?.isSelect) {
          handledAsSelect = true;
          if (!res.result.value.matched) {
            throw new Error(`下拉框中未找到匹配选项「${text}」。`);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("下拉框中未找到")) {
        throw error;
      }
      // 回退到坐标点击聚焦
      const { x, y } = await locateNodeCenter(tabId, entry.backendDOMNodeId);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    }

    if (!handledAsSelect && text.length > 0) {
      await send(tabId, "Input.insertText", { text });
    }
    if (submit) {
      await pressKeyRaw(tabId, "Enter");
    }

    const meta = await readPageMeta(tabId);
    return {
      action: "type",
      tabId,
      ref,
      element: { role: entry.element.role, name: entry.element.name },
      // 严禁在返回结果中回显输入明文（可能是密码/验证码）
      characters: text.length,
      submitted: submit,
      url: meta.url,
      title: meta.title,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function key(
    tabId: number,
    rawKey: string,
    snapshotId?: number,
    ref?: string,
  ): Promise<CdpActionResult> {
    const startedAt = Date.now();
    let element: { role: string; name: string } | undefined;

    await markSynthetic(tabId, 450);
    if (snapshotId !== undefined && ref) {
      const entry = resolveSnapshotEntry(tabId, snapshotId, ref);
      element = { role: entry.element.role, name: entry.element.name };
      try {
        await send(tabId, "DOM.focus", {
          backendNodeId: entry.backendDOMNodeId,
        });
      } catch {
        // 焦点不可直接设置时仍继续按键派发
      }
    }

    await pressKeyRaw(tabId, rawKey);
    const meta = await readPageMeta(tabId);
    return {
      action: "key",
      tabId,
      ...(ref ? { ref } : {}),
      ...(element ? { element } : {}),
      key: rawKey,
      url: meta.url,
      title: meta.title,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function scroll(
    tabId: number,
    deltaY = 540,
    deltaX = 0,
  ): Promise<CdpActionResult> {
    const startedAt = Date.now();
    await markSynthetic(tabId, 450);

    let cx = 640;
    let cy = 360;
    try {
      const metrics = await send<{
        visualViewport?: { clientWidth?: number; clientHeight?: number };
      }>(tabId, "Page.getLayoutMetrics");
      if (metrics.visualViewport?.clientWidth) {
        cx = Math.round(metrics.visualViewport.clientWidth / 2);
      }
      if (metrics.visualViewport?.clientHeight) {
        cy = Math.round(metrics.visualViewport.clientHeight / 2);
      }
    } catch {
      // 使用默认视口中心
    }

    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: cx,
      y: cy,
      deltaX,
      deltaY,
    });
    await sleep(100);

    const meta = await readPageMeta(tabId);
    return {
      action: "scroll",
      tabId,
      deltaY,
      url: meta.url,
      title: meta.title,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function screenshot(
    tabId: number,
    quality = 78,
  ): Promise<CdpScreenshotResult> {
    const clampedQuality = Math.max(30, Math.min(95, Math.round(quality)));
    await ensureAttached(tabId);
    if (options.onBeforeScreenshot) {
      await options.onBeforeScreenshot(tabId).catch(() => {});
      // 让页内 HUD 隐藏样式完成一帧重绘，保证截屏零遮挡
      await sleep(50);
    }

    let base64 = "";
    let width = 1280;
    let height = 800;
    let meta = { url: "", title: "" };
    try {
      const [capture, metrics, pageMeta] = await Promise.all([
        send<{ data?: string }>(tabId, "Page.captureScreenshot", {
          format: "jpeg",
          quality: clampedQuality,
        }),
        send<{
          visualViewport?: { clientWidth?: number; clientHeight?: number };
        }>(tabId, "Page.getLayoutMetrics").catch(() => ({
          visualViewport: undefined,
        })),
        readPageMeta(tabId),
      ]);
      base64 = capture.data ?? "";
      if (metrics.visualViewport?.clientWidth) {
        width = Math.round(metrics.visualViewport.clientWidth);
      }
      if (metrics.visualViewport?.clientHeight) {
        height = Math.round(metrics.visualViewport.clientHeight);
      }
      meta = pageMeta;
    } finally {
      if (options.onAfterScreenshot) {
        await options.onAfterScreenshot(tabId).catch(() => {});
      }
    }

    if (!base64) {
      throw new Error("页面截图失败：未收到浏览器图像数据。");
    }

    return {
      tabId,
      base64,
      mimeType: "image/jpeg",
      dataUrl: `data:image/jpeg;base64,${base64}`,
      width,
      height,
      url: meta.url,
      title: meta.title,
      capturedAt: new Date().toISOString(),
    };
  }

  function dispose(): void {
    api.debugger.onDetach.removeListener(handleDebuggerDetach);
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
  }

  return {
    ensureAttached,
    detach,
    detachAll,
    isAttached,
    getAttachedTabIds,
    lookupElement,
    snapshot,
    read,
    navigate,
    hover,
    hoverAt,
    click,
    type,
    key,
    scroll,
    screenshot,
    dispose,
  };
}

export type CdpDriver = ReturnType<typeof createCdpDriver>;
