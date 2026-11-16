import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useExternalConnection } from "@/hooks";
import { objectConnectionKey } from "@/lib/connection-key";
import { modelSelectionKeys } from "./queries";
import { listenForModelSelectionChanges } from "./sync";

export function useModelSelectionSaving(agentId: string) {
  return useIsMutating({ mutationKey: modelSelectionKeys.save(agentId) }) > 0;
}

export function useModelSelectionSync() {
  const queryClient = useQueryClient();
  useExternalConnection(objectConnectionKey(queryClient), () =>
    listenForModelSelectionChanges(queryClient),
  );
}
