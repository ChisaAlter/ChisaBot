import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CommandOption } from "@/components/channels/composer";
import { useExternalConnection } from "@/hooks";
import { chisaSkillsQueryOptions } from "@/lib/chisa-skills";
import { useKeptVisibility } from "@/lib/kept-visible";
import { agentPluginsQueryOptions, pluginKeys } from "@/lib/plugins/queries";

const SKILL_COMMANDS_POLL_MS = 15_000;

/**
 * Granted skills + user/shared ChisaSkills as `/` menu commands. Each one inserts a chip, not composer text.
 */
export function useSkillCommands(agentId: string): CommandOption[] {
  const queryClient = useQueryClient();
  // 用非重渲可见性 store 门控轮询：ChannelChat 调用本 Hook，读 KeptVisibleContext 会导致进出设置重画整棵聊天树。
  const visibility = useKeptVisibility();
  const { data } = useQuery({
    ...agentPluginsQueryOptions(agentId),
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
  const { data: chisaSkills } = useQuery({
    ...chisaSkillsQueryOptions(),
    refetchOnWindowFocus: () => (visibility.get() ? "always" : false),
  });

  useExternalConnection(agentId ? `skill-commands:${agentId}` : false, () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let wasHidden = !visibility.get();
    const isPageVisible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const pollNowIfStale = () => {
      const state = queryClient.getQueryState(pluginKeys.forAgent(agentId));
      const lastAttemptAt = Math.max(
        state?.dataUpdatedAt ?? 0,
        state?.errorUpdatedAt ?? 0,
      );
      // 15 秒窗口内刚拉过（含 404 等错误退避）：快速切频道回来不立刻重发，避免切换风暴。
      if (lastAttemptAt > 0 && Date.now() - lastAttemptAt < SKILL_COMMANDS_POLL_MS) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: pluginKeys.forAgent(agentId),
        refetchType: "active",
      });
    };
    const sync = () => {
      const active = visibility.get() && isPageVisible();
      if (!active) {
        wasHidden = true;
        stop();
        return;
      }
      if (wasHidden) {
        wasHidden = false;
        pollNowIfStale();
      }
      if (timer === undefined) {
        timer = setInterval(() => {
          if (!visibility.get() || !isPageVisible()) {
            stop();
            return;
          }
          pollNowIfStale();
        }, SKILL_COMMANDS_POLL_MS);
      }
    };
    sync();
    const unsubscribeVisibility = visibility.subscribe(sync);
    const hasDocument = typeof document !== "undefined";
    if (hasDocument) document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      unsubscribeVisibility();
      if (hasDocument) document.removeEventListener("visibilitychange", sync);
    };
  });

  return useMemo(() => {
    const bySlug = new Map<
      string,
      { slug: string; title: string; summary: string; instructions: string }
    >();
    for (const skill of data?.skills ?? []) {
      bySlug.set(skill.slug, skill);
    }
    for (const skill of chisaSkills ?? []) {
      if (!bySlug.has(skill.slug)) {
        bySlug.set(skill.slug, skill);
      }
    }
    return [...bySlug.values()].map((skill) => ({
      id: skill.slug,
      name: skill.slug,
      description: skill.summary ? `${skill.title} — ${skill.summary}` : skill.title,
      /*
       * A CHIP, NOT AN EXPANSION. `prompt` used to paste the skill's whole instruction into the
       * box, which meant a person watched a paragraph they did not write appear over the message
       * they were typing, and had to scroll past it to reach their own words.
       *
       * The chip stays, one token wide, and `channel-chat` reads `draft.commandIds` on send and
       * puts the instruction in front of the run. Nothing is hidden by this that was not already:
       * the instruction is the skill's own text, visible on the skills page, and a skill is an
       * instruction rather than a capability — it can only ask for tools the Bot already holds.
       */
      kind: "chip" as const,
      /*
       * Carried on the option rather than looked up again at send time. `applyCommandChips` only
       * substitutes `prompt` for `kind: "prompt"`, so on a chip this is inert payload, and the
       * alternative is a second query racing the first for the same rows.
       */
      prompt: skill.instructions,
    }));
  }, [data, chisaSkills]);
}
