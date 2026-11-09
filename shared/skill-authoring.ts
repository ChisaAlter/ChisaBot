import { z } from "zod";

export const proposedSkillSchema = z.object({
  slug: z
    .string()
    .describe(
      "The `/` command, in lower-case letters, numbers and hyphens: `check-a-claim`, not `Check A Claim`. 2 to 40 characters. This is the skill's identity — reusing one that already exists replaces that skill.",
    ),
  title: z
    .string()
    .describe(
      "What the skill is called in the menu, in a few words of sentence case: `Check a claim against a source`. Up to 120 characters.",
    ),
  summary: z
    .string()
    .optional()
    .describe(
      "One line under the title, saying what invoking it will do. Up to 200 characters. Omit only if the title already says everything.",
    ),
  instructions: z
    .string()
    .describe(
      "The instruction the Bot follows when somebody invokes this skill, written as directions to the Bot in the imperative. Say what to do, in what order, what to do when a step turns up nothing, and what the answer should contain. Explain why a step matters rather than only naming it. Do not describe the skill in the third person, and do not address the person invoking it.",
    ),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      "The tools the skill needs, as `serverId/toolName` refs from list_skill_tools. This is a declaration, not a grant: naming a tool cannot make it callable, and a skill naming a tool its Bot does not hold simply loads nothing. Omit for a skill that is only prose.",
    ),
});

export type ProposedSkill = z.infer<typeof proposedSkillSchema>;
export const savedSkillAnswer = (slug: string) =>
  `Saved. /${slug} is now in the slash menu. It is on no Bot yet — putting it on one is done from the Skills page, so tell the person that is the remaining step.`;
