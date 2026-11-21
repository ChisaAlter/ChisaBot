import { useEffect } from "react";

const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/**
 * Sets `html[data-motion-rest="1"]` when the window is hidden or idle for `idleMs`,
 * letting decorative ambient animations rest without disabling interactive transitions.
 */
export function useMotionRest(idleMs = 4000): void {
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const rest = () => {
      root.dataset.motionRest = "1";
    };

    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") {
        rest();
        return;
      }
      if ("motionRest" in root.dataset) {
        delete root.dataset.motionRest;
      }
      timer = setTimeout(rest, idleMs);
    };

    const handleActivity = () => {
      schedule();
    };

    schedule();
    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, handleActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", handleActivity);

    return () => {
      clearTimeout(timer);
      delete root.dataset.motionRest;
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, handleActivity);
      }
      document.removeEventListener("visibilitychange", handleActivity);
    };
  }, [idleMs]);
}
