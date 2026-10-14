import { IconChevronLeft } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { BotDetailPane } from "@/components/bot-profile/detail-pane";
import { Button } from "@/components/ui/button";
import { latestChannelFor } from "@/lib/channels/latest";
import { channelListQueryOptions } from "@/lib/channels/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId")({
  component: BotProfilePage,
});

/**
 * A Bot that already has a conversation opens that conversation with the detail pane, which is
 * the profile. This page remains for a Bot that has no conversation yet, and it draws the same
 * pane rather than the old center settings stack.
 */
function BotProfilePage() {
  const { agentId } = Route.useParams();
  const channels = useInfiniteQuery(channelListQueryOptions());
  const latest = latestChannelFor(agentId, channels.data);
  if (channels.isPending && !channels.data) return null;
  if (latest) {
    return (
      <Navigate
        params={{ channelId: latest.id }}
        replace
        search={{ settings: true }}
        to="/channel/$channelId"
      />
    );
  }
  return (
    <div className="page-scroll min-h-0 flex-1 overflow-y-auto">
      {/* Same open width as DetailPanel, so this fallback lines up with the pane beside chat. */}
      <div className="mx-auto flex w-full max-w-[400px] flex-col py-2">
        <Button
          className="mx-2 self-start"
          nativeButton={false}
          render={<Link to="/bots" />}
          size="sm"
          variant="ghost"
        >
          <IconChevronLeft />
          {"机器人"}
        </Button>
        <BotDetailPane agentId={agentId} showChatLink />
      </div>
    </div>
  );
}
