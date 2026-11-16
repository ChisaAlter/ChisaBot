import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  ControlError,
  createControl,
  canBotAct,
  HELP_REQUEST_TTL_MS,
  HUMAN_HOLD_TTL_MS,
  SnapshotRequiredError,
} from "../../agent-computer/src/control";
import {
  assertModelHolds,
  exploreModel,
  type ModelTransition,
  type StateModel,
} from "../../shared/verification/model-checker";

type RequestStatus =
  | "none"
  | "waiting"
  | "taken"
  | "completed"
  | "cancelled"
  | "expired"
  | "interrupted";

type TakeoverModelState = {
  holder: "bot" | "human";
  requested: boolean;
  requestStatus: RequestStatus;
  resumeSnapshotRequired: boolean;
  releasedAwaitingSnapshot: boolean;
  snapshotInvalidated: boolean;
  botReadViolation: boolean;
  botMutateViolation: boolean;
  humanDriveViolation: boolean;
};

type GateFn = typeof canBotAct;

type ModelMutantOptions = {
  gate?: GateFn;
  omitResumeSnapshotOnRelease?: boolean;
};

function createTakeoverModel(
  options: ModelMutantOptions = {},
): StateModel<TakeoverModelState> {
  const gate: GateFn = options.gate ?? canBotAct;

  const transitions: ModelTransition<TakeoverModelState>[] = [
    {
      name: "requestHelp",
      guard: () => true,
      apply: (s) => {
        if (s.holder === "human" || s.requestStatus === "waiting") {
          return { ...s };
        }
        return {
          ...s,
          requested: true,
          requestStatus: "waiting",
        };
      },
    },
    {
      name: "take",
      guard: (s) => s.requestStatus === "waiting",
      apply: (s) => ({
        ...s,
        holder: "human",
        requested: false,
        requestStatus: "taken",
      }),
    },
    {
      name: "release",
      guard: (s) =>
        s.holder === "human" &&
        (s.requestStatus === "taken" || s.requestStatus === "cancelled"),
      apply: (s) => ({
        ...s,
        holder: "bot",
        requested: false,
        requestStatus: s.requestStatus === "taken" ? "completed" : "cancelled",
        resumeSnapshotRequired: options.omitResumeSnapshotOnRelease
          ? s.resumeSnapshotRequired
          : true,
        releasedAwaitingSnapshot: true,
        snapshotInvalidated: true,
      }),
    },
    {
      name: "cancel",
      guard: (s) =>
        s.requestStatus === "waiting" || s.requestStatus === "taken",
      apply: (s) => ({
        ...s,
        requested: false,
        requestStatus: "cancelled",
      }),
    },
    {
      name: "botRead",
      guard: () => true,
      apply: (s) => {
        const decision = gate(s, false);
        const shouldRejectHuman = s.holder === "human" || s.requested;
        const violated = shouldRejectHuman && decision.allowed;
        return {
          ...s,
          botReadViolation: s.botReadViolation || violated,
        };
      },
    },
    {
      name: "botMutate",
      guard: () => true,
      apply: (s) => {
        const decision = gate(s, true);
        const shouldRejectHuman = s.holder === "human" || s.requested;
        const shouldRejectStaleSnapshot =
          s.holder === "bot" && !s.requested && s.releasedAwaitingSnapshot;
        const violated =
          (shouldRejectHuman || shouldRejectStaleSnapshot) && decision.allowed;
        return {
          ...s,
          botMutateViolation: s.botMutateViolation || violated,
        };
      },
    },
    {
      name: "snapshotTaken",
      guard: () => true,
      apply: (s) => {
        if (s.holder === "bot" && !s.requested && s.resumeSnapshotRequired) {
          return {
            ...s,
            resumeSnapshotRequired: false,
            releasedAwaitingSnapshot: false,
            snapshotInvalidated: false,
          };
        }
        return { ...s };
      },
    },
    {
      name: "humanDrive",
      guard: () => true,
      apply: (s) => {
        const mayDrive = s.holder === "human";
        const violated = s.holder === "bot" && mayDrive;
        return {
          ...s,
          humanDriveViolation: s.humanDriveViolation || violated,
        };
      },
    },
    {
      name: "interrupt",
      guard: () => true,
      apply: (s) => ({
        ...s,
        holder: "bot",
        requested: false,
        requestStatus:
          s.requestStatus === "waiting" || s.requestStatus === "taken"
            ? "interrupted"
            : s.requestStatus,
        resumeSnapshotRequired: true,
        releasedAwaitingSnapshot: true,
        snapshotInvalidated: true,
      }),
    },
    {
      name: "ttlExpire",
      guard: (s) =>
        s.requestStatus === "waiting" ||
        (s.requestStatus === "taken" && s.holder === "human"),
      apply: (s) => {
        if (s.requestStatus === "waiting") {
          return {
            ...s,
            requested: false,
            requestStatus: "expired",
          };
        }
        return {
          ...s,
          holder: "bot",
          requested: false,
          requestStatus: "expired",
          resumeSnapshotRequired: true,
          releasedAwaitingSnapshot: true,
          snapshotInvalidated: true,
        };
      },
    },
  ];

  return {
    name: "computer-takeover",
    initial: () => ({
      holder: "bot",
      requested: false,
      requestStatus: "none",
      resumeSnapshotRequired: false,
      releasedAwaitingSnapshot: false,
      snapshotInvalidated: false,
      botReadViolation: false,
      botMutateViolation: false,
      humanDriveViolation: false,
    }),
    canonicalize: (s) =>
      [
        s.holder,
        s.requested ? 1 : 0,
        s.requestStatus,
        s.resumeSnapshotRequired ? 1 : 0,
        s.releasedAwaitingSnapshot ? 1 : 0,
        s.snapshotInvalidated ? 1 : 0,
        s.botReadViolation ? 1 : 0,
        s.botMutateViolation ? 1 : 0,
        s.humanDriveViolation ? 1 : 0,
      ].join("|"),
    transitions,
    invariants: [
      {
        name: "human-exclusive-bot-rejection",
        check: (s) => {
          if (s.botReadViolation || s.botMutateViolation) return false;
          if (s.holder === "human" || s.requested) {
            const readGate = gate(s, false);
            const mutateGate = gate(s, true);
            return (
              !readGate.allowed &&
              readGate.reason === "human" &&
              !mutateGate.allowed &&
              mutateGate.reason === "human"
            );
          }
          return true;
        },
      },
      {
        name: "stale-snapshot-guard-after-release",
        check: (s) => {
          if (s.botMutateViolation) return false;
          if (
            s.releasedAwaitingSnapshot &&
            s.holder === "bot" &&
            !s.requested
          ) {
            const mutateGate = gate(s, true);
            return (
              s.resumeSnapshotRequired &&
              s.snapshotInvalidated &&
              !mutateGate.allowed &&
              mutateGate.reason === "snapshot"
            );
          }
          return true;
        },
      },
      {
        name: "human-drive-only-when-holder",
        check: (s) => !s.humanDriveViolation,
      },
    ],
  };
}

function collectReachableStates(model: StateModel<TakeoverModelState>) {
  const states = new Map<string, TakeoverModelState>();
  const queue: TakeoverModelState[] = [model.initial()];
  states.set(model.canonicalize(queue[0]), queue[0]);

  let index = 0;
  while (index < queue.length) {
    const current = queue[index];
    index += 1;
    for (const transition of model.transitions) {
      if (transition.guard && !transition.guard(current)) continue;
      const next = transition.apply(current);
      const key = model.canonicalize(next);
      if (!states.has(key)) {
        states.set(key, next);
        queue.push(next);
      }
    }
  }
  return states;
}

describe("formal computer takeover verification", () => {
  test("exhaustive BFS proves mutual exclusion, stale snapshot guard, and recovery without deadlocks", () => {
    const model = createTakeoverModel();
    const result = assertModelHolds(model);
    expect(result.ok).toBe(true);
    expect(result.exploredStates).toBeGreaterThan(10);

    // Explicitly prove Invariant 3: from every reachable waiting or human-held state,
    // a finite path via take/release/cancel/interrupt/ttlExpire returns control to holder === "bot".
    const states = collectReachableStates(model);
    const recoveryNames = new Set([
      "take",
      "release",
      "cancel",
      "interrupt",
      "ttlExpire",
    ]);
    const recoveryTransitions = model.transitions.filter((t) =>
      recoveryNames.has(t.name),
    );

    for (const [startKey, startState] of states.entries()) {
      if (startState.holder !== "human" && !startState.requested) continue;
      const visited = new Set<string>([startKey]);
      const bfs: TakeoverModelState[] = [startState];
      let reachedBot = false;
      for (let i = 0; i < bfs.length; i += 1) {
        const cur = bfs[i];
        if (cur.holder === "bot" && !cur.requested) {
          reachedBot = true;
          break;
        }
        for (const transition of recoveryTransitions) {
          if (transition.guard && !transition.guard(cur)) continue;
          const next = transition.apply(cur);
          const nextKey = model.canonicalize(next);
          if (!visited.has(nextKey)) {
            visited.add(nextKey);
            bfs.push(next);
          }
        }
      }
      expect(reachedBot).toBe(true);
    }
  });

  test("fast-check differential sequences preserve parity between model and real createControl", async () => {
    const actionNames = [
      "requestHelp",
      "take",
      "release",
      "cancel",
      "botRead",
      "botMutate",
      "snapshotTaken",
      "humanDrive",
      "interrupt",
      "ttlExpire",
    ] as const;
    type ActionName = (typeof actionNames)[number];

    const traceArb = fc.array(fc.constantFrom<ActionName>(...actionNames), {
      minLength: 10,
      maxLength: 45,
    });

    await fc.assert(
      fc.asyncProperty(traceArb, async (trace) => {
        let nowMs = Date.parse("2026-11-16T00:00:00.000Z");
        let invalidatedCount = 0;
        const control = createControl(() => new Date(nowMs).toISOString(), {
          invalidateSnapshot: () => {
            invalidatedCount += 1;
          },
        });

        let modelHolder: "bot" | "human" = "bot";
        let modelRequested = false;
        let modelResumeSnapshot = false;
        let modelInvalidations = 0;

        for (const action of trace) {
          const currentState = control.get();
          const currentRequestId = currentState.request?.id;

          switch (action) {
            case "requestHelp": {
              const source =
                invalidatedCount % 2 === 0 ? "cn-captcha" : "human-takeover";
              const next = control.requestHelp("需要接管", undefined, source);
              if (modelHolder === "bot" && !modelRequested) {
                modelRequested = true;
                expect(next.request?.source).toBe(source);
              }
              break;
            }
            case "take": {
              if (
                currentState.request?.status === "waiting" &&
                currentRequestId
              ) {
                await control.take(currentRequestId);
                modelHolder = "human";
                modelRequested = false;
              }
              break;
            }
            case "release": {
              if (
                currentState.holder === "human" &&
                currentRequestId &&
                (currentState.request?.status === "taken" ||
                  currentState.request?.status === "cancelled")
              ) {
                control.release(currentRequestId);
                modelHolder = "bot";
                modelRequested = false;
                modelResumeSnapshot = true;
                modelInvalidations += 1;
              }
              break;
            }
            case "cancel": {
              if (
                currentRequestId &&
                (currentState.request?.status === "waiting" ||
                  currentState.request?.status === "taken")
              ) {
                control.cancel(currentRequestId);
                modelRequested = false;
              }
              break;
            }
            case "botRead": {
              if (modelHolder === "human" || modelRequested) {
                expect(() => control.assertBotMayAct(false)).toThrow(
                  ControlError,
                );
              } else {
                expect(() => control.assertBotMayAct(false)).not.toThrow();
              }
              break;
            }
            case "botMutate": {
              if (modelHolder === "human" || modelRequested) {
                expect(() => control.assertBotMayAct(true)).toThrow(
                  ControlError,
                );
              } else if (modelResumeSnapshot) {
                expect(() => control.assertBotMayAct(true)).toThrow(
                  SnapshotRequiredError,
                );
              } else {
                expect(() => control.assertBotMayAct(true)).not.toThrow();
              }
              break;
            }
            case "snapshotTaken": {
              control.snapshotTaken();
              if (
                modelHolder === "bot" &&
                !modelRequested &&
                modelResumeSnapshot
              ) {
                modelResumeSnapshot = false;
              }
              break;
            }
            case "humanDrive": {
              expect(control.humanMayDrive()).toBe(modelHolder === "human");
              if (control.humanMayDrive()) {
                nowMs += 65_000;
                control.noteHumanActivity();
              }
              break;
            }
            case "interrupt": {
              control.interrupt("浏览器中断");
              modelHolder = "bot";
              modelRequested = false;
              modelResumeSnapshot = true;
              modelInvalidations += 1;
              break;
            }
            case "ttlExpire": {
              if (currentState.request?.status === "waiting") {
                nowMs += HELP_REQUEST_TTL_MS + 10;
                control.get();
                modelRequested = false;
              } else if (
                currentState.request?.status === "taken" &&
                currentState.holder === "human"
              ) {
                nowMs += HUMAN_HOLD_TTL_MS + 10;
                control.get();
                modelHolder = "bot";
                modelRequested = false;
                modelResumeSnapshot = true;
                modelInvalidations += 1;
              }
              break;
            }
          }

          const after = control.get();
          expect(after.holder).toBe(modelHolder);
          expect(after.requested).toBe(modelRequested);
          expect(after.resumeSnapshotRequired).toBe(modelResumeSnapshot);
          expect(invalidatedCount).toBe(modelInvalidations);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("Mutant 1: bypassing holder === human exclusion check is caught and killed by BFS", () => {
    const mutantGate: GateFn = (state, browserMutation) => {
      // Mutant bug: forgets to reject when state.holder === "human"
      if (state.requested || state.recoveryRequired) {
        return { allowed: false, reason: "human" };
      }
      if (browserMutation && state.resumeSnapshotRequired) {
        return { allowed: false, reason: "snapshot" };
      }
      return { allowed: true };
    };

    const result = exploreModel(createTakeoverModel({ gate: mutantGate }));
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "human-exclusive-bot-rejection",
    );
    expect(result.counterexample?.actions).toEqual(["requestHelp", "take"]);
  });

  test("Mutant 2: omitting resumeSnapshotRequired = true in release() is caught and killed by BFS", () => {
    const result = exploreModel(
      createTakeoverModel({ omitResumeSnapshotOnRelease: true }),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "stale-snapshot-guard-after-release",
    );
    expect(result.counterexample?.actions).toEqual([
      "requestHelp",
      "take",
      "release",
    ]);
  });
});
