import type { StoredAttachment } from "../channels/attachment-parts";
import type { LoadAttachment } from "../copilot";
import type { ChatFiles } from "./service";

/**
 * 一轮里消息上的附件怎么读出来交给模型（DESIGN.md §56、§59）。
 *
 * - `cf:<id>`：机器人私聊里上传的聊天文件，只按人取（私聊不是频道，没有成员表可查）。
 * - 其他：频道附件 `/api/attachments/<id>`，按人 + 这一轮的会话取（`loadChannel` 做成员和会话校验）。
 *   图片再按这个机器人的主模型过一遍：能看图就原样给原图，看不了才换成识图模型的描述（审查 M9-1）。
 *
 * 单独成一个函数是为了让测试走和线上同一条组合（index.ts 只是把数据库读法传进来）。
 */
export function turnAttachmentLoader(
  chatFiles: Pick<
    ChatFiles,
    "loadForTurn" | "channelAttachmentForModel" | "promptForModel"
  >,
  loadChannel: (
    actorId: string,
    threadId: string,
    id: string,
  ) => Promise<StoredAttachment | null>,
): (actorId: string) => LoadAttachment {
  return (actorId) => {
    const load: LoadAttachment = async (id, threadId, agentId, modelId) => {
      if (id.startsWith("cf:"))
        return chatFiles.loadForTurn(actorId, id.slice(3), {
          agentId,
          modelId,
        });
      const attachment = await loadChannel(actorId, threadId, id);
      if (!attachment || !agentId) return attachment;
      return chatFiles.channelAttachmentForModel(
        actorId,
        agentId,
        id,
        attachment,
        modelId,
      );
    };
    // 换到备用模型时按它重新决定图片怎么给（看不了图就换成描述）。
    load.promptForModel = (agentId, modelId, callOptions) =>
      chatFiles.promptForModel(actorId, agentId, modelId, callOptions);
    return load;
  };
}
