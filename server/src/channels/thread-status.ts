import type { ThreadReader } from "./thread-routes";

/**
 * Build a {@link ThreadReader} from the conversation store's thread lookup.
 *
 * `getThread` is typed as narrowly as this file needs it — a method that takes a thread and a
 * person and either resolves or throws — so a test can hand it a stub with no client to construct.
 *
 * The status check is duck-typed on `error?.status === 404` rather than an `instanceof` check.
 * Anything that is not that specific shape is rethrown unchanged, never folded into `"unknown"`: a
 * 404 means the thread does not exist, whereas a timeout or 500 means the check itself failed, and
 * treating the two the same would let a browser discard history that is only temporarily unreachable.
 */
export function createThreadReader(readerClient: {
  getThread: (params: { threadId: string; userId: string }) => Promise<unknown>;
}): ThreadReader {
  return async (threadId, userId) => {
    try {
      await readerClient.getThread({ threadId, userId });
      return "known";
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status === 404) {
        return "unknown";
      }
      throw error;
    }
  };
}
