export type AgentKernel = "dsh" | "hermes" | "builtin";

/** Product startup, maintenance and deployment probes must select the same engine. */
export function selectedAgentKernel(
  environment: Record<string, string | undefined>,
): AgentKernel {
  const hermes = environment.CHISABOT_HERMES_URL?.trim();
  const kernel =
    environment.CHISABOT_AGENT_KERNEL?.trim() || (hermes ? "hermes" : "dsh");
  if (kernel !== "dsh" && kernel !== "hermes" && kernel !== "builtin") {
    throw new Error("CHISABOT_AGENT_KERNEL must be dsh, hermes or builtin.");
  }
  if (kernel === "hermes" && !hermes) {
    throw new Error(
      "CHISABOT_AGENT_KERNEL=hermes requires CHISABOT_HERMES_URL.",
    );
  }
  return kernel;
}
