import type { ImPlatform } from "../../../shared/im";
import { DingtalkAdapter, testDingtalk } from "./adapters/dingtalk";
import { DiscordAdapter, testDiscord } from "./adapters/discord";
import { FeishuAdapter, testFeishu } from "./adapters/feishu";
import { OneBotAdapter, testOneBot } from "./adapters/onebot";
import { QqOfficialAdapter, testQqOfficial } from "./adapters/qq-official";
import { SlackAdapter, testSlack } from "./adapters/slack";
import { TelegramAdapter, testTelegram } from "./adapters/telegram";
import { testWecomBot, WecomBotAdapter } from "./adapters/wecom-bot";
import { testWeixin, WeixinAdapter } from "./adapters/weixin";
import type { AdapterContext, ImAdapter, TestResult } from "./types";

/** 平台 → 适配器。新加平台：写一个 LoopAdapter 子类和一个 test 函数，在这里登记，shared/im.ts 加字段。 */
export function createAdapter(
  platform: ImPlatform,
  ctx: AdapterContext,
): ImAdapter {
  switch (platform) {
    case "feishu":
      return new FeishuAdapter(ctx);
    case "qq_official":
      return new QqOfficialAdapter(ctx);
    case "onebot":
      return new OneBotAdapter(ctx);
    case "wecom_bot":
      return new WecomBotAdapter(ctx);
    case "weixin":
      return new WeixinAdapter(ctx);
    case "dingtalk":
      return new DingtalkAdapter(ctx);
    case "telegram":
      return new TelegramAdapter(ctx);
    case "discord":
      return new DiscordAdapter(ctx);
    case "slack":
      return new SlackAdapter(ctx);
  }
}

/** 「测试连接」：只验证凭据 / 连通性，不抢正在运行的连接的消息。 */
export async function testAdapter(
  platform: ImPlatform,
  ctx: AdapterContext,
  running?: ImAdapter,
): Promise<TestResult> {
  switch (platform) {
    case "feishu":
      return testFeishu(ctx);
    case "qq_official":
      return testQqOfficial(ctx);
    case "onebot":
      return testOneBot(
        ctx,
        running instanceof OneBotAdapter ? running : undefined,
      );
    case "wecom_bot":
      return testWecomBot(
        ctx,
        running instanceof WecomBotAdapter ? running : undefined,
      );
    case "weixin":
      return testWeixin(
        ctx,
        running instanceof WeixinAdapter ? running : undefined,
      );
    case "dingtalk":
      return testDingtalk(ctx);
    case "telegram":
      return testTelegram(ctx);
    case "discord":
      return testDiscord(ctx);
    case "slack":
      return testSlack(ctx);
  }
}
