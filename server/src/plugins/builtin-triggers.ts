import { cutAtCodeUnits } from "../channels/text";
import {
  callTriggerTool,
  isTriggerTool,
  TRIGGER_TOOLS,
} from "../responsibilities/trigger-tools";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
} from "../responsibilities/types";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * The builtin, in-process transport (catalogue entry `routines`, transport kind `builtin-routines`):
 * a Bot managing the event triggers of its person's responsibilities, without leaving the building.
 *
 * Until slimming P4c it also served the upstream Routines tools (`create_routine` / `list_routines` /
 * `update_routine` / `delete_routine`). Those were merged into ChisaBot schedules (DESIGN.md §55,
 * `server/src/schedules`, tools `schedule_*`), so only the trigger tools ride here now. The catalogue
 * key and the transport kind keep their old names because they are stored identifiers (grants and
 * server records name them); the `routines` table stays until P5.
 *
 * There is no credential: the call runs against this deployment's own tables, so the ACTOR is the
 * authorization — {@link callTool} refuses a run that is not attributed to a person, and owner and
 * Bot are read off the connection, never out of the arguments.
 */

/** Longest error sentence carried back to the model. */
const MAX_ERROR_CHARS = 400;

/** The trigger tools, as the same shape a server would have answered `tools/list` with. */
export async function listTools(): Promise<McpTool[]> {
  return TRIGGER_TOOLS.map((tool) => ({ ...tool }));
}

export const listNeedsCredential = false;

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/** Success as a result, with the same visible cap the vendor transports use. */
function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, isError: false, truncated: false };
  }
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${text.length} characters]`,
    isError: false,
    truncated: true,
  };
}

type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
};

/**
 * Call one tool. Whose trigger it is comes from the connection, never from `args`. Nothing thrown
 * escapes: refusals come back as `isError` results, which is what `plugins/tools.ts` expects.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpCallResult> {
  // Local DB work is short; honour Stop before starting (no mid-flight vendor socket to cancel).
  if (signal?.aborted) {
    const err = new Error("The trigger call was aborted.");
    err.name = "AbortError";
    throw err;
  }
  const ownerUserId = connection.actorId?.trim();
  if (!ownerUserId) {
    return failure(
      "A trigger belongs to somebody, and this run is not attributed to anybody.",
    );
  }
  const agentId = connection.botId?.trim();
  if (!agentId) {
    return failure("A trigger runs as a Bot, and this run does not name one.");
  }
  if (!isTriggerTool(toolName)) {
    // Includes the removed create_routine / list_routines / update_routine / delete_routine.
    return failure(
      `There is no tool named ${toolName} here. Scheduled work is created with schedule_create.`,
    );
  }
  try {
    return asResult(
      await callTriggerTool(ownerUserId, agentId, toolName, args),
    );
  } catch (error) {
    if (error instanceof ResponsibilityRefusedError)
      return failure(error.message);
    if (error instanceof ResponsibilityNotFoundError)
      return failure(
        "There is no trigger or responsibility of yours with that id for me.",
      );
    const message = error instanceof Error ? error.message : String(error);
    return failure(Array.from(message).slice(0, MAX_ERROR_CHARS).join(""));
  }
}
