import {
  IconArrowLeft,
  IconArrowRight,
  IconLoader2,
  IconRefresh,
  IconWorld,
} from "@tabler/icons-react";
import {
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { setTabsView } from "@/lib/computers/tabs";
import {
  connectScreen,
  type ScreenSocket,
} from "@/lib/computers/screen-connection";
import { keyOf } from "@/lib/hotkeys/hotkeys";
import { socketUrl } from "@/lib/socket-url";
import { currentPageVisible } from "./preview-visibility";
import { pageCoordinates } from "./take-the-wheel";

/**
 * Low-latency screencast used while a human is driving the Bot's browser.
 *
 * The inline card keeps using cheap polling for passive watching. This view uses Chrome's
 * screencast socket so input and visual feedback stay synchronized during takeover.
 *
 * Follows Chrome DevTools' own `InputModel.ts` (BSD-3) for the event translation and
 * `steel-dev/steel-browser`'s casting handler (Apache-2.0) for the frame loop, because no maintained
 * library publishes this and every real implementation is one app-internal file.
 */

/**
 * CDP's modifier bitmask. Alt 1, Control 2, Meta 4, Shift 8.
 *
 * Needed or a capital letter typed with Shift arrives lower-case, and Ctrl+A selects nothing.
 * Command is sent as Control: the Bot's computer is Linux, where Meta+A selects nothing, and a Mac
 * user's hands reach for Command+A, Command+C and Command+Z.
 */
function modifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey || event.metaKey ? 2 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/** The Command key itself, pressed or released, as the Control key the Linux browser expects. */
function remoteKey(event: KeyboardEvent) {
  return event.key === "Meta"
    ? {
        key: "Control",
        code: event.code === "MetaRight" ? "ControlRight" : "ControlLeft",
        windowsVirtualKeyCode: 17,
      }
    : {
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
      };
}

/**
 * Let the local browser create a paste event, whose clipboard text is forwarded separately.
 *
 * The V is read the way a shortcut is (`keyOf`), so a layout that writes another script still has
 * one: Ctrl and the V key report "м" on Russian and "ω" on Greek.
 */
function isPasteShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && keyOf(event) === "v";
}

/**
 * Whether a keystroke is aimed at a field on this page rather than at the Bot's browser.
 *
 * The canvas cannot hold focus, so a keystroke meant for the remote page arrives targeted at the
 * body (or whatever non-editable element last took a click). One targeted at an input, textarea,
 * select or contenteditable is someone typing into this page while driving: the recorder's
 * workflow name, the secret box under the screen. Taking those keys left the fields dead.
 */
function isLocalField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

type Props = {
  /**
   * Computer identity is part of the stream URL so input and frames stay scoped to the active Bot.
   */
  computerId: string;
  /** Whether the user currently holds the wheel. Input is only sent when true. */
  driving: boolean;
  /** Called with a human-readable reason when the stream cannot be established. */
  onProblem?: (problem: string | null) => void;
  retryKey?: number;
  /** Width divided by height of the screen box. */
  aspectRatio?: number;
  /** Drawn over the screen (for example the "disconnected, retry" sheet). */
  children?: ReactNode;
  /** 地址栏上面（标签栏，DESIGN §95）。 */
  aboveUrlbar?: ReactNode;
  /** 地址栏下面（收藏栏）。看着和接管时都显示。 */
  belowUrlbar?: ReactNode;
  /** 地址栏右端（收藏星标），拿到当前页网址。 */
  urlbarEnd?: (pageUrl: string) => ReactNode;
  /** 让外面（收藏栏）也能打开网址：接管中才生效，返回是否发出去了。 */
  controllerRef?: MutableRefObject<LiveScreenController | null>;
};

export type LiveScreenController = {
  openUrl: (url: string) => boolean;
  ready: () => boolean;
};

type FrameMessage = {
  data: string;
  width: number;
  height: number;
  /** 这一帧所在页面的网址（旧的计算机不带）。 */
  url?: string;
};

/**
 * 计算机回过来的拒绝，说成这个界面里的中文。
 *
 * 这些句子在直播这条路上原来是到不了的：只有 App 自己那份控制权状态说「有人在开车」时才会发输入，
 * 而计算机和那份状态一致，所以它不会拒绝。现在由计算机来判断并回话，它说的是英文；这个界面里其他
 * 每一句都是中文，把英文原样盖在画面上就等于没有好好说话。认不出的错误照原样显示，不吞掉。
 */
const SCREEN_REFUSALS: [RegExp, string][] = [
  [/take control before/i, "请先点下面的「接管控制」，再操作机器人浏览器。"],
  [/still starting/i, "屏幕正在打开，稍等一下再试。"],
  [/no longer live/i, "这块屏幕已经不归这个窗口了，关掉大屏重开再试。"],
  [/somewhere else/i, "这块屏幕现在在另一个窗口看着，这边停下了。"],
  [/computer stopped|screen ended/i, "这台电脑已经停了，屏幕结束了。需要的话重新打开电脑。"],
];

export function screenProblem(error: string): string {
  for (const [pattern, text] of SCREEN_REFUSALS)
    if (pattern.test(error)) return text;
  return error;
}

/** 浏览器还没打开任何网页：about:blank 或空网址。没带网址的帧当作真页面。 */
export function isBlankPageUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  const text = url.trim();
  return text === "" || text === "about:blank";
}

/**
 * 这一帧是不是一张纯白（或几乎纯白）的图。缩成 32×20 再看，每个像素都接近白色才算。
 * 只在空白网址上调用，所以不会每帧都做。导出给测试用（传入 RGBA 数据）。
 */
export function isPlainWhitePixels(data: ArrayLike<number>): boolean {
  for (let i = 0; i + 2 < data.length; i += 4) {
    if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) return false;
  }
  return data.length > 0;
}

function bitmapIsPlainWhite(bitmap: ImageBitmap): boolean {
  try {
    const probe = document.createElement("canvas");
    probe.width = 32;
    probe.height = 20;
    const context = probe.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(bitmap, 0, 0, probe.width, probe.height);
    return isPlainWhitePixels(context.getImageData(0, 0, probe.width, probe.height).data);
  } catch {
    return false;
  }
}

/**
 * 地址栏里输入的东西 → 要打开的网址。带协议的照用；像域名的补 https://；其余当作搜索词。
 * 导出给测试用。
 */
export function addressToUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  // 工作区里的文件：原样交给计算机，它把 file:///workspace/… 换成 https://workspace.local/…；
  // 别的 file 地址会被拒绝并提示，而不是被当成搜索词。
  if (/^file:\/\//i.test(text)) return text;
  if (
    !/\s/.test(text) &&
    (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(text) ||
      /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?::\d+)?(?:[/?#].*)?$/u.test(text))
  ) {
    return `https://${text}`;
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

export function LiveScreen({
  computerId,
  driving,
  onProblem,
  retryKey = 0,
  aspectRatio = 1280 / 800,
  children,
  aboveUrlbar,
  belowUrlbar,
  urlbarEnd,
  controllerRef,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** Keydowns handled locally whose matching keyup must not leak to the remote browser. */
  const localKeyUps = useRef(new Set<string>());
  /** The size of the frames Chrome is sending, which is what input coordinates are relative to. */
  const frameSize = useRef<{ width: number; height: number } | null>(null);
  /** Latest validated encoded frame. Hidden tabs keep only this, never decoded bitmaps. */
  const latestFrame = useRef<FrameMessage | null>(null);
  /** Monotonic guard so a slow older decode cannot replace a newer frame. */
  const latestFrameId = useRef(0);
  const [connected, setConnected] = useState(false);
  /**
   * 浏览器停在空白页、画面是一片白：盖上和右栏一样的「浏览器空闲」卡片，而不是给人看一块白色矩形。
   * 服务端通常会在空白页上画起始页（那就是有内容的画面，不盖）；这里兜住它还没画上或画不上的时候。
   */
  const [blankPage, setBlankPage] = useState(false);
  const blankPageRef = useRef(false);
  /** 画布上是否已经画过至少一帧。没画过时显示「正在连接屏幕…」，而不是一块黑色画布。 */
  const [hasFrame, setHasFrame] = useState(false);
  const hasFrameRef = useRef(false);
  /** 断线后保留最后一帧，蒙一层「正在重新连接…」，而不是清成黑屏。 */
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectingRef = useRef(false);
  /** 当前页面的网址（帧里带的），接管时的地址栏显示它。 */
  const [pageUrl, setPageUrl] = useState("");
  const [navBusy, setNavBusy] = useState(false);
  const [navProblem, setNavProblem] = useState<string | null>(null);
  /** 用户最后一次在地址栏里要打开的网址。 */
  const lastAttempt = useRef("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit Retry restarts this connection.
  useEffect(() => {
    let closed = false;
    setConnected(false);
    hasFrameRef.current = false;
    setHasFrame(false);
    reconnectingRef.current = false;
    setReconnecting(false);
    frameSize.current = null;
    latestFrame.current = null;
    latestFrameId.current++;

    const drawFrame = async (frame: FrameMessage, frameId: number) => {
      /**
       * Decoded off the main thread and drawn as a bitmap.
       *
       * `createImageBitmap` rather than assigning a data URI to an `<img>`: the image path decodes
       * synchronously on the main thread for every frame, which at screencast rates is the difference
       * between a smooth page and one that stutters while you are trying to click something on it.
       */
      try {
        const binary = Uint8Array.from(atob(frame.data), (c) =>
          c.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([binary], { type: "image/jpeg" }),
        );
        if (
          closed ||
          frameId !== latestFrameId.current ||
          !currentPageVisible()
        ) {
          bitmap.close();
          return;
        }
        const canvas = canvasRef.current;
        if (!canvas) {
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        const blank = isBlankPageUrl(frame.url) && bitmapIsPlainWhite(bitmap);
        bitmap.close();
        if (blank !== blankPageRef.current) {
          blankPageRef.current = blank;
          setBlankPage(blank);
        }
        if (!hasFrameRef.current) {
          hasFrameRef.current = true;
          setHasFrame(true);
        }
        if (reconnectingRef.current) {
          reconnectingRef.current = false;
          setReconnecting(false);
        }
      } catch {
        // Ignore a single corrupt frame; the next frame replaces it.
      }
    };

    const drawLatestFrame = () => {
      if (!currentPageVisible()) return;
      const frame = latestFrame.current;
      if (!frame) return;
      void drawFrame(frame, latestFrameId.current);
    };

    const onMessage = (event: { data: unknown }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      // A frame that is not an object (`null`, a number, a string, an array) has
      // no `type` to read: reaching for it throws a `TypeError` inside this
      // handler and stops the live view from drawing further frames. Drop it.
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return;
      }
      const message = parsed as {
        type: string;
        data?: string;
        width?: number;
        height?: number;
        error?: string;
        url?: unknown;
        ok?: unknown;
      };
      if (typeof message.type !== "string") return;
      // Application keepalive from agent-computer (CR-P2-12): answer so the return path also
      // carries a data frame through the proxy; ignore pong. Never requires holding the wheel.
      if (message.type === "ping") {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: "pong" }));
          } catch {
            /* reconnect path will replace the socket */
          }
        }
        return;
      }
      if (message.type === "pong") return;
      // 标签列表（DESIGN §95）：直播 socket 每次有变化就推一次，写进标签栏读的那份仓库。
      if (message.type === "tabs") {
        setTabsView(computerId, parsed);
        return;
      }
      if (typeof message.url === "string" && message.url.length < 4096) {
        // 打不开时 Chrome 停在 chrome-error://，地址栏留着用户刚输入的网址，方便改了再试。
        if (
          message.url.startsWith("chrome-error:") ||
          (message.type === "navigation" && message.url === "")
        ) {
          if (lastAttempt.current) setPageUrl(lastAttempt.current);
        } else {
          setPageUrl(message.url === "about:blank" ? "" : message.url);
        }
      }
      if (message.type === "navigation") {
        setNavBusy(false);
        setNavProblem(
          message.ok === true
            ? null
            : typeof message.error === "string"
              ? message.error
              : "这个网址打不开。",
        );
        return;
      }
      if (message.type === "error") {
        onProblem?.(screenProblem(message.error ?? "无法显示屏幕。"));
        return;
      }
      if (message.type !== "frame" || !message.data) return;
      // Live-run JSON only checks `typeof type === "string"` upstream. Non-finite or negative
      // dimensions would poison frameSize and every coordinate scaled from it; a huge payload
      // would hit `atob` before any bound. Both are dropped as corrupt frames.
      const width = message.width ?? 1280;
      const height = message.height ?? 800;
      if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0 ||
        width > 8192 ||
        height > 8192
      ) {
        return;
      }
      if (
        typeof message.data !== "string" ||
        message.data.length > 20_000_000
      ) {
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas || closed) return;

      frameSize.current = {
        width: message.width ?? 1280,
        height: message.height ?? 800,
      };
      const frame: FrameMessage = {
        data: message.data,
        width,
        height,
        ...(typeof message.url === "string" ? { url: message.url } : {}),
      };
      latestFrame.current = frame;
      const frameId = ++latestFrameId.current;

      if (!currentPageVisible()) return;
      void drawFrame(frame, frameId);
    };

    const connection = connectScreen({
      open: () => {
        const socket = new WebSocket(
          socketUrl(`/api/computers/${encodeURIComponent(computerId)}/stream`),
        );
        socketRef.current = socket;
        // Event handlers use only data, so adapt the native event surface without changing the protocol.
        return {
          set onopen(callback: ScreenSocket["onopen"]) {
            socket.onopen = callback
              ? () => {
                  void callback();
                }
              : null;
          },
          set onclose(callback: ScreenSocket["onclose"]) {
            socket.onclose = callback;
          },
          set onerror(callback: ScreenSocket["onerror"]) {
            socket.onerror = callback;
          },
          set onmessage(callback: ScreenSocket["onmessage"]) {
            socket.onmessage = callback;
          },
          close: () => socket.close(),
        };
      },
      onReady: (ready) => {
        setConnected(ready);
      },
      onProblem: (problem) =>
        onProblem?.(problem === null ? null : screenProblem(problem)),
      onDisconnect: () => {
        frameSize.current = null;
        latestFrame.current = null;
        latestFrameId.current++;
        setNavBusy(false);
        // 不清空画布：清掉之后底色是黑的，看起来就是「黑屏」。保留最后一帧并蒙上「正在重新连接…」。
        if (hasFrameRef.current) {
          reconnectingRef.current = true;
          setReconnecting(true);
        }
      },
      onMessage,
    });
    document.addEventListener("visibilitychange", drawLatestFrame);
    return () => {
      closed = true;
      connection.stop();
      document.removeEventListener("visibilitychange", drawLatestFrame);
      socketRef.current = null;
    };
  }, [computerId, onProblem, retryKey]);

  /**
   * Send one thing the person did, if this socket can carry it.
   *
   * `driving` is the whole permission check, and it is the same fact the footer and the address bar
   * are drawn from. Whether the person really holds the wheel is the computer's answer to give, and
   * it gives it: input from someone who is not driving comes back as a refusal the view puts on
   * screen. A second, cached copy of that answer used to live here, and once it went stale every
   * click and keystroke was dropped with nothing said.
   */
  const send = useCallback(
    (message: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (!driving || socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    [driving],
  );

  /**
   * Convert from displayed canvas coordinates to page coordinates with the shared, tested helper.
   * A screencast frame is the viewport, so its frame size stands in for natural image size.
   */
  const at = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const size = frameSize.current;
    if (!canvas || !size) return null;
    return pageCoordinates(
      { naturalWidth: size.width, naturalHeight: size.height },
      canvas.getBoundingClientRect(),
      event,
    );
  }, []);

  const onMouse = useCallback(
    (kind: "pressed" | "released" | "moved") =>
      (event: React.MouseEvent<HTMLCanvasElement>) => {
        const point = at(event);
        if (!point) return;
        send({
          type: "mouse",
          event: kind,
          ...point,
          button:
            event.button === 2
              ? "right"
              : event.button === 1
                ? "middle"
                : "left",
          /*
           * The browser's own count, not a fixed one.
           *
           * `MouseEvent.detail` is how many times in a row this button has been pressed in the same
           * place, worked out by the browser to its own timing and distance rules. Chrome fires
           * `dblclick` on the far page only when the second press says it is the second, so sending 1
           * every time meant a double click arrived as two separate clicks: no `dblclick` ever
           * reached the page, `event.detail` was always 1, and opening a row, expanding a node and
           * selecting a word were all things a person holding the wheel could not do.
           *
           * At least one on a press, because the computer refuses a press of zero for the reason its
           * own comment gives -- Chrome would see a move that happens to have a button set, and no
           * click at all. `detail` is zero on an event a script dispatched rather than a person.
           */
          clickCount: kind === "moved" ? 0 : Math.max(1, event.detail),
          modifiers: modifierBits(event),
        });
      },
    [at, send],
  );

  /**
   * Keystrokes, forwarded while driving.
   *
   * Gated on `driving` alone. It used to need `connected` too, and `connected` answered "the socket
   * is open AND the ownership read that ran when it opened said a person still had the wheel" — so
   * one failed read after a reconnect took the keyboard away for good while the picture kept
   * coming. Whether the socket can carry a keystroke is `send`'s question, asked at the moment of
   * sending, and whether the person may drive is the computer's to refuse.
   *
   * Listen on window because canvas cannot hold focus. `preventDefault` keeps Tab and typing directed
   * at the remote page while takeover is active.
   *
   * The keydown in the capture phase, and stopped as well as prevented, because a keystroke sent to
   * the Bot's browser is not also this page's. The app's own shortcuts listen on this window too,
   * and they were bound first, when the signed-in app mounted, so they saw every keystroke before
   * this did: a capital N typed into the remote page started a new chat, and Ctrl+B there toggled
   * the sidebar here. Escape and the paste shortcut are not stopped, because both are meant for this
   * page, and neither is a keystroke typed into one of this page's own fields.
   */
  useEffect(() => {
    if (!driving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return; // Escape still closes the view.
      if (isPasteShortcut(event) || isLocalField(event.target)) {
        localKeyUps.current.add(event.code);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      send({
        type: "key",
        event: "down",
        ...remoteKey(event),
        // Only a printable character carries text. Sending text for Backspace makes Chrome insert a
        // character instead of deleting one.
        ...(event.key.length === 1 ? { text: event.key } : {}),
        modifiers: modifierBits(event),
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      if (localKeyUps.current.delete(event.code) || isPasteShortcut(event)) {
        return;
      }
      event.preventDefault();
      send({
        type: "key",
        event: "up",
        ...remoteKey(event),
        modifiers: modifierBits(event),
      });
    };
    /** Paste arrives as one block; CDP inserts it as text rather than key events. */
    const onPaste = (event: ClipboardEvent) => {
      if (isLocalField(event.target)) return;
      const text = event.clipboardData?.getData("text");
      if (!text) return;
      event.preventDefault();
      send({ type: "text", text });
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
      localKeyUps.current.clear();
    };
  }, [driving, send]);

  /**
   * The wheel, forwarded while driving, from a listener that is allowed to stop it here.
   *
   * Not React's `onWheel`: React attaches that to its root as a passive listener, so the
   * `preventDefault` in it was ignored ("Unable to preventDefault inside passive event listener
   * invocation."). The wheel reached the Bot's page and also scrolled whatever on this page was
   * under it, the frame that holds this screen included, and Ctrl and the wheel zoomed this page.
   *
   * Gated on `driving` alone for the reason the keyboard is: a reconnect that could not confirm
   * ownership used to take the wheel away silently, which is the one thing a person scrolling a
   * page notices immediately.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!driving || !canvas) return;
    const onWheel = (event: WheelEvent) => {
      const point = at(event);
      if (!point) return;
      event.preventDefault();
      /*
       * Chrome's `Input.dispatchMouseEvent` reads the delta as pixels. A browser that reports the
       * wheel in lines (`deltaMode` 1) or pages (2) sends 3 rather than ~100, so a notch of the
       * wheel moved the Bot's page by three pixels and read as "the wheel does nothing". One line is
       * 16px, which is what Chrome itself uses, and one page is the height of the page being
       * scrolled -- the frame Chrome is casting, not this canvas, which is scaled to fit.
       */
      const perPage = frameSize.current?.height ?? canvas.clientHeight;
      const scale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, perPage) : 1;
      send({
        type: "wheel",
        ...point,
        deltaX: event.deltaX * scale,
        deltaY: event.deltaY * scale,
        modifiers: modifierBits(event),
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [driving, at, send]);

  const [draft, setDraft] = useState<string | null>(null);
  const navigate = (message: Record<string, unknown>) => {
    if (!driving) return;
    setNavProblem(null);
    setNavBusy(true);
    // A socket that is not up yet gets said out loud rather than leaving a spinner that never stops.
    if (!send(message)) {
      setNavBusy(false);
      setNavProblem("屏幕正在重新连接，稍后再试。");
    }
  };
  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    const url = addressToUrl(draft ?? pageUrl);
    if (!url) return;
    setDraft(null);
    lastAttempt.current = url;
    setPageUrl(url);
    (document.activeElement as HTMLElement | null)?.blur?.();
    navigate({ type: "navigate", url });
  };
  const toolbarDisabled = !driving || !connected;
  const openUrlRef = useRef<(url: string) => boolean>(() => false);
  openUrlRef.current = (url: string) => {
    if (!driving) return false;
    setDraft(null);
    lastAttempt.current = url;
    setPageUrl(url);
    navigate({ type: "navigate", url });
    return true;
  };
  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      openUrl: (url) => openUrlRef.current(url),
      // Whether the screen's socket can carry input right now. Who may drive it is another question,
      // answered by the control state and enforced by the computer.
      ready: () => socketRef.current?.readyState === WebSocket.OPEN,
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef]);

  return (
    <div className="computer-live flex flex-col gap-2">
      {/* 浏览器外壳：标签栏 / 地址栏 / 收藏栏放在同一块玻璃工具条上（DESIGN §96）。 */}
      {aboveUrlbar || driving || belowUrlbar ? (
      <div className="computer-chrome">
      {aboveUrlbar}
      {driving ? (
        <form
          aria-label={"浏览器地址栏"}
          className="computer-urlbar"
          onSubmit={submitAddress}
        >
          <button
            aria-label={"后退"}
            className="computer-urlbar-btn"
            disabled={toolbarDisabled}
            onClick={() => navigate({ type: "history", action: "back" })}
            title={"后退"}
            type="button"
          >
            <IconArrowLeft className="size-4" />
          </button>
          <button
            aria-label={"前进"}
            className="computer-urlbar-btn"
            disabled={toolbarDisabled}
            onClick={() => navigate({ type: "history", action: "forward" })}
            title={"前进"}
            type="button"
          >
            <IconArrowRight className="size-4" />
          </button>
          <button
            aria-label={"刷新"}
            className="computer-urlbar-btn"
            disabled={toolbarDisabled}
            onClick={() => navigate({ type: "history", action: "reload" })}
            title={"刷新"}
            type="button"
          >
            {navBusy ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              <IconRefresh className="size-4" />
            )}
          </button>
          <label className="computer-urlbar-field">
            <IconWorld className="size-4 shrink-0 opacity-60" />
            <input
              aria-label={"网址"}
              autoComplete="off"
              autoCorrect="off"
              disabled={toolbarDisabled}
              onBlur={() => setDraft(null)}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => {
                setDraft(pageUrl);
                event.currentTarget.select();
              }}
              placeholder={"输入网址或搜索内容，回车打开"}
              spellCheck={false}
              value={draft ?? pageUrl}
            />
          </label>
          {urlbarEnd?.(pageUrl)}
        </form>
      ) : null}
      {belowUrlbar}
      {driving && navProblem ? (
        <p className="computer-urlbar-problem" role="alert">
          {navProblem}
        </p>
      ) : null}
      </div>
      ) : null}
      <div
        className="computer-screen relative w-full overflow-hidden rounded-xl"
        style={{ aspectRatio }}
      >
    <canvas
      ref={canvasRef}
      className={`block h-auto w-full ${driving ? "cursor-crosshair" : ""}`}
      // Only forward input during takeover.
      {...(driving
        ? {
            onMouseDown: onMouse("pressed"),
            onMouseUp: onMouse("released"),
            onMouseMove: onMouse("moved"),
            onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
          }
        : {})}
      aria-label={
        driving
          ? "助理的屏幕。您有控制权：点击并在此输入。"
          : "助理的屏幕，实时"
      }
      data-connected={connected}
      data-has-frame={hasFrame}
    />
        {hasFrame && blankPage && !reconnecting ? (
          <div
            className="computer-frame computer-idle computer-screen-idle"
            data-blank-page="true"
            role="status"
          >
            <IconWorld className="computer-idle-ic" />
            <span className="computer-idle-t">{"浏览器空闲"}</span>
            <span className="computer-idle-s">
              {driving
                ? "还没有打开网页。在上方地址栏输入网址，回车打开。"
                : "机器人还没有打开网页。接管后可以在地址栏输入网址。"}
            </span>
          </div>
        ) : null}
        {hasFrame ? null : (
          <div className="computer-screen-wait" role="status">
            <IconLoader2 className="size-5 animate-spin" />
            <span>{"正在连接屏幕…"}</span>
          </div>
        )}
        {hasFrame && reconnecting ? (
          <div className="computer-screen-wait is-dim" role="status">
            <IconLoader2 className="size-5 animate-spin" />
            <span>{"正在重新连接…"}</span>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
