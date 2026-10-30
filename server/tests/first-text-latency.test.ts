import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { lastValueFrom, of, toArray } from "rxjs";
import { WORK_STYLE_GUIDANCE } from "../../shared/bot-prompt";
import {
  markRequest,
  RunTimer,
  withRequestTiming,
} from "../src/agents/run-timing";
import { lastUserText, PersonalMemoryMiddleware } from "../src/memory/tools";
import type { PluginStore } from "../src/plugins/store";
import {
  createChisaSkills,
  looksLikeResearch,
  PRELOADED_RESEARCH_SKILL,
} from "../src/skills-chisa/tools";

/** 新话题首字延迟（PR perf/first-text）：服务器这一侧的几处改动。 */

describe("研究类问题才预置研究技能", () => {
  test("像要上网查的问题认得出来", () => {
    for (const text of [
      "最近有什么科技新闻？",
      "今天上海天气怎么样？",
      "iPhone 17 现在多少钱？",
      "推荐几家上海的咖啡店",
      "帮我找一款 500 元以内的降噪耳机",
      "对比 iPhone 17 和 Pixel 10",
      "帮我查一下这个航班",
      "latest news on the Fed",
    ])
      expect(looksLikeResearch(text)).toBe(true);
  });

  test("普通聊天、解释、写作、计算不算", () => {
    for (const text of [
      "你好",
      "用一句话解释什么是光合作用",
      "给我讲个冷笑话",
      "什么是复利？简单说",
      "把“明天开会”翻译成英文",
      "我今天好累",
      "帮我想三个周末放松的点子",
      "x² − 5x + 6 = 0 怎么解",
    ])
      expect(looksLikeResearch(text)).toBe(false);
  });

  type Row = {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
    ownerUserId: string | null;
  };
  const store = (rows: Row[]) =>
    ({
      async listSkills() {
        return rows.map((row) => ({ ...row, id: row.slug }));
      },
    }) as unknown as PluginStore;
  const research: Row = {
    slug: PRELOADED_RESEARCH_SKILL,
    title: "公开信息研究",
    summary: "上网查公开资料",
    instructions: "先用 web_search 找到几个靠谱的来源，再用 web_fetch 读原文。",
    ownerUserId: null,
  };
  const actorFor = async (id: string) => ({ id, isAdmin: false });

  test("研究类问题：方法直接附在技能目录后面，不用再 skill_load", async () => {
    const skills = createChisaSkills({ store: store([research]), actorFor });
    const catalog = await skills.catalog("alice", "最近有什么科技新闻？");
    expect(catalog).toContain("已预先加载技能「公开信息研究」");
    expect(catalog).toContain("先用 web_search 找到几个靠谱的来源");
  });

  test("普通对话的目录一个字不多", async () => {
    const skills = createChisaSkills({ store: store([research]), actorFor });
    const plain = await skills.catalog("alice");
    expect(await skills.catalog("alice", "给我讲个冷笑话")).toBe(plain);
    expect(plain).not.toContain("已预先加载");
  });

  test("研究技能对这个人不可见（没装）时不预置", async () => {
    const skills = createChisaSkills({ store: store([]), actorFor });
    expect(await skills.catalog("alice", "最近有什么科技新闻？")).not.toContain(
      "已预先加载",
    );
  });

  test("个人记忆加载拿到这一轮用户最后说的话", async () => {
    class Next extends AbstractAgent {
      run(input: RunAgentInput) {
        return of<BaseEvent>(
          {
            type: EventType.RUN_STARTED,
            runId: input.runId,
            threadId: input.threadId,
          },
          {
            type: EventType.RUN_FINISHED,
            runId: input.runId,
            threadId: input.threadId,
          },
        );
      }
    }
    let seen: string | undefined;
    await lastValueFrom(
      new PersonalMemoryMiddleware("bot", async (_bot, question) => {
        seen = question;
        return "";
      })
        .run(
          {
            runId: "run",
            threadId: "thread",
            messages: [
              { id: "u1", role: "user", content: "早先的问题" },
              { id: "a1", role: "assistant", content: "回答" },
              { id: "u2", role: "user", content: "最近有什么新闻" },
            ],
            context: [],
            tools: [],
            state: {},
            forwardedProps: {},
          },
          new Next({ agentId: "bot" }),
        )
        .pipe(toArray()),
    );
    expect(seen).toBe("最近有什么新闻");
  });

  test("带图片的消息只取文字部分", () => {
    expect(
      lastUserText({
        runId: "r",
        threadId: "t",
        messages: [
          {
            id: "u",
            role: "user",
            content: [
              { type: "text", text: "这款多少钱" },
              {
                type: "image",
                source: { type: "url", value: "https://x.test/a.png" },
              },
            ],
          },
        ],
        context: [],
        tools: [],
        state: {},
        forwardedProps: {},
      } as unknown as RunAgentInput),
    ).toBe("这款多少钱 ");
  });
});

describe("回复先一句再动手、按需搜索", () => {
  test("动手前一句 15 字以内的话，紧接着调用工具", () => {
    expect(WORK_STYLE_GUIDANCE).toContain("15 字以内");
    expect(WORK_STYLE_GUIDANCE).toContain("紧接着就调用工具");
  });

  test("能直接答的不搜，只有最新或具体事实才搜", () => {
    expect(WORK_STYLE_GUIDANCE).toContain("能直接答的就直接答，不调工具");
    expect(WORK_STYLE_GUIDANCE).toContain("只有答案取决于最新或具体事实");
  });
});

describe("分段计时", () => {
  test("进门、记忆、组装、拼提示词、远端接住、首字、首个工具各算各的", () => {
    let now = 0;
    const clock = () => now;
    const timing = withRequestTiming(() => {
      now = 40;
      markRequest("memory-start", 40);
      markRequest("memory-end", 90);
      now = 100;
      const timer = new RunTimer("run-1", clock);
      now = 130;
      timer.mark("assembled");
      now = 150;
      timer.mark("sent");
      now = 400;
      timer.observe({ type: EventType.RUN_STARTED } as BaseEvent);
      now = 900;
      timer.observe({ type: EventType.TOOL_CALL_START } as BaseEvent);
      now = 1_200;
      timer.observe({ type: EventType.TEXT_MESSAGE_CONTENT } as BaseEvent);
      timer.observe({ type: EventType.TOOL_CALL_START } as BaseEvent);
      now = 2_000;
      return timer.finish("finished");
    }, 0);
    expect(timing).toEqual({
      type: "run-timing",
      runId: "run-1",
      outcome: "finished",
      queueMs: 100,
      memoryMs: 50,
      assembleMs: 30,
      prepareMs: 20,
      remoteStartMs: 250,
      firstTokenMs: 1_050,
      firstToolMs: 750,
      firstTextMs: 1_200,
      totalMs: 1_900,
      toolCalls: 2,
    });
  });

  test("只出一次；不在请求里时排队一项留空", () => {
    let now = 5;
    const timer = new RunTimer("run-2", () => now);
    now = 25;
    const first = timer.finish("error");
    expect(first?.queueMs).toBeNull();
    expect(first?.firstTextMs).toBeNull();
    expect(first?.totalMs).toBe(20);
    expect(timer.finish("closed")).toBeUndefined();
  });

  test("记录里只有数字和计数，没有内容", () => {
    const timer = new RunTimer("run-3", () => 0);
    timer.observe({
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: "秘密内容",
    } as BaseEvent);
    expect(JSON.stringify(timer.finish("finished"))).not.toContain("秘密");
  });
});
