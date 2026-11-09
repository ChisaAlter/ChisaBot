import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  gatewayLoginRequired,
  interruptWaitingKind,
} from "../src/lib/compat/legacy-client";

const source = readFileSync(
  new URL("../public/compat/legacy-browser.js", import.meta.url),
  "utf8",
);
/** What the compat script hangs on the global it is given. */
const root: {
  ChisaLegacyBrowser?: {
    gatewayLoginRequired: (body: unknown) => boolean;
    migrateStorage: (
      store: Pick<Storage, "length" | "key" | "getItem" | "setItem">,
    ) => void;
  };
} = {};
new Function("globalThis", source)(root);

test("current and pre-rename gateways keep the same login boundary in app and worker", () => {
  for (const read of [
    gatewayLoginRequired,
    root.ChisaLegacyBrowser?.gatewayLoginRequired ?? (() => undefined),
  ]) {
    expect(read({ chisabotAuthRequired: true })).toBe(true);
    expect(read({ openbotAuthRequired: true })).toBe(true);
    expect(read({ chisabotAuthRequired: false })).toBe(false);
    expect(read({ error: "unauthorized" })).toBe(false);
    expect(read(null)).toBe(false);
  }
});

test("old theme, layout and drafts survive without replacing newer preferences", () => {
  const values = new Map([
    ["openbot-theme", "dark"],
    ["openbot-layout", "phone"],
    ["chisabot-layout", "wide"],
    ["openbot:draft:thread", "unfinished message"],
    ["unrelated", "keep"],
  ]);
  root.ChisaLegacyBrowser?.migrateStorage({
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  });
  expect(values.get("chisabot-theme")).toBe("dark");
  expect(values.get("chisabot-layout")).toBe("wide");
  expect(values.get("chisabot:draft:thread")).toBe("unfinished message");
  expect(values.get("openbot:draft:thread")).toBe("unfinished message");
  expect(values.get("unrelated")).toBe("keep");
});

test("persisted uncertain effects remain visibly uncertain after the field rename", () => {
  expect(
    interruptWaitingKind({ openbotWaiting: { kind: "operation_unknown" } }),
  ).toBe("operation_unknown");
  expect(
    interruptWaitingKind({ chisabotWaiting: { kind: "operation_unknown" } }),
  ).toBe("operation_unknown");
  expect(interruptWaitingKind({})).toBeUndefined();
});
