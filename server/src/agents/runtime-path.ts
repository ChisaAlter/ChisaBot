import { conversationPath } from "../legacy/protocol";
/**
 * Recognising a Bot run on the conversation runtime path (moved out of the removed upstream enterprise
 * gate in slimming P6-1; behaviour unchanged).
 */
const CONVERSATION_BASE = "/api/conversations";

/**
 * A run or connect of a Bot through the conversation runtime, matched the way the runtime matches it.
 *
 * The runtime does not anchor its routes: its router (`fetch-router` `matchSegments`) takes any path
 * under its base whose LAST segments are `agent/<id>/run`, `agent/<id>/connect` or `agent/<id>/suggest`
 * (a suggestion runs the Bot's model on whatever messages the caller sends). So
 * `/api/conversations/x/agent/<id>/run` runs the Bot exactly as `/api/conversations/agent/<id>/run` does,
 * and an anchored pattern here would let the first one through ungoverned.
 */
export function runtimeRun(
  path: string,
): { agentId: string; action: "run" | "connect" | "suggest" } | null {
  path = conversationPath(path);
  if (path !== CONVERSATION_BASE && !path.startsWith(`${CONVERSATION_BASE}/`))
    return null;
  const segments = path.split("/").filter(Boolean);
  const count = segments.length;
  const action = segments[count - 1];
  if (count < 3 || segments[count - 3] !== "agent") return null;
  if (action !== "run" && action !== "connect" && action !== "suggest")
    return null;
  try {
    return { agentId: decodeURIComponent(segments[count - 2] ?? ""), action };
  } catch {
    return null;
  }
}
