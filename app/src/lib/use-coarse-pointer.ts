import { useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse)";

function mediaQuery(): MediaQueryList | undefined {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return undefined;
  }
  return window.matchMedia(QUERY);
}

function subscribe(listener: () => void) {
  const query = mediaQuery();
  query?.addEventListener?.("change", listener);
  return () => query?.removeEventListener?.("change", listener);
}

/** The primary pointer is a finger: a phone or tablet, where there is no Shift on the keyboard. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mediaQuery()?.matches === true,
    () => false,
  );
}
