import { expect, test } from "bun:test";
import { OPS_CODES, opsLogLine } from "./ops-codes";

test("opsLogLine is greppable JSON without undefined holes", () => {
  const line = opsLogLine(OPS_CODES.HEALTH_DEGRADED, {
    failed: "database",
    db: false,
    magpie: null,
  });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  expect(parsed).toEqual({
    type: "ops",
    code: "OPS_HEALTH_DEGRADED",
    failed: "database",
    db: false,
    magpie: null,
  });
  expect(line).not.toContain("undefined");
});

test("OPS_CODES stay stable string literals", () => {
  expect(OPS_CODES.SEND_UNREACHABLE).toBe("SEND_UNREACHABLE");
  expect(OPS_CODES.SSRF_DENIED).toBe("SSRF_DENIED");
});
