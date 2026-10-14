import {
  IconArrowsExchange,
  type IconBell,
  IconCalendarRepeat,
  IconChecks,
  IconClockPlay,
  IconHelpCircle,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type ActivityItem,
  type ActivityKind,
  botActivityQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

const ICONS: Record<ActivityKind, typeof IconBell> = {
  routine: IconCalendarRepeat,
  responsibility: IconTargetArrow,
  handoff: IconArrowsExchange,
  approval: IconChecks,
  question: IconHelpCircle,
  follow_up: IconClockPlay,
};

const KIND_LABEL: Record<ActivityKind, string> = {
  routine: "例行任务",
  responsibility: "职责",
  handoff: "委派任务",
  approval: "审批",
  question: "提问",
  follow_up: "跟进",
};

/** Where an item opens: its conversation when it has one, otherwise the screen that owns its kind. */
function linkFor(item: ActivityItem) {
  if (item.channelId)
    return (
      <Link to="/channel/$channelId" params={{ channelId: item.channelId }} />
    );
  switch (item.kind) {
    case "approval":
    case "question":
      return <Link to="/approvals" />;
    case "responsibility":
      return <Link to="/responsibilities" />;
    case "routine":
      return <Link to="/routines" />;
    default:
      return null;
  }
}

function ActivityRow({
  agentId,
  item,
}: {
  agentId: string;
  item: ActivityItem;
}) {
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  const Icon = ICONS[item.kind];
  const link = linkFor(item);
  const when = relativeTime(item.at);
  const control = item.stoppable ? (
    <Button
      disabled={stop.isPending}
      feedback="stop"
      mutation={stop}
      mutationWhen={stop.variables?.id === item.id}
      onClick={() => stop.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {"停止"}
    </Button>
  ) : item.cancellable ? (
    <Button
      disabled={cancel.isPending}
      feedback="cancel"
      mutation={cancel}
      mutationWhen={cancel.variables?.id === item.id}
      onClick={() => cancel.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {"取消"}
    </Button>
  ) : null;
  const content = (
    <>
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{item.title}</ItemTitle>
        <ItemDescription>
          {KIND_LABEL[item.kind]} · {item.needsYou ? "需要你" : item.status}
          {when ? `· ${when}` : ""}
          {item.detail ? `· ${item.detail}` : ""}
        </ItemDescription>
      </ItemContent>
    </>
  );
  /*
   * A row with a Stop or Cancel keeps the row itself unlinked, so the button is not nested inside a
   * link; the conversation is still one click away through the title's own link.
   */
  if (control)
    return (
      <Item size="sm">
        {content}
        <ItemActions>
          {link ? (
            <Button render={link} size="sm" variant="ghost">
              {"打开"}
            </Button>
          ) : null}
          {control}
        </ItemActions>
      </Item>
    );
  return link ? (
    <Item render={link} size="sm">
      {content}
    </Item>
  ) : (
    <Item size="sm">{content}</Item>
  );
}

function WorkBlock({
  agentId,
  empty,
  items,
  title,
}: {
  agentId: string;
  empty?: string;
  items: ActivityItem[];
  title: string;
}) {
  return (
    <section>
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-1">
          {items.map((item) => (
            <ActivityRow agentId={agentId} item={item} key={item.id} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * What this Bot is doing, as a short list.
 *
 * Routines stay in their own block even when empty — that empty sentence is the prompt to set one
 * in chat. Other planned or finished work only appears when there is some, so the pane does not
 * stack three blank cards.
 */
export function BotWorkLists({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (activity.isPending) return null;
  if (activity.error) {
    return (
      <p className="py-3 text-destructive text-sm" role="alert">
        {"无法加载此机器人的活动。"}
      </p>
    );
  }
  const routines = [
    ...activity.data.inProgress.filter((item) => item.kind === "routine"),
    ...activity.data.scheduled.filter((item) => item.kind === "routine"),
  ];
  const inProgress = activity.data.inProgress.filter(
    (item) => item.kind !== "routine",
  );
  const planned = activity.data.scheduled.filter(
    (item) => item.kind !== "routine",
  );
  const recent = activity.data.completed.slice(0, 3);
  return (
    <div className="grid gap-6">
      {inProgress.length > 0 ? (
        <WorkBlock agentId={agentId} items={inProgress} title={"进行中"} />
      ) : null}
      <WorkBlock
        agentId={agentId}
        empty={"请在聊天中设置例行任务。"}
        items={routines}
        title={"例行任务"}
      />
      {planned.length > 0 ? (
        <WorkBlock agentId={agentId} items={planned} title={"已计划"} />
      ) : null}
      {recent.length > 0 ? (
        <WorkBlock agentId={agentId} items={recent} title={"最近完成"} />
      ) : null}
    </div>
  );
}
