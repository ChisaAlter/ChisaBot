import { createFileRoute, redirect } from "@tanstack/react-router";

type AgentsSearch = {
  new?: boolean;
  agent?: string;
};

/**
 * 旧「代理」页（上游 Agents：您的代理 / 探索代理）已并入机器人（DESIGN.md §57 导航收敛）：
 * /agents?agent=<id> → 该机器人的资料页，其余 → 机器人列表。
 */
function validateAgentsSearch(search: Record<string, unknown>): AgentsSearch {
  const out: AgentsSearch = {};
  if (typeof search.new === "boolean") out.new = search.new;
  if (typeof search.agent === "string") out.agent = search.agent;
  return out;
}

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: validateAgentsSearch,
  beforeLoad: ({ search }) => {
    if (search.agent) throw redirect({ to: "/bots/$agentId", params: { agentId: search.agent }, replace: true });
    throw redirect({ to: "/bots", replace: true });
  },
});
