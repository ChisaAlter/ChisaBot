import type { ChannelUploadMirror } from "../channels/attachments";

/**
 * 频道聊天上传 → 机器人工作区 uploads/ + chisabot_chat_files（CB-046，DESIGN.md §68）。
 *
 * 只有「这个频道里正好一个机器人」时才存：那就是和这个机器人的对话（频道聊天现在是唯一的聊天入口）。
 * 多机器人的群组频道不知道该给谁，不存。机器人归不归这个人由 upload 自己查（ownsBot），别人的机器人不写。
 */
export function createChannelUploadMirror(deps: {
  botsInChannel: (channelId: string) => Promise<string[]>;
  upload: (owner: string, agentId: string, file: { name: string; bytes: Buffer }) => Promise<unknown>;
}): ChannelUploadMirror {
  return async ({ actorId, channelId, name, bytes }) => {
    const bots = await deps.botsInChannel(channelId);
    if (bots.length !== 1) return;
    const [botId] = bots;
    if (botId === undefined) return;
    await deps.upload(actorId, botId, { name, bytes });
  };
}
