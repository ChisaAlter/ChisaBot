import { expect, test } from "bun:test";
import { recoverPanelTaskStatus } from "../src/panels/task-status";

const interrupted = {
  savedStatus: "running",
  ageMs: 60_000,
  bound: true,
  waiting: false,
  isRunning: false,
};
test("durable approval suspension takes precedence over a finished transport", () => {
  expect(
    recoverPanelTaskStatus({
      ...interrupted,
      waiting: true,
      transportStatus: "finished",
    }),
  ).toBe("waiting");
  expect(
    recoverPanelTaskStatus({
      ...interrupted,
      savedStatus: "waiting",
      transportStatus: "finished",
    }),
  ).toBe("waiting");
});
test("lost remote callback and unbound claim become unknown without redispatch", () => {
  expect(recoverPanelTaskStatus(interrupted)).toBe("unknown");
  expect(recoverPanelTaskStatus({ ...interrupted, bound: false })).toBe(
    "unknown",
  );
  expect(recoverPanelTaskStatus({ ...interrupted, ageMs: 100 })).toBe(
    "running",
  );
});
test("only exact durable terminal evidence settles a recovered task", () => {
  expect(
    recoverPanelTaskStatus({ ...interrupted, transportStatus: "finished" }),
  ).toBe("succeeded");
  expect(
    recoverPanelTaskStatus({ ...interrupted, transportStatus: "error" }),
  ).toBe("failed");
  expect(recoverPanelTaskStatus({ ...interrupted, isRunning: true })).toBe(
    "running",
  );
});
