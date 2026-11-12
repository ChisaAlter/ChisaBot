import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectedAgentKernel } from "../../shared/agent-kernel";
import { conversationAdmissionClosed } from "../src/conversations/maintenance";

test("default DSH observes the same maintenance marker as explicit DSH; builtin ignores it", () => {
  const folder = mkdtempSync(join(tmpdir(), "chisabot-kernel-"));
  const cwd = process.cwd();
  const keys = ["CHISABOT_DSH_ROOT", "CHISABOT_AGENT_KERNEL"] as const;
  const old = keys.map((key) => process.env[key]);
  try {
    process.chdir(folder);
    for (const key of keys) delete process.env[key];
    expect(selectedAgentKernel(process.env)).toBe("dsh");
    expect(conversationAdmissionClosed()).toBe(false);
    mkdirSync(".data/dsh", { recursive: true });
    writeFileSync(".data/dsh/.maintenance", "local-update");
    expect(conversationAdmissionClosed()).toBe(true);
    process.env.CHISABOT_AGENT_KERNEL = "dsh";
    expect(conversationAdmissionClosed()).toBe(true);
    process.env.CHISABOT_AGENT_KERNEL = "builtin";
    expect(selectedAgentKernel(process.env)).toBe("builtin");
    expect(conversationAdmissionClosed()).toBe(false);
  } finally {
    process.chdir(cwd);
    keys.forEach((key, index) => {
      if (old[index] === undefined) delete process.env[key];
      else process.env[key] = old[index];
    });
    rmSync(folder, { recursive: true });
  }
});
