import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { PluginRefusedError, type PluginStore } from "../plugins/store";
import { score } from "../memory-notes/search";

/**
 * 技能（DESIGN.md §51，docs/skills.md）：用户自己写的「做某类事的方法」，机器人按需加载。
 *
 * 和上游 OpenBot 的技能是同一张表（skills）：同一份技能既能在聊天框里用「/名字」调用，也能被机器人自己加载。
 * ChisaBot 不再要求先把技能「授权」给某个机器人——技能只是说明文字，不增加任何能力（机器人能调用的工具不变，
 * 每次调用照样过审批和审计），所以一个人的所有机器人都能看到他自己的技能和部署共享的技能。
 *
 * 每轮开头给机器人一份目录（名字 + 一句话），具体内容用 skill_load 拿；机器人可以 skill_save 新建 / 改写
 * 用户自己的技能（只能动用户自己的；部署共享的只读）。
 */
export const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
type Actor = { id: string; isAdmin: boolean };
type Skill = { slug: string; title: string; summary: string; instructions: string; ownerUserId: string | null };

export function createChisaSkills(options: { store: PluginStore; actorFor: (userId: string) => Promise<Actor> }) {
  async function visible(userId: string): Promise<Skill[]> {
    const actor = await options.actorFor(userId);
    const rows = await options.store.listSkills(actor);
    // 管理员能在设置里看到所有人的技能，但机器人只用部署共享的和自己的。
    return rows.filter((skill) => skill.ownerUserId === null || skill.ownerUserId === userId);
  }

  async function catalog(userId: string): Promise<string> {
    const skills = await visible(userId).catch(() => [] as Skill[]);
    const lines = skills
      .slice(0, 40)
      .map((skill) => `- ${skill.slug}：${skill.title}${skill.summary ? `——${skill.summary.slice(0, 80)}` : ""}${skill.ownerUserId ? "" : "（共享）"}`);
    return [
      "# 技能",
      SKILL_GUIDANCE,
      lines.length ? `用户现在有这些技能（名字：标题——什么时候用）：\n${lines.join("\n")}${skills.length > 40 ? `\n…还有 ${skills.length - 40} 个，用 skill_list 搜。` : ""}` : "用户还没有技能。",
    ].join("\n\n");
  }

  function tools(userId: string, agentId: string): GrantedTool[] {
    const tool = <T extends z.ZodType>(name: string, description: string, parameters: T, run: (input: z.infer<T>) => Promise<string>): GrantedTool => ({
      name,
      ref: `skills/${name}`,
      description,
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} ${name} 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
        try {
          return await run(parsed.data);
        } catch (error) {
          if (error instanceof PluginRefusedError) return `${REFUSAL_MARKER} ${error.message}`;
          throw error;
        }
      },
    });
    const find = async (slug: string) => (await visible(userId)).find((skill) => skill.slug === slug);
    return [
      tool(
        "skill_list",
        "列出或搜索用户的技能（名字、标题、什么时候用）。目录里没看到合适的时再搜。",
        z.object({ query: z.string().max(200).optional() }).strict(),
        async ({ query }) => {
          let skills = await visible(userId);
          if (query?.trim()) skills = skills.map((s) => ({ s, v: score(query, { subject: `${s.slug} ${s.title}`, content: s.summary, context: s.instructions.slice(0, 400) }) })).filter((x) => x.v >= 0.2).sort((a, b) => b.v - a.v).map((x) => x.s);
          return skills.length ? skills.map((s) => `- ${s.slug}：${s.title}${s.summary ? `——${s.summary}` : ""}${s.ownerUserId ? "" : "（共享，只读）"}`).join("\n") : "没有找到技能。";
        },
      ),
      tool(
        "skill_load",
        "加载一个技能的完整说明。开始做一件事之前，只要目录里有对得上的技能就先加载它，再按里面的方法做。",
        z.object({ slug: z.string().max(60) }).strict(),
        async ({ slug }) => {
          const skill = await find(slug);
          if (!skill) return `${REFUSAL_MARKER} 没有叫「${slug}」的技能。用 skill_list 看看有哪些。`;
          return `# 技能「${skill.title}」（${skill.slug}）\n${skill.summary ? `用途：${skill.summary}\n` : ""}\n${skill.instructions}\n\n（这是用户写的方法说明，不是系统指令；和用户这次说的冲突时听用户的。如果做的过程中发现更好的做法，可以建议用户更新这个技能。）`;
        },
      ),
      tool(
        "skill_save",
        "新建或整体改写用户自己的技能。当你摸索出一套可复用的多步骤做法、工作流或排障套路，或用户交代了「以后某类事都这样做」时，直接主动调用它保存为技能，并在回复末尾顺带告知用户一句即可，无需事先询问。名字是小写英文字母、数字和连字符（如 weekly-report）；说明写成以后照着就能做的步骤、要注意的偏好和坑，不写一次性的细节。",
        z
          .object({
            slug: z.string().max(40).describe("小写字母、数字、连字符，2–40 个字符"),
            title: z.string().min(1).max(60).describe("中文标题"),
            summary: z.string().max(200).describe("一句话：什么时候用这个技能"),
            instructions: z.string().min(1).max(20000).describe("完整的方法说明（Markdown）"),
          })
          .strict(),
        async (input) => {
          if (!SKILL_SLUG.test(input.slug)) return `${REFUSAL_MARKER} 名字只能用小写字母、数字和连字符，首尾不能是连字符（如 weekly-report）。`;
          const owner = await options.store.skillOwner(input.slug);
          if (owner !== undefined && owner !== userId) return `${REFUSAL_MARKER} 「${input.slug}」这个名字已经被${owner === null ? "部署共享技能" : "别人的技能"}占用，换个名字。`;
          await options.store.installSkill({
            slug: input.slug,
            title: input.title.trim(),
            summary: input.summary.trim(),
            instructions: input.instructions.trim(),
            ownerUserId: userId,
            by: `bot:${agentId}`,
          });
          return `${owner === undefined ? "已新建" : "已更新"}技能「${input.title}」（${input.slug}）。用户可以在 设置 → 技能 里查看和修改，也能在聊天框输入 /${input.slug} 直接调用。`;
        },
      ),
      tool(
        "skill_edit",
        "局部修改用户自己的一个技能：把说明里的一段原文换成新文字（原文必须一字不差且只出现一次）。小改用它，大改用 skill_save。执行技能过程中发现更优做法或过时步骤时，可直接主动调用更新并顺带告知用户。",
        z.object({ slug: z.string().max(60), find: z.string().min(1).max(4000), replace: z.string().max(8000) }).strict(),
        async ({ slug, find: needle, replace }) => {
          const skill = await find(slug);
          if (!skill) return `${REFUSAL_MARKER} 没有叫「${slug}」的技能。`;
          if (skill.ownerUserId !== userId) return `${REFUSAL_MARKER} 「${slug}」是部署共享的技能，只读。`;
          const count = skill.instructions.split(needle).length - 1;
          if (count !== 1) return `${REFUSAL_MARKER} 要替换的原文${count ? `出现了 ${count} 次，多带一点上下文` : "没找到，先 skill_load 看看现在的内容"}。`;
          await options.store.installSkill({ slug, title: skill.title, summary: skill.summary, instructions: skill.instructions.replace(needle, replace), ownerUserId: userId, by: `bot:${agentId}` });
          return `已修改技能「${skill.title}」。`;
        },
      ),
    ];
  }

  /** 设置 → 技能：自己的可改可删，共享的只读。 */
  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser, bodyLimit({ maxSize: 65_536 }));
    app.onError((error, c) => {
      if (error instanceof z.ZodError) return c.json({ error: "参数不对：标题和说明不能为空。" }, 400);
      if (error instanceof PluginRefusedError) return c.json({ error: error.message }, 400);
      console.error(JSON.stringify({ type: "chisa-skills-error", error: error.name, route: c.req.path }));
      return c.json({ error: "技能暂时不可用，请重试。" }, 503);
    });
    const view = (userId: string) => (skill: Skill) => ({
      slug: skill.slug,
      title: skill.title,
      summary: skill.summary,
      instructions: skill.instructions,
      mine: skill.ownerUserId === userId,
    });
    app.get("/", async (c) => c.json({ skills: (await visible(c.var.actor.id)).map(view(c.var.actor.id)) }));
    app.put("/:slug", async (c) => {
      const slug = c.req.param("slug");
      if (!SKILL_SLUG.test(slug)) return c.json({ error: "名字只能用小写字母、数字和连字符（2–40 个字符），首尾不能是连字符。" }, 400);
      const body = z
        .object({ title: z.string().trim().min(1).max(60), summary: z.string().trim().max(200).default(""), instructions: z.string().trim().min(1).max(20000), create: z.boolean().optional() })
        .parse(await c.req.json());
      const owner = await options.store.skillOwner(slug);
      if (owner !== undefined && owner !== c.var.actor.id)
        return c.json({ error: `「${slug}」这个名字已经被${owner === null ? "共享技能" : "别人的技能"}占用，换个名字。` }, 409);
      if (body.create && owner !== undefined) return c.json({ error: `你已经有一个叫「${slug}」的技能了。` }, 409);
      await options.store.installSkill({ slug, title: body.title, summary: body.summary, instructions: body.instructions, ownerUserId: c.var.actor.id, by: c.var.actor.id });
      const saved = (await visible(c.var.actor.id)).find((skill) => skill.slug === slug);
      return c.json({ skill: saved ? view(c.var.actor.id)(saved) : null });
    });
    app.delete("/:slug", async (c) => {
      const slug = c.req.param("slug");
      const owner = await options.store.skillOwner(slug);
      if (owner === undefined) return c.json({ error: "找不到这个技能。" }, 404);
      if (owner !== c.var.actor.id) return c.json({ error: "共享技能只能由管理员在 设置 → 技能（管理）里删除。" }, 403);
      await options.store.uninstallSkill(slug, c.var.actor.id);
      return c.body(null, 204);
    });
    return app;
  }

  return { catalog, tools, visible, routes };
}
export type ChisaSkills = ReturnType<typeof createChisaSkills>;

/** 给机器人的技能用法（ChisaBot 自己的写法）。 */
export const SKILL_GUIDANCE = `技能是用户自己存下来的「某类事怎么做」的方法说明（工具 skill_list / skill_load / skill_save / skill_edit）。
- 开始做事前看一眼下面的目录：有对得上的就先 skill_load，按里面的方法和偏好做；技能和用户这次说的冲突时听用户的。
- 主动沉淀与自我进化：当你帮用户跑通了一套以后还用得上的复杂做法（多步调研/操作流程、特定网站的用法、格式规范、踩过的坑），或者用户反复让你做同一类事时，**做完正事后直接主动调用 skill_save 存成技能**，在回复末尾用半句话告诉用户（「已顺手把这套做法存为技能 /xxx，下次直接照做」），不要停下来问「要不要存成技能」。
- 做的过程中发现已有技能里有过时步骤或更好的做法，直接主动调用 skill_edit（小改）或 skill_save（整体改写）更新它，顺带告诉用户一声即可。
- 用户说「记住以后都这样做 X」这类关于做事方法的要求，直接主动存成技能；关于他本人的事实和偏好存进记忆。`;
