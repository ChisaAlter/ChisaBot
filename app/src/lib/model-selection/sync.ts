import type { QueryClient } from "@tanstack/react-query";
import { modelSelectionKeys } from "./queries";

const CHANNEL = "chisabot-model-selection";
const STORAGE_KEY = "chisabot-model-selection-changed";
type ModelChange = { agentId: string; at: number } | { catalog: true; at: number };

/** Notifications carry only an identity. Each tab reads the authoritative value from the server. */
export function notifyModelSelectionChanged(agentId?: string) {
  const change: ModelChange = agentId ? { agentId, at: Date.now() } : { catalog: true, at: Date.now() };
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(change);
    channel.close();
  } catch {
    // The storage notification below and focus refetch work without BroadcastChannel.
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(change));
  } catch {
    // A browser may deny storage; focus refetch remains available.
  }
}

export function listenForModelSelectionChanges(queryClient: QueryClient): () => void {
  const receive = (data: unknown) => {
    if (!data || typeof data !== "object") return;
    if ("agentId" in data && typeof data.agentId === "string") {
      void queryClient.invalidateQueries({ queryKey: modelSelectionKeys.agent(data.agentId) });
    } else if ("catalog" in data && data.catalog === true) {
      void queryClient.invalidateQueries({ queryKey: modelSelectionKeys.catalog });
      void queryClient.invalidateQueries({ queryKey: modelSelectionKeys.agents });
    }
  };
  const storage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch { /* Ignore unrelated malformed notifications. */ }
  };
  window.addEventListener("storage", storage);
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => receive(event.data);
  } catch {
    // Storage notifications also cover browsers without this API.
  }
  return () => {
    window.removeEventListener("storage", storage);
    channel?.close();
  };
}
