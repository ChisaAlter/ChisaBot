import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Which Bot the surface in front of you is driving.
 *
 * The computer tools are registered once for the whole app, but a computer belongs to a Bot, and a supervisor gives
 * each one its own browser profile and its own egress, and the server picks which by the id in the
 * URL.
 *
 * Tool handlers read the ref because a handler outlives the render that registered it. Components
 * read state because grants and renderers must re-render when the active Bot changes.
 */

const DEFAULT_BOT_ID = "default";

type BotHolder = { current: string };

/**
 * 每段对话的 agent 对象 → 它的机器人（DESIGN.md §101）。
 *
 * 工具处理函数以前只读「当前看着的机器人」（holder）。可一轮是好几个 run 接力的：用户在 A 的对话里发了消息，
 * 中途切到 B，或者 B 的对话因为保活 / 重新挂载晚一步声明了自己，A 后面的计算机操作就打到了 B 的浏览器上
 * （2026-10-17 22:44 生产：Asuna 的「打开 hark.com/login」进了星灵的浏览器，登录请求也记在星灵名下，
 * Asuna 那边永远等不到「已登录」）。现在先看这一次工具调用属于哪段对话的 agent，再退回 holder。
 */
const agentBots = new WeakMap<object, string>();

/** 由每段对话声明：这个 agent 的工具调用操作这个机器人的计算机。agent 和机器人一一对应，不用撤销。 */
export function bindAgentBot(agent: object | null | undefined, botId: string | undefined) {
  if (agent && botId) agentBots.set(agent, botId);
}

/** 这次工具调用（handler 的 context.agent）属于哪个机器人；不知道时 undefined。 */
export function botForAgent(agent: unknown): string | undefined {
  return agent && typeof agent === "object" ? agentBots.get(agent) : undefined;
}

/**
 * 在 `run` 同步执行期间，让 holder.current 读到这次调用所属的机器人。
 * 处理函数都在第一个 await 之前读 `bot.current`，所以同步覆盖就够；之后立刻还原。
 */
export function withRunBot<T>(holder: BotHolder, botId: string | undefined, run: () => T): T {
  if (!botId || !(holder instanceof RunScopedHolder)) return run();
  const previous = holder.run;
  holder.run = botId;
  try {
    return run();
  } finally {
    holder.run = previous;
  }
}

class RunScopedHolder implements BotHolder {
  base = DEFAULT_BOT_ID;
  run: string | undefined = undefined;
  get current() {
    return this.run ?? this.base;
  }
  set current(value: string) {
    this.base = value;
  }
}

const ActiveBotContext = createContext<BotHolder | null>(null);
const ActiveBotValueContext = createContext<{
  botId: string;
  announce: (botId: string) => void;
} | null>(null);

export function ActiveBotProvider({ children }: { children: ReactNode }) {
  const holder = useRef<BotHolder>(new RunScopedHolder());
  const [botId, setBotId] = useState(DEFAULT_BOT_ID);
  const value = useRef({ botId, announce: setBotId });
  value.current = { botId, announce: setBotId };

  return (
    <ActiveBotContext.Provider value={holder.current}>
      <ActiveBotValueContext.Provider value={value.current}>
        {children}
      </ActiveBotValueContext.Provider>
    </ActiveBotContext.Provider>
  );
}

/**
 * Declare the Bot this surface drives, for as long as it is mounted.
 *
 * Restores what it found on unmount, so leaving a channel does not leave its Bot addressed by
 * whatever mounts next.
 */
export function useActiveBot(botId: string | undefined): void {
  const holder = useContext(ActiveBotContext);
  const value = useContext(ActiveBotValueContext);
  useEffect(() => {
    if (!holder) return;
    const previous = holder instanceof RunScopedHolder ? holder.base : holder.current;
    holder.current = botId ?? DEFAULT_BOT_ID;
    value?.announce(botId ?? DEFAULT_BOT_ID);
    return () => {
      holder.current = previous;
      value?.announce(previous);
    };
  }, [holder, value, botId]);
}

/** The holder itself, to be read inside a handler at the moment it runs. */
export function useActiveBotHolder(): BotHolder {
  return useContext(ActiveBotContext) ?? { current: DEFAULT_BOT_ID };
}

/** The active Bot as a value, for anything that has to re-render when it changes. */
export function useActiveBotId(): string {
  return useContext(ActiveBotValueContext)?.botId ?? DEFAULT_BOT_ID;
}

/**
 * The active Bot when a surface has declared one, and undefined while the placeholder holds.
 *
 * The placeholder exists so a handler always has something to route with, but it is not a Bot: no
 * package registers an agent by that name, and the server answers 404 for it. A grant query handed
 * the placeholder therefore polls a guaranteed miss on its own interval — every few seconds, on
 * every screen without a conversation — and the constant failing request is noise that would bury a
 * real 404 the day one matters. A query given undefined instead simply does not run.
 *
 * The name is already reserved in practice: an agents.yaml entry called "default" would be
 * indistinguishable from the placeholder in every handler that reads the holder.
 */
export function declaredBotId(botId: string): string | undefined {
  return botId === DEFAULT_BOT_ID ? undefined : botId;
}

/** As useActiveBotId, for callers that should do nothing while the placeholder holds. */
export function useDeclaredBotId(): string | undefined {
  return declaredBotId(useActiveBotId());
}
