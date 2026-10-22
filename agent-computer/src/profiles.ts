/**
 * The Bot's browser, and the profile that outlives it.
 *
 * A persistent profile lets a Bot remain signed in across process and container restarts.
 *
 * Persistent context, not a saved storage state. Playwright can export cookies and localStorage as
 * JSON and replay them, and that is the wrong tool here: it captures what the automation knew about,
 * on demand, and misses IndexedDB, service workers, and anything written after the snapshot.
 * `launchPersistentContext` points Chromium at a real user-data directory, so the browser persists
 * its own state the way it does on a desktop. On a mounted volume, that directory outlives the
 * container.
 *
 * Profile behavior in this image and Playwright version:
 *   - A cookie with an expiry survives close-and-reopen. So does localStorage.
 *   - A session cookie (no expiry) does not: Chromium drops those on restart, exactly as a desktop
 *     browser does. Here a restart is a pod being deleted by an idle suspend or an image update, so
 *     `session-cookies.ts` writes them to a file in the same profile and puts them back on launch.
 *   - Killing the browser process with SIGKILL leaves no stale singleton lock in the profile, and the
 *     profile reopens with its cookies intact. The widely-reported `SingletonLock` breakage does not
 *     reproduce here. The defensive sweep below stays anyway, because it is three lines and the
 *     failure it prevents is "the computer never comes back".
 *
 * One profile per Bot. Two Bots sharing a profile share their logins, which makes "this Bot may reach
 * Salesforce" unenforceable: whatever one signs into, the other is signed into. Each Bot gets its own
 * directory, so its cookies and its storage are its own.
 *
 * A profile is not a container. Two Bots in this process are isolated from each other's cookies, not
 * from each other's kernel, filesystem or memory.
 *
 * Container-per-Bot needs something privileged to create containers, and the API server must never be
 * that: access to the Docker socket is unrestricted root on the host. Stop and reset are
 * operations this process applies to its own browser, so the same design works under Compose,
 * Kubernetes or ECS, where the orchestrator's own restart policy brings a process back.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { profileDirectoryFor } from "./bot-id";
import { chooseEvictions, chooseIdle } from "./browser-eviction";
import { browserRuntimeFromEnv } from "./browser-runtime";
import { egressFor, egressLabel } from "./egress";
import { numberFromEnv, settleWithin, withDeadline } from "./env";
import { chooseLivePage } from "./live-page";
import { whileNavigating } from "./start-page";
import {
  findTab,
  MAX_TABS,
  neighbourAfterClose,
  openTabs,
  RESTORE_TABS,
  readSavedTabs,
  restorableUrl,
  type SavedTabs,
  savedTabsFrom,
  TAB_LIMIT_MESSAGE,
  TabError,
  type TabInfo,
  type TabsView,
  tabIdOf,
  tabTitle,
  within,
  writeSavedTabs,
} from "./tabs";
import { botIdsIn } from "./profile-listing";
import {
  type SessionCookieKeeper,
  sessionCookieKeeper,
} from "./session-cookies";

// Re-exported so callers that already import it from here do not change, while the test imports it
// from the playwright-free `./env` instead of pulling this module's browser driver in with it.
export { numberFromEnv };

/** The viewport, which is what a person's click coordinates are relative to. */
export const VIEWPORT = { width: 1280, height: 800 };

/**
 * Files Chromium uses to refuse a second instance on one profile.
 *
 * Swept on the way in rather than the way out, because the way out is the case that does not happen:
 * a container that is killed does not get to run cleanup. If this process is starting, no browser of
 * ours is running, so any lock here is by definition from a life that has already ended.
 */
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/**
 * How the browser is started, and why each flag is here.
 *
 * `--password-store=basic` makes a durable profile work in a container. Chromium normally encrypts
 * cookie values with a desktop keyring; containers have no stable gnome-keyring or kwallet, so the
 * default fallback can make stored cookies unreadable after restart.
 *
 * `basic` pins it to Chromium's own fixed fallback, which is deterministic and survives restarts.
 * This is obfuscation at rest, not protection. Anything that can read the volume can read the
 * cookies. The volume's own permissions are the security boundary.
 */
/**
 * Whether Chromium gets to use its own sandbox.
 *
 * OFF BY DEFAULT, AND THAT IS NOT A PREFERENCE. Chromium's sandbox creates user namespaces, and
 * Docker's default seccomp profile blocks the syscall it needs, so a container that does nothing
 * special gets `No usable sandbox!` and the browser will not start at all. Verified both ways in
 * this image: default profile fails, relaxed profile renders.
 *
 * TURN IT ON WHERE THE HOST ALLOWS IT. On a VM or self-hosted Docker, run with a Chromium seccomp
 * profile and set `COMPUTER_SANDBOX=on`. That is strictly better than everything below, because it
 * is the boundary Chromium itself maintains against the pages it renders.
 *
 * WHERE IT CANNOT BE ON. Serverless container platforms do not let you set a seccomp profile or add
 * capabilities; Fargate restricts `CAP_SYS_ADMIN` explicitly. There the sandbox is unavailable, and
 * the compensating controls are the ones this image already has, a non-root user, plus gVisor
 * underneath, which Cloud Run applies to everything by default.
 *
 * Said out loud at start-up either way. An operator should not have to read this file to find out
 * whether the browser rendering the open internet is sandboxed.
 */
const BROWSER_RUNTIME = browserRuntimeFromEnv(process.env);
const LOCAL_CHROME = BROWSER_RUNTIME.backend === "local-chrome";
// Native Chrome has no container boundary. Always retain its own process sandbox and OS keychain.
const SANDBOX_ENABLED = LOCAL_CHROME || process.env.COMPUTER_SANDBOX === "on";

const LAUNCH_ARGS = [
  ...(SANDBOX_ENABLED ? [] : ["--no-sandbox"]),
  "--disable-dev-shm-usage",
  ...(LOCAL_CHROME ? [] : ["--password-store=basic"]),
  // Drop the automation signals Chromium sets for itself, so a real person who takes the wheel can
  // sign in to a site that refuses obvious automation (Google among them). This is the flag, not a
  // JS patch of `navigator.webdriver`: the flag turns the property off at the source, where spoofing
  // it from a script leaves the other tells a detector cross-checks. It does not change what the Bot
  // may do; the governed path is unchanged. Full Chromium is selected explicitly in both modes;
  // headed mode also provides a window a person can use on the native desktop or virtual display.
  "--disable-blink-features=AutomationControlled",
  // 云端没有显卡：不开这个，Chromium 不再自动退回软件 WebGL，要 WebGL 的网站（Hark 登录页的背景、地图、
  // 很多 3D / 画布页面）只显示「需要 WebGL」（DESIGN.md §101，2026-10-18 实测）。本机 Chrome 有显卡，不加。
  ...(LOCAL_CHROME ? [] : ["--enable-unsafe-swiftshader"]),
];

/**
 * WebRTC kept inside the proxy, written into the profile before Chromium reads it.
 *
 * Chromium sends WebRTC over UDP straight past an HTTP proxy unless told not to, so a page in a Bot's
 * browser could reach the network around the egress filter. `disable_non_proxied_udp` allows only
 * UDP through a proxy, and an HTTP proxy carries none, so WebRTC goes over the proxy or not at all.
 * A preference rather than the `--force-webrtc-ip-handling-policy` switch, which current Chromium
 * no longer reads (measured: the switch on the command line, packets still sent). Merged into
 * whatever Preferences the profile already has, so nothing else the profile remembers is lost.
 */
export async function keepWebRtcInsideProxy(profileDir: string) {
  const file = join(profileDir, "Default", "Preferences");
  let preferences: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      preferences = parsed;
  } catch {
    // No Preferences yet (a new profile), or one Chromium never finished writing: start clean.
  }
  const webrtc =
    preferences.webrtc && typeof preferences.webrtc === "object"
      ? (preferences.webrtc as Record<string, unknown>)
      : {};
  if (webrtc.ip_handling_policy === "disable_non_proxied_udp") return;
  preferences.webrtc = {
    ...webrtc,
    ip_handling_policy: "disable_non_proxied_udp",
  };
  await mkdir(join(profileDir, "Default"), { recursive: true });
  await writeFile(file, JSON.stringify(preferences));
}

console.info(
  JSON.stringify({
    type: "computer-sandbox",
    sandbox: SANDBOX_ENABLED ? "on" : "off",
    ...(SANDBOX_ENABLED
      ? {
          note: "Chromium's own sandbox is in use. It will refuse to start if the host does not permit user namespaces.",
        }
      : {
          note: "Chromium runs without its own sandbox, which is the only thing that works under a default container seccomp profile. Set COMPUTER_SANDBOX=on where the host allows it.",
        }),
  }),
);

/**
 * How long to let a closing browser finish writing before moving on.
 *
 * The profile's Cookies file may be rewritten shortly after `close()` is called. This delay stays
 * clear of that window while remaining inside the container's
 * 30s stop grace period, so a shutdown never becomes the reason a computer does not come back.
 */
const CLOSE_SETTLE_MS = 2_000;

/**
 * How long telling a viewer its browser went away may take before the close carries on without it.
 *
 * The close is what has to happen; the announcement is courtesy. Unbounded, one screencast that will
 * not stop would hold a browser close open, and because the cap evicts from inside another Bot's
 * launch, it would hold that launch and everything queued behind it too. On the way out it would
 * keep every profile from flushing until the container was killed.
 */
const ANNOUNCE_BUDGET_MS = 2_000;

/**
 * How long a stop or reset waits for a launch it is racing.
 *
 * Long enough for a cold Chromium start, which is what it is waiting for, and bounded so a launch
 * that never finishes cannot hold a request open forever. Timing out leaves the browser running,
 * which is the same answer the caller got before this waited at all.
 */
const LAUNCH_WAIT_MS = 30_000;

/**
 * The longest one launch may take before it is abandoned.
 *
 * A launch is awaited by every caller asking for this Bot's page (`starting`), so one that never
 * settles pins the Bot: every navigate hangs, every admitted action keeps its barrier lease, and
 * 「接管」 times out until the container restarts (2026-10-17 production incident, where a half-dead
 * browser's cleanup never answered). Past this the launch is dropped, the next call starts a fresh
 * one, and whatever the abandoned launch produces later is closed instead of installed.
 */
const LAUNCH_DEADLINE_MS = numberFromEnv("COMPUTER_LAUNCH_DEADLINE_MS", 90_000);

/** Chromium's own start timeout, inside the deadline above. */
const CHROMIUM_LAUNCH_TIMEOUT_MS = 60_000;

/** A half-dead browser's leftovers (cookie keeper, context close) get this long, then are dropped. */
const TEARDOWN_BUDGET_MS = 5_000;

/** A close that never answers must not hold a stop, an eviction or a launch open. */
const CLOSE_BUDGET_MS = 10_000;

export class LaunchAbandonedError extends Error {
  constructor(botId: string, ms: number) {
    super(
      `The browser did not start within ${Math.round(ms / 1000)} seconds and was abandoned; the next request starts a fresh one.`,
    );
    this.name = "LaunchAbandonedError";
    void botId;
  }
}

/** What a Bot's browser looks like from outside. */
export type BotBrowser = {
  botId: string;
  context: BrowserContext;
  page: Page;
};

export type ProfileSummary = {
  botId: string;
  /** Whether a browser is running for this Bot right now. */
  running: boolean;
  /** When this Bot's browser was last started, or null if it is not running. */
  startedAt: string | null;
  /** The proxy its traffic leaves through, by host only. Never the credentials. */
  egress: string | null;
};

/**
 * Close a context and wait for Chromium to finish writing.
 *
 * Chromium batches cookie writes and commits them as it exits, while `close()` only asks it to exit.
 * Bounded, because a shutdown that hangs must never be the reason a computer does not come back. We
 * would rather lose the last few seconds of cookies than never restart.
 */
async function closeAndWait(context: BrowserContext): Promise<void> {
  await settleWithin(context.close(), CLOSE_BUDGET_MS);
  // A fixed settle is used because persistent contexts do not expose a reliable browser-exit signal.
  await new Promise((resolve) => setTimeout(resolve, CLOSE_SETTLE_MS));
}

/**
 * How many browsers one computer holds at once.
 *
 * There was no cap. A context was started the first time each Bot was used and kept, and the only
 * things that dropped one were an explicit stop, a browser that had already died, and shutdown. A
 * deployment where every employee has a Bot therefore trends toward one resident Chromium per
 * employee in a single container, at a few hundred MB each, until the container is killed for memory
 * and `page()` relaunches its way back to the same state.
 *
 * A cap rather than only an idle timeout, because the failure is concurrent breadth rather than age:
 * fifty people using their Bots inside the same minute are fifty live browsers and none of them are
 * idle. The least recently used is closed, which is the one whose Bot has been quiet longest.
 *
 * Closing is not losing anything. The profile is on disk, so a Bot whose browser was closed starts
 * again where it left off, which is what `stop` already means here.
 */
const MAX_LIVE_BROWSERS = numberFromEnv("COMPUTER_MAX_BROWSERS", 8);

/**
 * How long a browser may sit untouched before it is closed.
 *
 * The other half. A deployment under the cap still holds a browser per Bot that was used once last
 * Tuesday, and that memory is doing nothing for anybody.
 *
 * Zero is the documented way to say "keep them resident", which is why it is read as a value here
 * rather than as a value that is not set. Read like the cap, an operator who wrote it got the
 * default back and the sweep they had switched off carried on closing their browsers.
 */
const IDLE_TIMEOUT_MS = numberFromEnv("COMPUTER_BROWSER_IDLE_MS", 30 * 60_000, {
  zeroSwitchesItOff: true,
});

/** How often the idle sweep looks. Cheap: it walks a map of at most `MAX_LIVE_BROWSERS`. */
const IDLE_SWEEP_MS = 60_000;

/**
 * Told whenever a Bot's browser is closed and forgotten, before the close is waited on.
 *
 * Exists because closing a browser is not the whole of stopping a computer: anything still pointed
 * at the page it was showing has to be taken down with it, and the live screen's follow loop calls
 * back in for a page every second, which is a launch path. A viewer left running therefore relaunches
 * whatever was just closed, so a stopped computer restarts itself and an idle one never goes away.
 *
 * It is announced here rather than called from the two request handlers because a browser closes
 * from more places than those: the cap after a launch and the idle sweep close one without any
 * request being involved. Hanging the teardown off the close itself covers those by construction,
 * where remembering to add a call at each new handler does not.
 *
 * Awaited before the context closes, so a follow loop cannot squeeze a relaunch into the gap.
 */
export type BrowserClosed = (botId: string) => void | Promise<void>;

export function createProfiles(root: string, onClosed: BrowserClosed) {
  type LiveBrowser = {
    context: BrowserContext;
    page: Page;
    startedAt: string;
    /** When this Bot last asked for its page. Decides what the cap and the sweep close. */
    usedAt: number;
    /** Point `page` at whatever is open now. Called on every page opening and closing. */
    retarget: () => void;
    /**
     * 明确选中的标签（人或机器人切过去的、刚新开的）。关掉了就回到「最新打开的那页」。
     * 网站弹出的窗口也会成为 pinned，和以前「跟着弹窗走」一样。
     */
    pinned?: Page;
    /** 标签有变化（开 / 关 / 切 / 跳转）时调用：防抖写盘。 */
    tabsChanged: () => void;
    /** Keeps this browser's session cookies on the profile volume. Absent for a native Chrome. */
    sessionCookies?: SessionCookieKeeper;
  };

  /**
   * Write a browser's session cookies one last time and stop checking them.
   *
   * Before the close, because a closed context has no cookies to read. Bounded like the
   * announcement, because a browser that will not answer must not hold a close open.
   */
  const keepSessionCookies = async (running: LiveBrowser): Promise<void> => {
    const keeper = running.sessionCookies;
    if (!keeper) return;
    await settleWithin(
      keeper.save().then(() => keeper.stop()),
      ANNOUNCE_BUDGET_MS,
    );
  };

  /** One running browser per Bot, up to {@link MAX_LIVE_BROWSERS}. */
  const live = new Map<string, LiveBrowser>();
  /** Launches in flight, so a cold computer is started once however many callers ask at once. */
  const starting = new Map<string, Promise<Page>>();
  /** Closes and resets in flight, so a Bot's browser is never reopened from a profile being closed or deleted. */
  const closing = new Map<string, Promise<void>>();

  const whileClosing = async (
    botId: string,
    work: () => Promise<void>,
  ): Promise<void> => {
    const { promise: done, resolve } = Promise.withResolvers<void>();
    const held = Promise.all([closing.get(botId), done]).then(() => undefined);
    closing.set(botId, held);
    try {
      await work();
    } finally {
      resolve();
      void held.then(() => {
        if (closing.get(botId) === held) closing.delete(botId);
      });
    }
  };

  // Checked, not joined. `join(root, botId)` normalizes `..` away, so a Bot id of `../workspace`
  // used to resolve outside the root and `reset` would delete whatever was there.
  const directoryFor = (botId: string): string =>
    profileDirectoryFor(root, botId);

  /**
   * Close one Bot's browser and forget it.
   *
   * Gracefully, so Chromium flushes the profile: the whole point of closing one is that the Bot's
   * logins survive and its next request starts where it left off.
   */
  const evict = async (botId: string, reason: string): Promise<boolean> => {
    const running = live.get(botId);
    if (!running) return false;
    live.delete(botId);
    console.info(
      JSON.stringify({ type: "computer-browser-closed", botId, reason }),
    );
    // Before the close, so whatever was watching this browser is taken down while it is still the
    // browser being closed. A live screen surviving here relaunches it a second later.
    //
    // Bounded, because this now sits on the launch path: `enforceCap` evicts from inside another
    // Bot's launch, so a teardown that never answers would pin that launch and every caller waiting
    // on it. The close is the thing that must happen; being told about it is best effort.
    await whileClosing(botId, async () => {
      await settleWithin(Promise.resolve(onClosed(botId)), ANNOUNCE_BUDGET_MS);
      await keepSessionCookies(running);
      await closeAndWait(running.context).catch(() => undefined);
    });
    return true;
  };

  /**
   * Keep the number of running browsers under the cap.
   *
   * Least recently used first, which is the Bot that has been quiet longest. Called after a launch
   * rather than before, so the Bot that just asked is never the one closed.
   */
  const enforceCap = async (): Promise<void> => {
    for (const botId of chooseEvictions(live.entries(), MAX_LIVE_BROWSERS)) {
      await evict(botId, "the cap on running browsers was reached");
    }
  };

  /**
   * Close browsers nothing has touched for a while.
   *
   * The cap answers concurrent breadth; this answers a Bot used once last Tuesday whose browser is
   * still resident and doing nothing for anybody.
   */
  const sweepIdle = async (): Promise<void> => {
    for (const botId of chooseIdle(
      live.entries(),
      IDLE_TIMEOUT_MS,
      Date.now(),
    )) {
      await evict(botId, "it had been idle");
    }
  };

  const idleSweep = setInterval(() => {
    void sweepIdle().catch(() => undefined);
  }, IDLE_SWEEP_MS);
  // Housekeeping must not hold the process open on the way out.
  idleSweep.unref?.();

  /**
   * Close a browser a person asked to close, including one that is still starting.
   *
   * `evict` only knows about browsers already in `live`, and a launch does not land there until it
   * finishes. A request arriving inside that window therefore passed straight through: it answered
   * "nothing was running", the launch completed a moment later, and the browser the person asked to
   * close was up with the live screen still on it and the follow loop keeping it marked recently
   * used, so the idle sweep would not reclaim it either. Reset was worse, deleting the profile
   * directory that the finishing launch then recreated.
   *
   * So a request waits for the launch it is racing and closes what it produced. This is deliberately
   * NOT inside `evict`: the cap evicts from inside a launch, and an `evict` that waited on `starting`
   * could wait on the very launch it is running under.
   */
  const closeOnRequest = async (
    botId: string,
    reason: string,
  ): Promise<boolean> => {
    // Its failure is the launch's own to report; here it only means there is nothing left to close.
    await settleWithin(starting.get(botId), LAUNCH_WAIT_MS);
    return evict(botId, reason);
  };

  const sweepLocks = async (dir: string): Promise<void> => {
    await Promise.all(
      SINGLETON_FILES.map((name) =>
        rm(join(dir, name), { force: true }).catch(() => undefined),
      ),
    );
  };


  /** 恢复保存的标签：第一页用启动时那张空白页，其余新开；最后切到上次的当前标签。 */
  async function restoreTabs(record: LiveBrowser, saved: SavedTabs): Promise<void> {
    const go = (target: Page, url: string) =>
      void whileNavigating(target, () =>
        target.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }),
      ).catch(() => undefined);
    // 在启动里等页面建好（不等加载），这样启动返回时当前标签已经定了，机器人第一下操作不会被后建的标签抢走。
    await (async () => {
      const opened: Page[] = [];
      const first = record.page;
      if (first.url() === "about:blank" && saved.tabs[0]) {
        opened.push(first);
        go(first, saved.tabs[0].url);
      }
      for (const tab of saved.tabs.slice(opened.length)) {
        if (openTabs(record.context.pages()).length >= MAX_TABS) break;
        const created = await record.context.newPage().catch(() => undefined);
        if (!created) break;
        opened.push(created);
        go(created, tab.url);
      }
      const wanted = opened[saved.active] ?? opened[0];
      if (wanted && !wanted.isClosed()) {
        record.pinned = wanted;
        record.retarget();
      }
    })().catch(() => undefined);
  }

  async function describeTab(page: Page, active: boolean): Promise<TabInfo> {
    const url = page.url();
    const title = await within(page.title(), 800, "");
    return {
      id: tabIdOf(page),
      url,
      title: tabTitle(url, title),
      active,
      ...(await faviconOf(page)),
    };
  }

  /** 网页自己声明的图标，经浏览器自己的网络（同一个代理）取回，转成 data:，按地址缓存。 */
  const icons = new Map<string, string | null>();
  async function faviconOf(page: Page): Promise<{ favicon?: string }> {
    const url = page.url();
    if (!restorableUrl(url)) return {};
    let href: string | null = null;
    try {
      href = await within(
        page.evaluate(() => {
          const link = document.querySelector<HTMLLinkElement>(
            'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
          );
          return link?.href || new URL("/favicon.ico", location.href).href;
        }),
        600,
        null as string | null,
      );
    } catch {
      href = null;
    }
    if (!href || !/^https?:\/\//i.test(href)) return {};
    if (icons.has(href)) {
      const known = icons.get(href);
      return known ? { favicon: known } : {};
    }
    if (icons.size > 400) icons.clear();
    icons.set(href, null);
    void (async () => {
      try {
        const response = await page.context().request.get(href as string, { timeout: 4_000, maxRedirects: 3 });
        if (!response.ok()) return;
        const body = await response.body();
        if (body.length === 0 || body.length > 64 * 1024) return;
        const type = (response.headers()["content-type"] ?? "").split(";")[0]?.trim() ?? "";
        const mime = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)$/.test(type)
          ? type
          : body[0] === 0x89
            ? "image/png"
            : "image/x-icon";
        icons.set(href as string, `data:${mime};base64,${body.toString("base64")}`);
      } catch {
        // 拿不到就画首字母。
      }
    })();
    return {};
  }

  /** 正在运行的浏览器；没在运行就拉起来（开 / 切 / 关标签都要真的浏览器）。 */
  async function running(botId: string): Promise<LiveBrowser> {
    await api.page(botId);
    const record = live.get(botId);
    if (!record) throw new TabError("浏览器没有在运行。", 409);
    return record;
  }

  const api = {
    /**
     * The Bot's page, starting its browser if it is not running.
     *
     * Started on first use rather than at boot, and re-created if it died: a crashed Chromium would
     * otherwise leave this process alive and answering the same error for every request until the
     * container restarts. This turns that into one slow request instead of an outage.
     */
    async page(botId: string): Promise<Page> {
      // Only when something is closing: an unconditional await would let a stop slip in ahead of the launch.
      const closingNow = closing.get(botId);
      // Bounded: every step of a close is bounded, but a close that still never ends must not pin
      // this Bot's page for ever (the launch below sweeps the profile's locks either way).
      if (closingNow) await settleWithin(closingNow, LAUNCH_WAIT_MS);
      /*
       * One launch at a time per Bot. Calls that arrive during a launch wait for that launch instead
       * of starting another browser against the same profile directory.
       */
      const launching = starting.get(botId);
      if (launching) return launching;

      const existing = live.get(botId);
      // Asked before the page is judged, so a close that has not been delivered yet does not read as
      // a browser that has gone.
      existing?.retarget();
      if (
        existing?.context.browser()?.isConnected() &&
        !existing.page.isClosed()
      ) {
        // Touched on every use, which is what makes "least recently used" mean anything.
        existing.usedAt = Date.now();
        return existing.page;
      }
      // 半死的旧浏览器在 launch 里清理：先登记 starting，再等待关闭，避免并发请求各自拉起一个 Chromium
      // 抢同一个配置目录（审查发现：崩溃恢复时可能同时开两个浏览器、损坏配置）。
      let abandoned = false;
      const launch = (async () => {
        if (existing) {
          // Half-dead: the browser went away, or its page did. Dropped rather than repaired, because a
          // context whose browser has gone is not usable for anything.
          //
          // The one close that does not announce itself, deliberately. A replacement is launched on the
          // next line and the live screen's follow loop re-attaches to it within the second, so this is
          // a browser being swapped rather than one going away. Telling the viewer here would end a
          // screen that is about to be fine, which is the opposite of what the announcement is for.
          // Bounded: a browser that went away can leave a cookie read or a close that never answers,
          // and this sits inside `starting`, which every caller for this Bot is waiting on.
          live.delete(botId);
          await settleWithin(existing.sessionCookies?.stop(), TEARDOWN_BUDGET_MS);
          await settleWithin(existing.context.close(), TEARDOWN_BUDGET_MS);
        }

        const dir = directoryFor(botId);
        // A second native helper can target the same data root on another port. Do not remove an
        // active Chrome profile's lock; Chrome reports contention and handles its own stale locks.
        if (!LOCAL_CHROME) {
          await sweepLocks(dir);
          await keepWebRtcInsideProxy(dir);
        }
        const proxy = egressFor(botId, process.env);
        const context = await chromium.launchPersistentContext(dir, {
          channel: BROWSER_RUNTIME.channel,
          headless: BROWSER_RUNTIME.mode === "headless",
          args: LAUNCH_ARGS,
          // Playwright launches with `--enable-automation`, which sets `navigator.webdriver` and the
          // "controlled by automated software" banner. Dropped for the same reason as the flag above:
          // a person who takes the wheel should be able to sign in. Named explicitly so the sandbox
          // default args Playwright still supplies are otherwise left intact.
          ignoreDefaultArgs: ["--enable-automation"],
          // Playwright adds `--no-sandbox` on its own unless told otherwise, so leaving this out
          // means the flag above decides nothing and a deployment that asked for the sandbox does
          // not get one. Verified by reading the launched process arguments, not by trusting either.
          chromiumSandbox: SANDBOX_ENABLED,
          viewport: VIEWPORT,
          // This process owns shutdown. Playwright's signal handlers kill Chromium immediately on
          // SIGTERM, before pending cookie writes have time to flush.
          handleSIGTERM: false,
          handleSIGINT: false,
          handleSIGHUP: false,
          timeout: CHROMIUM_LAUNCH_TIMEOUT_MS,
          ...(proxy ? { proxy } : {}),
        });
        if (abandoned) {
          // Too late: callers were told it failed and a newer launch may already own the profile.
          await settleWithin(context.close(), CLOSE_BUDGET_MS);
          throw new LaunchAbandonedError(botId, LAUNCH_DEADLINE_MS);
        }
        /*
         * Session cookies back before anything navigates, so the first request a site sees from this
         * launch is already signed in. Not for a native Chrome: its cookies are protected by the OS
         * keychain, and a plain file beside them would undo that. The container profile uses the
         * basic password store, so the file adds no exposure the volume did not already have.
         */
        const sessionCookies = LOCAL_CHROME
          ? undefined
          : sessionCookieKeeper(botId, dir, context);
        if (sessionCookies) {
          await sessionCookies.restore().catch((error: unknown) => {
            console.info(
              JSON.stringify({
                type: "computer-session-cookies-not-restored",
                botId,
                reason: error instanceof Error ? error.message : String(error),
              }),
            );
          });
          sessionCookies.start();
        }
        // Persistent contexts open with a page already; reuse it rather than leaving an extra blank tab.
        const page = context.pages()[0] ?? (await context.newPage());
        const record: LiveBrowser = {
          context,
          page,
          startedAt: new Date().toISOString(),
          usedAt: Date.now(),
          retarget: () => {},
          tabsChanged: () => {},
          ...(sessionCookies ? { sessionCookies } : {}),
        };
        let saveTimer: ReturnType<typeof setTimeout> | undefined;
        record.tabsChanged = () => {
          if (LOCAL_CHROME) return;
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            saveTimer = undefined;
            if (live.get(botId) !== record) return;
            const pages = openTabs(context.pages());
            const saved = savedTabsFrom(
              pages.map((p) => ({ url: p.url(), title: "", active: p === record.page })),
            );
            void writeSavedTabs(dir, saved).catch(() => undefined);
          }, 800);
        };
        const watchPage = (watched: Page) => {
          watched.on("framenavigated", (frame) => {
            if (frame === watched.mainFrame()) record.tabsChanged();
          });
        };
        watchPage(page);
        record.retarget = () => {
          const pinned =
            record.pinned && !record.pinned.isClosed() ? record.pinned : undefined;
          if (!pinned) record.pinned = undefined;
          const next = pinned ?? chooseLivePage(context.pages());
          if (!next || next === record.page) return;
          record.page = next;
          console.info(
            JSON.stringify({
              type: "computer-page-changed",
              botId,
              url: next.url(),
            }),
          );
        };
        // Without this the Bot stays pinned to the page it launched with, so a sign-in the site opens
        // in a new window is neither shown to the person taking the wheel nor reachable by input.
        context.on("page", (opened) => {
          // 新开的标签、网站弹出的窗口：成为当前标签（和以前跟着弹窗走一样）。
          record.pinned = opened;
          record.retarget();
          watchPage(opened);
          record.tabsChanged();
          // A popup closes itself when it succeeds, and the record must move back to the opener
          // rather than leave a closed page to be read as a dead browser.
          opened.on("close", () => {
            record.retarget();
            record.tabsChanged();
          });
        });
        page.on("close", () => {
          record.retarget();
          record.tabsChanged();
        });
        if (abandoned) {
          await settleWithin(sessionCookies?.stop(), TEARDOWN_BUDGET_MS);
          await settleWithin(context.close(), CLOSE_BUDGET_MS);
          throw new LaunchAbandonedError(botId, LAUNCH_DEADLINE_MS);
        }
        live.set(botId, record);
        // 上次关浏览器时开着的标签（重启、部署、空闲关闭之后）。不等它们加载完。
        if (RESTORE_TABS && !LOCAL_CHROME) {
          const saved = await readSavedTabs(dir);
          if (saved && saved.tabs.length > 0)
            await within(restoreTabs(record, saved), 10_000, undefined);
        }
        // After the new one is in the map, so the cap counts what is really running and the Bot that
        // just asked is the most recently used and therefore never the one closed.
        await enforceCap();
        // Not `page`: a window opened while the browser was starting is already the live one.
        return record.page;
      })();

      const bounded = withDeadline(launch, LAUNCH_DEADLINE_MS, () => {
        abandoned = true;
        console.info(
          JSON.stringify({
            type: "computer-launch-abandoned",
            botId,
            afterMs: LAUNCH_DEADLINE_MS,
          }),
        );
        return new LaunchAbandonedError(botId, LAUNCH_DEADLINE_MS);
      });
      starting.set(botId, bounded);
      try {
        return await bounded;
      } finally {
        // Cleared whether it worked or not so a failed launch does not pin future calls to a rejected
        // promise. Only our own entry: an abandoned launch must not clear its replacement's.
        if (starting.get(botId) === bounded) starting.delete(botId);
      }
    },

    /**
     * Drop this Bot's browser without waiting on anything it is doing.
     *
     * For an action that ran past its lease: something on this browser never answered, so the
     * graceful paths (which wait on the launch in flight and on the close) are exactly the ones that
     * may not come back. The launch in flight is forgotten, the browser is closed in the background,
     * and the next request starts a fresh one from the same profile, logins intact.
     */
    abandon(botId: string, reason: string): void {
      const launching = starting.get(botId);
      starting.delete(botId);
      if (launching) launching.catch(() => undefined);
      const running = live.get(botId);
      if (!running) return;
      live.delete(botId);
      console.info(JSON.stringify({ type: "computer-browser-closed", botId, reason }));
      void (async () => {
        await settleWithin(Promise.resolve(onClosed(botId)), ANNOUNCE_BUDGET_MS);
        await keepSessionCookies(running);
        await closeAndWait(running.context);
      })().catch(() => undefined);
    },

    /**
     * Stop this Bot's browser, keeping what it knows.
     *
     * The same close the cap and the idle sweep make, so it goes through the same path rather than
     * repeating it: a request is one more reason a browser closes, not a different kind of closing,
     * and anything watching has to come down either way.
     */
    async stop(botId: string): Promise<boolean> {
      return closeOnRequest(botId, "it was stopped");
    },

    /**
     * Forget everything this Bot knows and start over.
     *
     * The browser is closed before the directory is deleted: deleting a profile
     * out from under a running Chromium is how you get a browser that is alive, writing to files that
     * no longer exist, and reporting success. Nothing is recreated here, the next request starts a
     * clean browser, which is the same path as a first ever start and so needs no second code path.
     */
    async reset(botId: string): Promise<void> {
      // Its own reason rather than borrowing stop's, so the trail says which of the two happened.
      await whileClosing(botId, async () => {
        await closeOnRequest(botId, "it was reset");
        await rm(directoryFor(botId), { recursive: true, force: true });
      });
    },

    /**
     * Every Bot that has a computer, whether or not one is running.
     *
     * Read from disk rather than from memory, because a Bot's computer exists as long as its profile
     * does: after a restart nothing is running and every login is still there, and an admin page that
     * listed only live browsers would show an empty screen and imply the logins were gone.
     */
    async known(): Promise<string[]> {
      const onDisk = await readdir(root, { withFileTypes: true }).catch(
        () => [],
      );
      /*
       * The rule lives in its own module, so the test that covers it imports the same one this uses.
       * It had a copy before, which meant deleting this filter left the suite green.
       */
      return [...new Set([...botIdsIn(onDisk), ...live.keys()])].sort();
    },

    /** What the admin surface lists. Running or not, because a Bot that has a profile has a computer. */
    summary(botIds: string[]): ProfileSummary[] {
      const known = new Set([...botIds, ...live.keys()]);
      return [...known].sort().map((botId) => {
        const running = live.get(botId);
        return {
          botId,
          running: Boolean(running),
          startedAt: running?.startedAt ?? null,
          egress: egressLabel(botId, process.env),
        };
      });
    },

    /**
     * Close every browser, for shutdown.
     *
     * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait. Closing the contexts
     * here gives Chromium the chance to flush its profile within that grace period.
     */
    async closeAll(): Promise<void> {
      clearInterval(idleSweep);
      const entries = [...live.entries()];
      live.clear();
      // Told for each, the same as any other close. On the way out it changes nothing that survives,
      // but a viewer whose socket outlives this by a moment is still owed the message.
      await Promise.all(
        entries.map(([botId]) =>
          settleWithin(Promise.resolve(onClosed(botId)), ANNOUNCE_BUDGET_MS),
        ),
      );
      // Written before the close, so a pod deleted by a suspend or an image update keeps its sign-ins.
      await Promise.all(entries.map(([, c]) => keepSessionCookies(c)));
      await Promise.all(entries.map(([, c]) => closeAndWait(c.context)));
    },

    /** How many browsers are running. For the idle sweep's own tests, and for a status reader. */
    liveCount(): number {
      return live.size;
    },

    /** Whether this Bot has a browser right now, so a caller can drop state that belongs to one. */
    isLive(botId: string): boolean {
      return live.has(botId);
    },

    /** Run the idle sweep now. Exposed so a test does not have to wait a minute for the interval. */
    sweepIdleNow(): Promise<void> {
      return sweepIdle();
    },

    /**
     * 这个机器人的标签。浏览器没在运行时不去拉起它，只列出上次保存的（running: false），
     * 所以界面轮询标签不会把一个已经关掉的浏览器重新打开。
     */
    async tabs(botId: string): Promise<TabsView> {
      const record = live.get(botId);
      if (!record || !record.context.browser()?.isConnected()) {
        const saved = LOCAL_CHROME ? null : await readSavedTabs(directoryFor(botId));
        return {
          running: false,
          max: MAX_TABS,
          activeId: null,
          tabs: (saved?.tabs ?? []).map((tab, index) => ({
            id: `saved-${index}`,
            url: tab.url,
            title: tabTitle(tab.url, tab.title),
            active: index === saved?.active,
          })),
        };
      }
      record.retarget();
      const pages = openTabs(record.context.pages());
      const tabs = await Promise.all(pages.map((p) => describeTab(p, p === record.page)));
      return {
        running: true,
        max: MAX_TABS,
        activeId: record.page.isClosed() ? null : tabIdOf(record.page),
        tabs,
      };
    },

    /** 正在运行的浏览器里所有打开着的页面（不拉起浏览器）。 */
    async pagesOf(botId: string): Promise<Page[]> {
      const record = live.get(botId);
      return record ? openTabs(record.context.pages()) : [];
    },

    /** 新开一个标签并切过去（空白页，起始页由 ensureStartPage 画上）。 */
    async openTab(botId: string): Promise<Page> {
      const record = await running(botId);
      if (openTabs(record.context.pages()).length >= MAX_TABS)
        throw new TabError(TAB_LIMIT_MESSAGE, 409);
      const created = await record.context.newPage();
      record.pinned = created;
      record.retarget();
      record.usedAt = Date.now();
      /*
       * 新标签也要拿到前台，和 activateTab 一样。
       *
       * 这里以前只 pin 不 bringToFront：标签栏把它画成当前标签，直播却还停在上一页——Chromium 的
       * screencast 只合成真的在显示的那一页。看起来就是「多了一个标签，点不进去」（2026-10-22 反馈）。
       * 失败不算错：有些平台不给前台权限，follow 循环照样会按 record.page 重挂转播。
       */
      await created.bringToFront().catch(() => undefined);
      return created;
    },

    async activateTab(botId: string, id: string): Promise<Page> {
      const record = await running(botId);
      const target = findTab(record.context.pages(), id);
      if (!target) throw new TabError("这个标签页已经关掉了。", 404);
      record.pinned = target;
      record.retarget();
      record.usedAt = Date.now();
      record.tabsChanged();
      await target.bringToFront().catch(() => undefined);
      return target;
    },

    /** 关掉一个标签。只剩这一个时换成一张新的空白页，浏览器本身不关。 */
    async closeTab(botId: string, id: string): Promise<Page> {
      const record = await running(botId);
      const pages = record.context.pages();
      const target = findTab(pages, id);
      if (!target) throw new TabError("这个标签页已经关掉了。", 404);
      if (openTabs(pages).length <= 1) {
        const fresh = await record.context.newPage();
        record.pinned = fresh;
      } else {
        record.pinned = neighbourAfterClose(pages, target, record.page);
      }
      await target.close().catch(() => undefined);
      record.retarget();
      record.usedAt = Date.now();
      record.tabsChanged();
      if (!record.page.isClosed()) await record.page.bringToFront().catch(() => undefined);
      return record.page;
    },
  };
  return api;
}

export type Profiles = ReturnType<typeof createProfiles>;
