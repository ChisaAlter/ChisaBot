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
  onMessage: (event: { data: unknown }) => void;
  schedule?: (run: () => void, delay: number) => () => void;
};
const BACKOFF = [500, 1000, 2000, 4000, 8000];
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
        if (
          /superseded|another (?:viewer|screen)|opened elsewhere|watched somewhere else|another tab/i.test(
            message.error ?? "",
          )
        ) {
          stopped = true;
          cancelTimer?.();
          options.onDisconnect();
          options.onReady(false);
          options.onProblem(
            message.error ??
              "This screen is open in another tab. Retry to take it here.",
          );
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
