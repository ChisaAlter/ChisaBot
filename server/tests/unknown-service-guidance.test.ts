import { describe, expect, test } from "bun:test";
import { ACTION_GUIDANCE } from "../../shared/bot-prompt";

describe("unknown service names resolve via tools, not by asking back (QA1102-13)", () => {
  test("the action guidance tells the model to search + connect_service for names it does not know", () => {
    expect(ACTION_GUIDANCE).toContain("不要反问");
    expect(ACTION_GUIDANCE).toContain("connect_service");
    expect(ACTION_GUIDANCE).toContain("web_search");
  });
});
