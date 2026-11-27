import {
  normalizeBlockedDomainRule,
  normalizeBlockedDomains,
  normalizeBrowserPermissionTier,
} from "../../../shared/browser-companion";
import type { ChromeStorageArea } from "../types/chrome";
import type {
  AppearancePrefs,
  CompanionAuthRecord,
  CompanionLocalSettings,
  MaterialId,
  ThemeId,
} from "../types/protocol";

const AUTH_KEY = "chisabot_companion_auth_v1";
const SETTINGS_KEY = "chisabot_companion_settings_v1";

const VALID_THEMES = new Set<ThemeId>([
  "sky",
  "aurora",
  "porcelain",
  "deepseek",
  "claude",
  "cossui",
]);

const VALID_MATERIALS = new Set<MaterialId>(["glass", "clear", "solid"]);

export function defaultAppearance(): AppearancePrefs {
  return {
    theme: "sky",
    material: "glass",
    colorMode: "system",
  };
}

export function defaultSettings(): CompanionLocalSettings {
  return {
    tier: "cautious",
    blockedDomains: [],
    allowRemoteDispatch: true,
    appearance: defaultAppearance(),
    selectedBotId: null,
    attachedByDefault: true,
  };
}

export function normalizeDomainEntry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return normalizeBlockedDomainRule(raw);
}

export function normalizeSettings(raw: unknown): CompanionLocalSettings {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Record<string, unknown>;

  if (input.tier !== undefined) {
    base.tier = normalizeBrowserPermissionTier(input.tier);
  }
  if (Array.isArray(input.blockedDomains)) {
    base.blockedDomains = normalizeBlockedDomains(input.blockedDomains);
  }
  if (typeof input.allowRemoteDispatch === "boolean") {
    base.allowRemoteDispatch = input.allowRemoteDispatch;
  }
  if (typeof input.selectedBotId === "string" && input.selectedBotId.trim()) {
    base.selectedBotId = input.selectedBotId.trim();
  }
  if (typeof input.attachedByDefault === "boolean") {
    base.attachedByDefault = input.attachedByDefault;
  }
  if (input.appearance && typeof input.appearance === "object") {
    const ap = input.appearance as Record<string, unknown>;
    if (typeof ap.theme === "string" && VALID_THEMES.has(ap.theme as ThemeId)) {
      base.appearance.theme = ap.theme as ThemeId;
    }
    if (
      typeof ap.material === "string" &&
      VALID_MATERIALS.has(ap.material as MaterialId)
    ) {
      base.appearance.material = ap.material as MaterialId;
    }
    if (
      ap.colorMode === "light" ||
      ap.colorMode === "dark" ||
      ap.colorMode === "system"
    ) {
      base.appearance.colorMode = ap.colorMode;
    }
  }
  return base;
}

export function normalizeAuth(raw: unknown): CompanionAuthRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  if (
    typeof input.serverUrl !== "string" ||
    !input.serverUrl.trim() ||
    typeof input.deviceToken !== "string" ||
    !input.deviceToken.trim() ||
    typeof input.deviceId !== "string" ||
    !input.deviceId.trim()
  ) {
    return null;
  }
  return {
    serverUrl: input.serverUrl.trim().replace(/\/+$/, ""),
    deviceToken: input.deviceToken.trim(),
    deviceId: input.deviceId.trim(),
    deviceName:
      typeof input.deviceName === "string" && input.deviceName.trim()
        ? input.deviceName.trim()
        : "Chrome 浏览器伴侣",
    ...(typeof input.userId === "string" ? { userId: input.userId } : {}),
    ...(typeof input.userName === "string" ? { userName: input.userName } : {}),
    ...(typeof input.userEmail === "string"
      ? { userEmail: input.userEmail }
      : {}),
    enrolledAt:
      typeof input.enrolledAt === "string"
        ? input.enrolledAt
        : new Date().toISOString(),
  };
}

export function createCompanionStorage(
  area: ChromeStorageArea = chrome.storage.local,
) {
  return {
    async loadAuth(): Promise<CompanionAuthRecord | null> {
      const data = await area.get(AUTH_KEY);
      return normalizeAuth(data[AUTH_KEY]);
    },
    async saveAuth(auth: CompanionAuthRecord | null): Promise<void> {
      if (!auth) {
        await area.remove(AUTH_KEY);
        return;
      }
      await area.set({ [AUTH_KEY]: auth });
    },
    async loadSettings(): Promise<CompanionLocalSettings> {
      const data = await area.get(SETTINGS_KEY);
      return normalizeSettings(data[SETTINGS_KEY]);
    },
    async saveSettings(settings: CompanionLocalSettings): Promise<void> {
      await area.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
    },
  };
}

export type CompanionStorage = ReturnType<typeof createCompanionStorage>;
