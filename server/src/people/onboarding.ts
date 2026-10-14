import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";

/**
 * Where one person is in first-run onboarding.
 *
 * A null `completedAt` is what gates the app into /onboarding. `step` is stored and served but
 * NOTHING RESUMES FROM IT YET: the wizard keeps its step in browser state while its content is
 * still being designed, so this stays 0 through a whole run. It exists so resuming is a frontend
 * change when the wizard settles, not a migration.
 */
export type OnboardingStatus = {
  step: number;
  completedAt: string | null;
};

export type OnboardingStore = {
  status: (userId: string) => Promise<OnboardingStatus>;
  setStep: (userId: string, step: number) => Promise<void>;
  complete: (userId: string) => Promise<void>;
  /** 个人资料（显示名称 + 头像），存在 users 行上；单用户部署的身份是固定的，所以从这里读。 */
  profile: (userId: string) => Promise<UserProfile>;
  setProfile: (userId: string, profile: UserProfile) => Promise<void>;
};

export type UserProfile = { name: string | null; image: string | null };

/** 头像：客户端裁好的正方形小图（data URL），上限 400 KB。 */
export const PROFILE_IMAGE_MAX = 400_000;
export const PROFILE_NAME_MAX = 40;

/** 校验并整理个人资料；不合法返回错误文案。 */
export function parseProfileInput(
  body: unknown,
):
  | { ok: true; value: { name?: string; image?: string | null } }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object")
    return { ok: false, error: "请求体无效。" };
  const input = body as { name?: unknown; image?: unknown };
  const value: { name?: string; image?: string | null } = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string")
      return { ok: false, error: "名称无效。" };
    const name = input.name.replace(/\s+/g, " ").trim();
    if (!name) return { ok: false, error: "名称不能为空。" };
    if ([...name].length > PROFILE_NAME_MAX)
      return { ok: false, error: `名称最多 ${PROFILE_NAME_MAX} 个字。` };
    value.name = name;
  }
  if (input.image !== undefined) {
    if (input.image === null || input.image === "") value.image = null;
    else if (typeof input.image !== "string")
      return { ok: false, error: "头像格式无效。" };
    else {
      const portrait = parsePortraitDataUrl(input.image);
      if (!portrait.ok) return portrait;
      value.image = portrait.image;
    }
  }
  if (value.name === undefined && value.image === undefined)
    return { ok: false, error: "没有要保存的内容。" };
  return { ok: true, value };
}

/**
 * A cropped square portrait, the same data URL `/api/me/profile` stores.
 *
 * Bot create uses this too: the picture is written into `avatar_seed`, not a second column.
 */
export function parsePortraitDataUrl(
  value: string,
): { ok: true; image: string } | { ok: false; error: string } {
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    return { ok: false, error: "头像格式无效。" };
  }
  if (value.length > PROFILE_IMAGE_MAX)
    return { ok: false, error: "头像太大。" };
  return { ok: true, image: value };
}

/** 还没设置过名称（空，或仍是邮箱）——首次进入时要先设置个人资料。 */
export function profileNeedsSetup(
  profile: UserProfile,
  email: string,
): boolean {
  const name = profile.name?.trim() ?? "";
  return !name || name.toLowerCase() === email.trim().toLowerCase();
}

export function createOnboardingStore(database: Database): OnboardingStore {
  return {
    async status(userId) {
      const [row] = await database
        .select({
          step: users.onboardingStep,
          completedAt: users.onboardingCompletedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      /*
       * No row reads as not started rather than as an error. It should not happen — a session
       * cannot outlive its users row (the foreign key cascades) and the single-user actor's row is
       * seeded at startup — but a guard that throws here would take /api/me down with it.
       */
      return {
        step: row?.step ?? 0,
        completedAt: row?.completedAt ? row.completedAt.toISOString() : null,
      };
    },

    async setStep(userId, step) {
      await database
        .update(users)
        .set({ onboardingStep: step, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    async complete(userId) {
      await database
        .update(users)
        .set({
          // Idempotent: finishing again keeps the first timestamp, so "when did they onboard"
          // stays one answer.
          onboardingCompletedAt: sql`coalesce(${users.onboardingCompletedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    },

    async profile(userId) {
      const [row] = await database
        .select({ name: users.name, image: users.image })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return { name: row?.name ?? null, image: row?.image ?? null };
    },

    async setProfile(userId, profile) {
      await database
        .update(users)
        .set({ ...profile, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },
  };
}
