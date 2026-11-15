import { useEffect, useRef } from "react";

/** 单次延时回调；delayMs 为 null 或负数时取消，可通过 resetKey 重新计时。 */
export function useTimeout(
  callback: () => void,
  delayMs: number | null,
  resetKey?: string | number | boolean | null,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const epochRef = useRef<string | number | boolean | null | undefined>(
    undefined,
  );

  useEffect(() => {
    epochRef.current = resetKey;
    if (delayMs === null || delayMs < 0) return;
    const id = setTimeout(() => {
      callbackRef.current();
    }, delayMs);
    return () => clearTimeout(id);
  }, [delayMs, resetKey]);
}

/** 周期性轮询/定时回调；delayMs 为 null 或负数时暂停，卸载自动清理。 */
export function useInterval(
  callback: () => void,
  delayMs: number | null,
  resetKey?: string | number | boolean | null,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const epochRef = useRef<string | number | boolean | null | undefined>(
    undefined,
  );

  useEffect(() => {
    epochRef.current = resetKey;
    if (delayMs === null || delayMs < 0) return;
    const id = setInterval(() => {
      callbackRef.current();
    }, delayMs);
    return () => clearInterval(id);
  }, [delayMs, resetKey]);
}

/** requestAnimationFrame 循环；active 为 false 或卸载时自动 cancelAnimationFrame。 */
export function useAnimationFrame(
  callback: (timestamp: number) => void,
  active: boolean,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!active || typeof requestAnimationFrame !== "function") return;
    let alive = true;
    let frameId = 0;
    const tick = (timestamp: number) => {
      if (!alive) return;
      callbackRef.current(timestamp);
      if (alive) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(frameId);
    };
  }, [active]);
}

/** 空闲时间任务调度；优先使用 requestIdleCallback，缺省退回 requestAnimationFrame。 */
export function useIdleTask(
  callback: () => void,
  active: boolean,
  timeoutMs = 50,
  resetKey?: string | number | boolean | null,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const epochRef = useRef<string | number | boolean | null | undefined>(
    undefined,
  );

  useEffect(() => {
    epochRef.current = resetKey;
    if (!active) return;
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(() => callbackRef.current(), {
        timeout: timeoutMs,
      });
      return () => cancelIdleCallback(id);
    }
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(() => callbackRef.current());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [active, timeoutMs, resetKey]);
}
