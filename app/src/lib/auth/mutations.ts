import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { setControlAccount } from "@/lib/computers/use-control";
import { authKeys } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    fallback: "无法登出",
  });
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => {
      // CB-107：退出后关掉这个账号的 control 轮询频道和锁。
      setControlAccount(null);
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
  });
}
