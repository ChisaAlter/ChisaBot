/**
 * localStorage for 「安装 ChisaBot 应用」胶囊（DESIGN.md §40.3 / DOG-03）。
 * Kept free of React so unit tests do not mount the router.
 */
export const INSTALL_HINT_KEY = "chisabot-install-hint";
export const INSTALL_HINT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

export function installHintDismissed(): boolean {
  try {
    const raw = window.localStorage.getItem(INSTALL_HINT_KEY);
    if (!raw) return false;
    const value = JSON.parse(raw) as {
      dismissed?: boolean;
      dismissedAt?: number;
      snoozeUntil?: number;
    };
    if (value.dismissed === true) return true;
    if (typeof value.snoozeUntil === "number")
      return Date.now() < value.snoozeUntil;
    // Legacy: dismissedAt alone (early permanent / old snooze) → stay hidden.
    return typeof value.dismissedAt === "number";
  } catch {
    return false;
  }
}

export function rememberInstallHintDismiss(): void {
  try {
    window.localStorage.setItem(
      INSTALL_HINT_KEY,
      JSON.stringify({ dismissed: true, dismissedAt: Date.now() }),
    );
  } catch {}
}

/** Install dialog cancelled / timed out → snooze 14 days (not every session). */
export function rememberInstallHintSnooze(): void {
  try {
    const now = Date.now();
    window.localStorage.setItem(
      INSTALL_HINT_KEY,
      JSON.stringify({
        dismissedAt: now,
        snoozeUntil: now + INSTALL_HINT_SNOOZE_MS,
      }),
    );
  } catch {}
}
