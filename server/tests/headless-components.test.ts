import { describe, expect, test } from "bun:test";
import { NOT_SHOWN } from "../../shared/component-markers";
import type { AuditEventInput } from "../src/audit";
import {
  createHeadlessComponentTools,
  HEADLESS_COMPONENTS,
} from "../src/components/headless";
import type {
  ComponentDecision,
  ComponentStore,
} from "../src/components/store";

function fakeStore(decision: ComponentDecision): ComponentStore {
  return {
    listForAgent: async () =>
      decision.allowed
        ? [{ name: "showBarChart", description: decision.description }]
        : [],
    decide: async () => decision,
    mayCall: async () => false,
  } as unknown as ComponentStore;
}

describe("headless component tools", () => {
  const initiator = { kind: "routine" as const, id: "routine-1" };
  const valid = { title: "Revenue", points: [{ label: "Q1", value: 3 }] };

  test("a held chart is offered with its published description and records a confirmation", async () => {
    const tools = await createHeadlessComponentTools({
      store: fakeStore({ allowed: true, description: "Published wording." }),
      botId: "bot",
      ownerUserId: "owner",
      initiator,
    });
    const bar = tools.find((tool) => tool.definition.name === "showBarChart");
    expect(bar?.hidden).toBeUndefined();
    expect(bar?.definition.description).toBe("Published wording.");
    await expect(
      bar?.execute(valid, {
        toolCallId: "c",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(
      "The bar chart is saved in this conversation and is drawn when the person opens it.",
    );
    // Components the Bot does not hold are registered but never offered.
    expect(
      tools.find((tool) => tool.definition.name === "showLineChart")?.hidden,
    ).toBeTrue();
  });

  test("invalid arguments and a refused decision are recorded as not shown and audited", async () => {
    const audit: AuditEventInput[] = [];
    const auditStore = {
      insert: async (event: AuditEventInput) => {
        audit.push(event);
      },
    };
    const refused = await createHeadlessComponentTools({
      store: fakeStore({
        allowed: false,
        reason: "Bar chart has been withheld from this Bot.",
      }),
      botId: "bot",
      ownerUserId: "owner",
      initiator,
      auditStore,
    });
    const bar = refused.find((tool) => tool.definition.name === "showBarChart");
    expect(bar?.hidden).toBeTrue();
    const context = { toolCallId: "c", signal: new AbortController().signal };
    const invalid = String(await bar?.execute({ title: 1 }, context));
    expect(invalid.startsWith(`${NOT_SHOWN}Bar chart. `)).toBeTrue();
    expect(invalid).toContain("does not match its declared shape");
    const denied = String(await bar?.execute(valid, context));
    expect(denied).toBe(
      `${NOT_SHOWN}Bar chart. Bar chart has been withheld from this Bot. Nothing was displayed, so tell the person that.`,
    );
    expect(audit).toEqual([
      expect.objectContaining({
        eventType: "component.refused",
        targetId: "showBarChart",
        actorUserId: "owner",
        initiator,
        payload: expect.objectContaining({ bot: "bot", invalid: true }),
      }),
      expect.objectContaining({
        eventType: "component.refused",
        initiator,
        payload: expect.objectContaining({
          reason: "Bar chart has been withheld from this Bot.",
          headless: true,
        }),
      }),
    ]);
  });

  test("a component that reads ungranted data is refused before it is recorded", async () => {
    const tools = await createHeadlessComponentTools({
      store: fakeStore({ allowed: true, description: "Reads." }),
      botId: "bot",
      ownerUserId: "owner",
      initiator,
      specs: [
        {
          ...(HEADLESS_COMPONENTS.find(
            (spec) => spec.name === "showBarChart",
          ) as (typeof HEADLESS_COMPONENTS)[number]),
          reads: () => ["auditSummary"],
        },
      ],
    });
    const result = String(
      await tools[0]?.execute(valid, {
        toolCallId: "c",
        signal: new AbortController().signal,
      }),
    );
    expect(result).toContain("has not been granted the function auditSummary");
    expect(result.startsWith(NOT_SHOWN)).toBeTrue();
  });
});
