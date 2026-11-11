export type AgentKernel = "dsh" | "builtin";

/** Product startup, maintenance and deployment probes must select the same engine. */
export function selectedAgentKernel(
  environment: Record<string, string | undefined>,
): AgentKernel {
  const kernel = environment.CHISABOT_AGENT_KERNEL?.trim() || "dsh";
  if (kernel !== "dsh" && kernel !== "builtin") {
    throw new Error("CHISABOT_AGENT_KERNEL must be dsh or builtin.");
  }
  return kernel;
}
