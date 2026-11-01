import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

/**
 * 留着但藏起来的聊天 / 右栏（DESIGN.md §98.3）：`false` 时这块不在屏幕上。
 *
 * 外壳留着聊天、藏起右栏时，它们没卸载，轮询和直播画面也还在——藏着的东西不该一直耗流量和 CPU。
 * 读这个的地方在藏着时停下：计算机控制权轮询、浏览器标签轮询、计算机画面（直播 / 截图）、面板列表轮询、
 * 机器人组件授权轮询。回来时（变回 `true`）立刻补读一次。正在写的回答和后台交付（收件箱）不停。
 */
export const KeptVisibleContext = createContext(true);

export function useKeptVisible(): boolean {
  return useContext(KeptVisibleContext);
}

/**
 * 同一个「看不看得见」，但不让读的组件跟着重画：值放在一个不变的小 store 里，读的地方自己订阅。
 *
 * 只在藏 / 露那一刻要做点事（比如 `useThreadActivity` 回来时马上问一次）、渲染结果并不依赖它的地方用这个。
 * 用 `KeptVisibleContext` 的话，每次从设置回聊天，整个 `ChannelChat`（聊天列表、输入框）都要因为这个布尔
 * 重画一遍。`KeepAliveStage` 在提交后（`useEffect`）更新它；不在留着的那页里时永远是「看得见」。
 */
export type KeptVisibility = {
  get: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

export function createKeptVisibility(initial: boolean): KeptVisibility & { set: (visible: boolean) => void } {
  let current = initial;
  const subscribers = new Set<() => void>();
  return {
    get: () => current,
    set: (visible) => {
      if (visible === current) return;
      current = visible;
      for (const listener of subscribers) listener();
    },
    subscribe: (listener) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  };
}

const ALWAYS_VISIBLE: KeptVisibility = { get: () => true, subscribe: () => () => {} };

export const KeptVisibilityContext = createContext<KeptVisibility>(ALWAYS_VISIBLE);

export function useKeptVisibility(): KeptVisibility {
  return useContext(KeptVisibilityContext);
}

/*
 * 机器人组件授权的轮询挂在全局（CopilotProvider 里的 GalleryTools / SandboxedTools），不在聊天的树里，
 * 读不到上面的 context：藏着的聊天把它的机器人登记成「不在屏幕上」，那两处就不再每 5 秒问一次。
 */
const hiddenBots = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribeHidden = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** 聊天藏着时登记它的机器人（卸载或变回可见时撤销）。 */
export function useMarkBotHidden(botId: string | undefined, hidden: boolean): void {
  useEffect(() => {
    if (!botId || !hidden) return;
    hiddenBots.set(botId, (hiddenBots.get(botId) ?? 0) + 1);
    notify();
    return () => {
      const left = (hiddenBots.get(botId) ?? 1) - 1;
      if (left > 0) hiddenBots.set(botId, left);
      else hiddenBots.delete(botId);
      notify();
    };
  }, [botId, hidden]);
}

/** 这个机器人的聊天在屏幕上（没有被藏着的那段登记成不在）。 */
export function useBotOnScreen(botId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeHidden,
    () => !botId || !hiddenBots.has(botId),
    () => true,
  );
}
