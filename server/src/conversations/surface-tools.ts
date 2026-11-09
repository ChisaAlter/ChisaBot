import { z } from "zod";
import { proposedSkillSchema } from "../../../shared/skill-authoring";
import type { AgentActor } from "../agents/profile-types";
import type { AuditInitiator } from "../audit";
import type { BrowserBookmarks } from "../browser-bookmarks/service";
import type { SandboxedStore } from "../components/sandboxed";
import type { ComponentStore } from "../components/store";
import type { ComputerGateway } from "../computer/gateway";
import type { HeadlessTool } from "../computer/headless-tools";
import type { PluginStore } from "../plugins/store";
import type { createConversationInteractions } from "./interactions";

/** Surface tools are governed at execution time and are available without an open browser. */
export async function createConversationSurfaceTools(options: {
  actor: AgentActor;
  botId: string;
  plugins: PluginStore;
  components: ComponentStore;
  sandboxed: SandboxedStore;
  interactions: ReturnType<typeof createConversationInteractions>;
  computer?: {
    gateway: ComputerGateway;
    bookmarks: BrowserBookmarks;
    initiator: AuditInitiator;
  };
}): Promise<HeadlessTool[]> {
  const { actor, botId, plugins, components, sandboxed, interactions } =
    options;
  const tools: HeadlessTool[] = [];
  const skillActor = { id: actor.id, isAdmin: actor.role === "admin" };
  const authoring = async () =>
    (await plugins.listForAgent(botId)).skills.some(
      (skill) => skill.slug === "skill-creator",
    );
  const add = (
    name: string,
    description: string,
    schema: z.ZodType,
    execute: HeadlessTool["execute"],
  ) =>
    tools.push({
      definition: {
        name,
        description,
        parameters: z.toJSONSchema(schema, { io: "input" }),
      },
      execute: async (args, context) => execute(schema.parse(args), context),
    });
  if (options.computer) {
    const { gateway, bookmarks, initiator } = options.computer;
    const actionActor = { id: actor.id, userId: actor.id, initiator };
    const tabs = z.object({
      action: z.enum(["list", "new", "switch", "close"]),
      id: z.string().optional(),
      url: z.string().optional(),
    });
    add(
      "computer_tabs",
      "列出、新建、切换或关闭浏览器标签。新建带网址时照常经过导航权限和审计。",
      tabs,
      async (value, context) => {
        const input = tabs.parse(value);
        context.signal.throwIfAborted();
        if (input.action === "list")
          return { ok: true, ...(await gateway.tabs?.(botId)) };
        if (!gateway.tabAction)
          throw new Error("This computer does not support browser tabs.");
        return {
          ok: true,
          ...(await gateway.tabAction(botId, actionActor, {
            ...input,
            action: input.action === "switch" ? "activate" : input.action,
            toolCallId: context.toolCallId,
          })),
        };
      },
    );
    const bookmark = z.object({
      action: z.enum(["list", "open", "add", "remove"]),
      id: z.string().optional(),
      url: z.string().optional(),
      title: z.string().optional(),
      newTab: z.boolean().optional(),
    });
    add(
      "computer_bookmarks",
      "用户自己的浏览器收藏夹。list 列出，open 打开指定 id；只有用户明确要求收藏或取消收藏时才调用 add/remove。",
      bookmark,
      async (value, context) => {
        const input = bookmark.parse(value);
        context.signal.throwIfAborted();
        const all = await bookmarks.list(actor.id);
        if (input.action === "list") return { ok: true, bookmarks: all };
        if (input.action === "open") {
          const found = all.find((value) => value.id === input.id);
          if (!found) return { ok: false, reason: "No bookmark has that id." };
          if (input.newTab && gateway.tabAction)
            return {
              ok: true,
              ...(await gateway.tabAction(botId, actionActor, {
                action: "new",
                url: found.url,
                toolCallId: context.toolCallId,
              })),
            };
          return {
            ok: true,
            ...(await gateway.navigate(
              botId,
              actionActor,
              found.url,
              context.toolCallId,
            )),
          };
        }
        if (input.action === "remove") {
          if (!input.id) throw new Error("Bookmark id is required.");
          await bookmarks.remove(actor.id, input.id);
          await bookmarks.syncTo(actor, botId).catch(() => {});
          return { ok: true, removed: input.id };
        }
        const url =
          input.url ??
          (await gateway.tabs?.(botId))?.tabs.find((tab) => tab.active)?.url;
        const saved = await bookmarks.add(actor.id, {
          url,
          title: input.title,
        });
        await bookmarks.syncTo(actor, botId).catch(() => {});
        return { ok: true, bookmark: saved };
      },
    );
  }
  if (await authoring()) {
    const check =
      (execute: HeadlessTool["execute"]): HeadlessTool["execute"] =>
      async (args, context) => {
        if (!(await authoring()))
          throw new Error("This Bot no longer holds skill-creator.");
        return execute(args, context);
      };
    add(
      "list_skills",
      "列出当前用户可见的技能、所有者和工具声明。",
      z.object({}),
      check(async () => {
        const skills = await plugins.listSkills(skillActor);
        return skills.map((skill) => ({
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary,
          ownerUserId: skill.ownerUserId,
          tools: skill.tools,
        }));
      }),
    );
    add(
      "read_skill",
      "读取现有技能的完整内容；修改前先读取。",
      z.object({ slug: z.string() }),
      check(async (value) => {
        const { slug } = value as { slug: string };
        return (
          (await plugins.listSkills(skillActor)).find(
            (skill) => skill.slug === slug.replace(/^\//, ""),
          ) ?? { error: "No visible skill has this slug." }
        );
      }),
    );
    add(
      "list_skill_tools",
      "列出技能可声明的连接器工具引用。声明工具不授予执行权限。",
      z.object({}),
      check(async () =>
        (await plugins.listServers()).map((server) => ({
          id: server.id,
          title: server.title,
          tools: server.tools.map((tool) => ({
            ref: tool.ref,
            name: tool.name,
            description: tool.description,
            effect: tool.effect,
          })),
        })),
      ),
    );
    add(
      "save_skill",
      "将完整技能放到确认卡片。用户按保存才写入；等待卡片答复后继续。",
      proposedSkillSchema,
      check(async (_args, context) =>
        interactions.ask(actor.id, context.signal),
      ),
    );
  }
  const held = new Set(
    (await components.listForAgent(botId)).map((component) => component.name),
  );
  for (const component of await sandboxed.published()) {
    if (!held.has(component.name)) continue;
    add(
      component.name,
      `展示已发布组件 ${component.name}。`,
      z.fromJSONSchema(component.argumentSchema),
      async () => {
        const decision = await components.decide(component.name, botId);
        if (
          !decision.allowed ||
          !(await sandboxed.published()).some(
            (value) => value.name === component.name,
          )
        )
          return {
            refused: true,
            reason: !decision.allowed
              ? decision.reason
              : "Component is no longer published.",
          };
        return "It is now on screen for the person.";
      },
    );
  }
  return tools;
}
