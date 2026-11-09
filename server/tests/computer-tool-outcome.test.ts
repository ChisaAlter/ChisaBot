import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApprovalRoutes } from "../src/approvals/routes";
import type { ApprovalService } from "../src/approvals/service";
import {
  ActionRefusedError,
  ComputerUnavailableError,
  ElementNotFoundError,
  HumanHasControlError,
  StaleSnapshotError,
  WorkspaceRequestError,
} from "../src/computer/gateway";
import { computerFailureOutcome } from "../src/computer/tool-outcome";

/**
 * 计算机操作的普通失败是这一步的结果，不是 500（DESIGN.md §100）。
 *
 * 2026-10-17 22:46 生产：星灵在 Hark 注册页的月份下拉框上按 Enter，agent-computer 超时，
 * POST /api/approvals/computer 回了 500「Element f4e36 is not on the page any more…」。
 * 网页里的工具处理函数一抛错，conversation runtime 就不再发起下一轮——这一轮没有回答、没有提示。
 */

describe("computerFailureOutcome", () => {
  test("maps each ordinary computer failure to a result the Bot can act on", () => {
    expect(
      computerFailureOutcome(
        new ElementNotFoundError("Element f4e36 is not on the page any more."),
      ),
    ).toEqual({
      ok: false,
      reason: "Element f4e36 is not on the page any more.",
      staleRefs: true,
    });
    expect(computerFailureOutcome(new StaleSnapshotError("old", true))).toEqual(
      {
        ok: false,
        reason: "old",
        staleRefs: true,
        snapshotRequired: true,
      },
    );
    expect(
      computerFailureOutcome(new ActionRefusedError("no", "rule-1")),
    ).toEqual({
      ok: false,
      reason: "no",
      refused: true,
      rule: "rule-1",
    });
    expect(
      computerFailureOutcome(new HumanHasControlError("held", "req-1")),
    ).toEqual({
      ok: false,
      reason: "held",
      humanHasControl: true,
      requestId: "req-1",
    });
    expect(
      computerFailureOutcome(
        new WorkspaceRequestError("这个下拉框里没有「1800」对应的选项。"),
      ),
    ).toEqual({
      ok: false,
      reason: "这个下拉框里没有「1800」对应的选项。",
    });
    expect(
      computerFailureOutcome(new ComputerUnavailableError("down")),
    ).toEqual({
      ok: false,
      reason: "down",
      unavailable: true,
    });
  });

  test("leaves real program errors alone", () => {
    expect(computerFailureOutcome(new TypeError("x is undefined"))).toBeNull();
    expect(computerFailureOutcome("nope")).toBeNull();
  });
});

describe("POST /api/approvals/computer/:botId", () => {
  const app = (thrown: unknown) => {
    const service = {
      frontendAction: async () => {
        throw thrown;
      },
    } as unknown as ApprovalService;
    const root = new Hono();
    root.route(
      "/",
      createApprovalRoutes(service, async (context, next) => {
        context.set(
          "actor" as never,
          { id: "dev-local-user", role: "admin" } as never,
        );
        await next();
      }),
    );
    return root;
  };
  const post = (thrown: unknown) =>
    app(thrown).request("/computer/agent_1", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

  test("a stale element is a 200 result with ok:false, so the turn continues", async () => {
    const response = await post(
      new ElementNotFoundError(
        "Element f4e36 is not on the page any more. Take a fresh snapshot and use the refs from it.",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        ok: false,
        reason:
          "Element f4e36 is not on the page any more. Take a fresh snapshot and use the refs from it.",
        staleRefs: true,
      },
    });
  });

  test("an unknown error is still a 500", async () => {
    const response = await post(new TypeError("bug"));
    expect(response.status).toBe(500);
  });
});
