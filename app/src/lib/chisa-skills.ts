import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** 设置 → 技能（DESIGN.md §51，docs/skills.md）。 */
export type ChisaSkill = { slug: string; title: string; summary: string; instructions: string; mine: boolean };

export type ChisaSkillHubItem = {
  slug: string;
  title: string;
  category: string;
  summary: string;
  instructions: string;
  installed: boolean;
};

export const chisaSkillKeys = {
  all: ["chisa-skills"] as const,
  hub: ["chisa-skills", "hub"] as const,
};

export function chisaSkillsQueryOptions() {
  return queryOptions({
    queryKey: chisaSkillKeys.all,
    queryFn: ({ signal }): Promise<ChisaSkill[]> => client("/api/chisa-skills", "skills", { fallback: "无法加载技能", signal }),
    refetchOnWindowFocus: "always",
  });
}

export function chisaSkillHubQueryOptions() {
  return queryOptions({
    queryKey: chisaSkillKeys.hub,
    queryFn: ({ signal }): Promise<ChisaSkillHubItem[]> =>
      client("/api/chisa-skills/hub", "hub", { fallback: "无法加载精选技能库", signal }),
  });
}

export async function importChisaSkill(input: {
  hubSlug?: string;
  url?: string;
  markdown?: string;
  slug?: string;
}): Promise<{ skill?: ChisaSkill | null; skills?: ChisaSkill[]; installedCount: number }> {
  const response = await client("/api/chisa-skills/import", {
    method: "POST",
    body: input,
    fallback: "导入技能失败，请重试",
  });
  return (await response.json()) as {
    skill?: ChisaSkill | null;
    skills?: ChisaSkill[];
    installedCount: number;
  };
}

export function saveChisaSkill(slug: string, input: { title: string; summary: string; instructions: string; create?: boolean }): Promise<ChisaSkill> {
  return client(`/api/chisa-skills/${encodeURIComponent(slug)}`, "skill", { method: "PUT", body: input, fallback: "保存失败，请重试" });
}

export async function deleteChisaSkill(slug: string) {
  await client(`/api/chisa-skills/${encodeURIComponent(slug)}`, { method: "DELETE", fallback: "删除失败，请重试" });
}
