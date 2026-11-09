import { describe, expect, test } from "bun:test";
import { hasManagedAgentToken } from "./agent-authorisation";
import { applyLegacyEnvAliases } from "./legacy-compat";
import { computerHeaders, managedAgentHeaders, readCompatibleHeader } from "./legacy-headers";

describe("installed client compatibility", () => {
  test("a legacy agent token is accepted without allowing it to override a current token", () => {
    const expected = "fixture-agent-token";
    expect(hasManagedAgentToken(new Request("http://agent.local", { headers: { "x-openbot-agent-token": expected } }), expected)).toBe(true);
    expect(hasManagedAgentToken(new Request("http://agent.local", { headers: { "x-chisabot-agent-token": "wrong", "x-openbot-agent-token": expected } }), expected)).toBe(false);
    expect(readCompatibleHeader(new Headers({ "x-openbot-dictation": "1" }), "x-chisabot-dictation")).toBe("1");
    expect(readCompatibleHeader(new Headers({ "x-openbot-unrecognized": "1" }), "x-chisabot-unrecognized")).toBeNull();
  });

  test("managed sends keep installed agent authentication and never invent empty tokens", () => {
    expect(managedAgentHeaders("fixture")).toEqual({ "x-chisabot-agent-token": "fixture", "x-openbot-agent-token": "fixture" });
    expect(computerHeaders("bot")).toEqual({ "x-chisabot-bot-id": "bot", "x-openbot-bot-id": "bot" });
    expect(computerHeaders()).toEqual({});
  });

  test("current environment settings win while an old deployment retains its configured value", () => {
    const env = { OPENBOT_RUNTIME_MODE: "local", OPENBOT_ACCOUNTS_UI: "0", CHISABOT_ACCOUNTS_UI: "1" } as Record<string, string | undefined>;
    applyLegacyEnvAliases(env);
    expect(env.CHISABOT_RUNTIME_MODE).toBe("local");
    expect(env.CHISABOT_ACCOUNTS_UI).toBe("1");
    expect(env.OPENBOT_ACCOUNTS_UI).toBe("0");
  });
});
