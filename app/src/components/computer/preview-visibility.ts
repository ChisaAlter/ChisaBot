import { useState, useSyncExternalStore } from "react";
import { useIntersectionObserver } from "@/hooks";
import { useKeptVisible } from "@/lib/kept-visible";

export function currentPageVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden" && !document.hidden;
}

function subscribePageVisibility(onStoreChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onStoreChange);
  return () => document.removeEventListener("visibilitychange", onStoreChange);
}

/** 页面在前台，且这块没被外壳藏起来（留着的聊天 / 右栏，DESIGN.md §98.3）。 */
export function usePageVisible(): boolean {
  const kept = useKeptVisible();
  const visible = useSyncExternalStore(
    subscribePageVisibility,
    currentPageVisible,
    () => true,
  );

  return visible && kept;
}

export function useElementVisible<T extends Element>(): [
  (node: T | null) => void,
  boolean,
] {
  const [node, setNode] = useState<T | null>(null);
  const [visible, setVisible] = useState(() => {
    if (typeof window === "undefined") return true;
    return !("IntersectionObserver" in window);
  });

  useIntersectionObserver(node, (entry) => setVisible(entry.isIntersecting), {
    enabled: node !== null,
  });

  return [setNode, visible];
}
