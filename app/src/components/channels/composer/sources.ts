import type { CommandOption } from "./draft";

/**
 * Placeholder slash commands.
 *
 * Channels can carry seeded suggested prompts, but nothing serves them to the browser
 * yet, `AgentChannel` currently stops at `agentIds`. These stand in so `/` is exercisable, and
 * `commands` is a plain prop on `<Composer>`, so replacing them is a call site change.
 *
 * Agents are deliberately not placeheld: `agentListQueryOptions` already returns the real roster,
 * so the `@` source is wired to it at the call sites.
 */
export const PLACEHOLDER_COMMANDS: CommandOption[] = [
  {
    id: "summarize",
    name: "summarize",
    description: "总结本次对话",
    kind: "prompt",
    prompt: "Summarize what we covered in this channel so far.",
  },
  {
    id: "side",
    name: "side",
    description: "开启侧边临时提问（不污染主对话）",
    kind: "prompt",
    prompt: "/side ",
  },
  {
    id: "goal",
    name: "goal",
    description: "在多机器人群聊中发起有界目标协作",
    kind: "prompt",
    prompt: "/goal ",
  },
];
