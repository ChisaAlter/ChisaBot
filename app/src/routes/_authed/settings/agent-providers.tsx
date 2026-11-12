import { createFileRoute } from "@tanstack/react-router";
import { AgentProvidersPage } from "@/components/agent-providers/agent-providers-page";

export const Route = createFileRoute("/_authed/settings/agent-providers")({
  component: AgentProvidersPage,
});
