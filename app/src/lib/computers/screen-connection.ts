/** Small transport lifecycle shared by the live viewer and deterministic reconnect tests. */
export type ScreenSocket = {
  onopen: (() => void | Promise<void>) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  close: () => void;
};
type Options = {
  open: () => ScreenSocket;
  onReady: (ready: boolean) => void;
  onProblem: (problem: string | null) => void;
  onDisconnect: () => void;
  /**
   * The screen ended for good: another window took it (old servers), the computer stopped, or the
   * socket was replaced. Nothing will reconnect by itself, so the view must not draw its
   * "正在重新连接…" overlay — that is what stacked a false "reconnecting" on top of the stop message
   * (2026-10-22 screenshot: "这块屏幕现在在另一个窗口看着… / 正在重新连接…").
   */
  onStopped?: (problem: string) => void;
  onMessage: (event: { data: unknown }) => void;
  schedule?: (run: () => void, delay: number) => () => void;
};
/**
 * Errors after which there is nothing to reconnect to: retrying would only flap. Kept in one place so
 * the server's wording can change in either language without the view promising a reconnect it will
 * not make.
 */
const TERMINAL =
  /superseded|another (?:viewer|screen)|opened elsewhere|watched somewhere else|another tab|computer stopped|screen ended|no longer live/i;
/**
 * Retry delays, in order. About a minute and a half in total, because that is what a deploy looks
 * like from the browser: the container is replaced and the socket refused for tens of seconds. Five
 * attempts over 15s gave up in the middle of every update and left a permanent "连接已断开，点重试"
 * on screen (2026-10-22) — the update produced the error, not a broken computer. The cap keeps a
 * genuinely dead deployment from being retried forever.
 */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000];
export function connectScreen(options: Options) {
  let stopped = false;
  let attempts = 0;
  let socket: ScreenSocket | undefined;
  let cancelTimer: (() => void) | undefined;
  const schedule =
    options.schedule ??
    ((run, delay) => {
      const timer = setTimeout(run, delay);
      return () => clearTimeout(timer);
    });
  const connect = () => {
    if (stopped) return;
    const current = options.open();
    socket = current;
    let disconnected = false;
    const owns = () => !stopped && socket === current && !disconnected;
    const disconnect = () => {
      if (!owns()) return;
      disconnected = true;
      options.onDisconnect();
      options.onReady(false);
      const delay = BACKOFF[attempts++];
      if (delay === undefined) {
        options.onProblem("屏幕连接已断开。点重试再连。");
        return;
      }
      options.onProblem("正在重新连接屏幕…");
      cancelTimer = schedule(connect, delay);
    };
    current.onopen = () => {
      if (!owns()) return;
      options.onProblem(null);
      /*
       * OPEN IS READY. This used to answer a second question as well — "did the ownership read,
       * taken right now, say a person still holds the wheel?" — and only report ready for a socket
       * that passed both. A reconnect whose ownership read failed therefore left `ready` false for
       * the rest of the session: the screen kept streaming, every click, keystroke, address-bar
       * navigation and wheel turn was dropped without a word, and nothing ever asked again. The two
       * facts are not the same one, and folding them together made a failed read look like a dead
       * screen.
       *
       * Who holds the wheel is the control state's answer, polled every second and shown in the
       * footer; this module only carries the screen. The computer refuses input from someone who is
       * not driving and says so, which is a far better answer than silence.
       */
      options.onReady(true);
    };
    current.onmessage = (event) => {
      if (!owns()) return;
      let message: { type?: string; error?: string } | undefined;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        /* Frame parser handles malformed input. */
      }
      if (message?.type === "error") {
        // The server deliberately leaves superseded sockets open. Never compete with the other tab.
        if (TERMINAL.test(message.error ?? "")) {
          stopped = true;
          cancelTimer?.();
          options.onReady(false);
          const reason =
            message.error ??
            "This screen is open in another tab. Retry to take it here.";
          // Stopped, not disconnected: there is no reconnect to draw. The view shows the reason and
          // its Retry button and this module stays quiet until the caller opens a new connection.
          if (options.onStopped) options.onStopped(reason);
          else options.onProblem(reason);
          current.close();
          return;
        }
      }
      // A frame means this socket recovered, so the next drop starts the backoff over. Without
      // this, drops a viewer had already recovered from used up the retries for good.
      // Frames and application keepalives both prove the socket is live (static pages only send pings).
      if (message?.type === "frame" || message?.type === "ping") attempts = 0;
      options.onMessage(event);
    };
    current.onerror = () => {
      disconnect();
      current.close();
    };
    current.onclose = disconnect;
  };
  connect();
  return {
    stop: () => {
      stopped = true;
      cancelTimer?.();
      options.onReady(false);
      socket?.close();
    },
  };
}
