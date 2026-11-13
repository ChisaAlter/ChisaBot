import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { PersonalSourcesStatusView } from "../../../../shared/personal-sources";

/** 设置 → 个人助理 → 日程、收件箱、通知推送与每日晨报。 */
export const personalSourcesKeys = {
  all: ["personal-sources"] as const,
};

export function personalSourcesStatusQueryOptions() {
  return queryOptions({
    queryKey: personalSourcesKeys.all,
    queryFn: async (): Promise<PersonalSourcesStatusView> => {
      const response = await client("/api/personal-sources", {
        fallback: "无法读取个人日程与收件箱状态",
      });
      return response.json();
    },
  });
}
