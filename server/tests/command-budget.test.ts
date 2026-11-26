import { describe, expect, test } from "bun:test";
import {
  COMMAND_BUDGET_EXHAUSTED_CODE,
  CommandBudgetExhaustedError,
  CommandBudgetLedger,
  clearRunBudget,
  DEFAULT_COMMAND_BUDGET_MS,
  recordElapsed,
} from "../src/computer/command-budget";
import { createComputerGateway } from "../src/computer/gateway";
import type { ComputerProvider } from "../src/computer/provider";
import { withConfirmTurn } from "../src/confirmations/context";

describe("CommandBudgetLedger", () => {
  test("默认单轮预算在 15–30 分钟区间", () => {
    expect(DEFAULT_COMMAND_BUDGET_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(DEFAULT_COMMAND_BUDGET_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  test("capTimeout 按剩余预算裁剪并在耗尽后拒绝", () => {
    const ledger = new CommandBudgetLedger({ defaultBudgetMs: 10_000 });

    const first = ledger.capTimeout("run-1", 6_000);
    expect(first).toEqual({
      allowed: true,
      timeoutMs: 6_000,
      remainingMs: 10_000,
      usedMs: 0,
      budgetMs: 10_000,
    });

    ledger.recordElapsed("run-1", 7_500);
    const second = ledger.capTimeout("run-1", 6_000);
    expect(second.allowed).toBe(true);
    expect(second.timeoutMs).toBe(2_500);
    expect(second.remainingMs).toBe(2_500);

    ledger.recordElapsed("run-1", 3_000);
    const exhausted = ledger.capTimeout("run-1", 1_000);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.timeoutMs).toBe(0);
    expect(exhausted.remainingMs).toBe(0);
  });

  test("不同 runId 相互隔离，且 clear 按 runId 清理", () => {
    const ledger = new CommandBudgetLedger({ defaultBudgetMs: 5_000 });
    ledger.recordElapsed("run-a", 5_000);

    expect(ledger.capTimeout("run-a", 1_000).allowed).toBe(false);
    expect(ledger.capTimeout("run-b", 3_000)).toMatchObject({
      allowed: true,
      timeoutMs: 3_000,
      remainingMs: 5_000,
    });

    ledger.clear("run-a");
    expect(ledger.capTimeout("run-a", 2_000).allowed).toBe(true);
  });

  test("空 runId 不累积跨请求共享状态", () => {
    const ledger = new CommandBudgetLedger({ defaultBudgetMs: 5_000 });
    ledger.recordElapsed(undefined, 5_000);
    ledger.recordElapsed("", 5_000);

    const next = ledger.capTimeout(undefined, 2_000);
    expect(next.allowed).toBe(true);
    expect(next.timeoutMs).toBe(2_000);
    expect(ledger.size()).toBe(0);
  });

  test("CommandBudgetExhaustedError 携带明确不可恢复错误码", () => {
    const err = new CommandBudgetExhaustedError(1_200_000, 1_200_000);
    expect(err.code).toBe(COMMAND_BUDGET_EXHAUSTED_CODE);
    expect(err.message).toContain(COMMAND_BUDGET_EXHAUSTED_CODE);
  });

  test("gateway.runCommand 裁剪 timeoutMs 并在预算耗尽后返回 COMMAND_BUDGET_EXHAUSTED", async () => {
    const execPayloads: Array<{ timeoutMs?: number }> = [];
    const provider: ComputerProvider = {
      isolation: "per-bot",
      locate: async () => "http://127.0.0.1:4199",
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: true }),
      list: async () => [],
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/exec") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        execPayloads.push({ timeoutMs: body.timeoutMs });
        return Response.json({
          command: body.command,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          truncated: false,
          timedOut: false,
          elapsedMs: 30_000,
        });
      }
      return Response.json({ error: `unexpected ${path}` }, { status: 404 });
    }) as unknown as typeof fetch;

    const gateway = createComputerGateway({
      provider,
      fetchImpl,
      auditStore: { insert: async () => {} },
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    });

    const runId = "run-gw-budget-test";
    clearRunBudget(runId);
    try {
      // 预扣到只剩 30s
      recordElapsed(runId, DEFAULT_COMMAND_BUDGET_MS - 30_000);

      await withConfirmTurn(
        { threadId: "t-gw", runId, stopped: () => false },
        async () => {
          await gateway.runCommand(
            "bot-1",
            { id: "u-1" },
            {
              command: "echo hi",
              timeoutMs: 120_000,
            },
          );
          expect(execPayloads).toEqual([{ timeoutMs: 30_000 }]);

          await expect(
            gateway.runCommand(
              "bot-1",
              { id: "u-1" },
              {
                command: "echo blocked",
                timeoutMs: 10_000,
              },
            ),
          ).rejects.toThrow(COMMAND_BUDGET_EXHAUSTED_CODE);
          expect(execPayloads).toHaveLength(1);
        },
      );
    } finally {
      clearRunBudget(runId);
    }
  });
});
