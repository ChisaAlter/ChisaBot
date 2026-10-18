import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  INSTALL_HINT_KEY,
  installHintDismissed,
  rememberInstallHintDismiss,
  rememberInstallHintSnooze,
} from "@/lib/install-hint-storage";

beforeAll(() => {
  if (!(globalThis as { window?: unknown }).window)
    GlobalRegistrator.register();
});

afterEach(() => {
  window.localStorage.removeItem(INSTALL_HINT_KEY);
});

test("× dismiss is permanent", () => {
  expect(installHintDismissed()).toBe(false);
  rememberInstallHintDismiss();
  expect(installHintDismissed()).toBe(true);
});

test("install cancel snoozes for 14 days", () => {
  rememberInstallHintSnooze();
  expect(installHintDismissed()).toBe(true);
  const raw = JSON.parse(window.localStorage.getItem(INSTALL_HINT_KEY)!);
  expect(raw.snoozeUntil).toBeGreaterThan(
    Date.now() + 13 * 24 * 60 * 60 * 1000,
  );
});
