import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import { stashDraftFiles } from "@/lib/chat/ui-memory";
import { markDraftChannel, moveTextDraft } from "./draft-channel";
import {
  createChannelMutationOptions,
  createDraftChannelMutationOptions,
} from "./mutations";
import { channelKeys } from "./queries";

/**
 * Start a channel from a just-submitted first message, then navigate there.
 *
 * Ordering matters: create, seed the channel cache, stash the first message, then navigate. That
 * keeps the first message visible while the channel thread joins.
 */
export function useStartChannel() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const createDraft = useMutation(createDraftChannelMutationOptions());

  /**
   * `watch`: the empty chat already had the Bot's 计算机 open in the right column (DESIGN.md §79);
   * carry it into the new conversation so the screen does not close under the first message.
   */
  const start = async (agentId: string, text: string, options: { watch?: boolean } = {}) => {
    const channel = await createChannel.mutateAsync([agentId]);
    queryClient.setQueryData(channelKeys.detail(channel.id), channel);
    stashFirstMessage(channel.id, text);
    await navigate({
      params: { channelId: channel.id },
      replace: true,
      ...(options.watch ? { search: { watch: true } } : {}),
      to: "/channel/$channelId",
    });
  };

  /**
   * 新话题页上加了附件（A1）：先建一段草稿对话，把 `fromKey` 下写了一半的字和这些文件交给它（它的输入框以
   * 频道 id 为草稿键），再替换地址跳过去。那边的输入框挂上时放回字、重新上传文件。没发就离开时删掉
   * （`draft-channel.ts`）。
   */
  const startDraft = async (
    agentId: string,
    files: readonly File[],
    options: { fromKey: string; watch?: boolean },
  ) => {
    const channel = await createDraft.mutateAsync([agentId]);
    queryClient.setQueryData(channelKeys.detail(channel.id), channel);
    markDraftChannel(channel.id, options.fromKey);
    moveTextDraft(options.fromKey, channel.id);
    stashDraftFiles(channel.id, files);
    await navigate({
      params: { channelId: channel.id },
      replace: true,
      ...(options.watch ? { search: { watch: true } } : {}),
      to: "/channel/$channelId",
    });
  };

  return {
    pending: createChannel.isPending,
    start,
    startDraft,
    /** Same as `start`. The upstream intent-routing audit row (`POST /api/route`) is gone (slimming P4b). */
    startChosen: start,
  };
}
