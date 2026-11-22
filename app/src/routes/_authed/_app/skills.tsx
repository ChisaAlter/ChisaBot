import { createFileRoute, redirect } from "@tanstack/react-router";

type SkillsSearch = {
  new?: boolean;
  edit?: string;
};

/** 上游旧技能页已由 设置 → 技能（DESIGN.md §51）取代，重定向过去（§57 导航收敛）。 */
function validateSkillsSearch(search: Record<string, unknown>): SkillsSearch {
  const out: SkillsSearch = {};
  if (typeof search.new === "boolean") out.new = search.new;
  if (typeof search.edit === "string") out.edit = search.edit;
  return out;
}

export const Route = createFileRoute("/_authed/_app/skills")({
  validateSearch: validateSkillsSearch,
  beforeLoad: () => {
    throw redirect({ to: "/settings/skills", replace: true });
  },
});
