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
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
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
import {
  activityStatusIsFailure,
  activityStatusZh,
} from "../../../../shared/activity-labels";
import { cn } from "@/lib/utils";

const ICONS: Record<ActivityKind, typeof IconBell> = {
  schedule: IconCalendarRepeat,
  responsibility: IconTargetArrow,
  handoff: IconArrowsExchange,
  approval: IconChecks,
  question: IconHelpCircle,
  follow_up: IconClockPlay,
};

const KIND_LABEL: Record<ActivityKind, string> = {
  schedule: "定时任务",
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
    case "schedule":
      return <Link to="/settings/schedules" />;
    default:
      return null;
  }
}

export function ActivityRow({
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
        <ItemDescription
          className={cn(
            activityStatusIsFailure(item.status) && "text-destructive",
          )}
        >
          {KIND_LABEL[item.kind]} ·{" "}
          {item.needsYou
            ? activityStatusIsFailure(item.status)
              ? activityStatusZh(item.status)
              : "需要你"
            : activityStatusZh(item.status)}
          {when ? ` · ${when}` : ""}
          {item.detail ? ` · ${item.detail}` : ""}
        </ItemDescription>
      </ItemContent>
    </>
  );
  /*
   * A row with a Stop or Cancel keeps the row itself unlinked, so the button is not nested inside a
   * link; the conversation is still one click away through the title's own link.
   */
  const failed = activityStatusIsFailure(item.status);
  if (control)
    return (
      <Item className={cn(failed && "is-failed")} data-status={item.status} size="sm">
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
    <Item className={cn(failed && "is-failed")} data-status={item.status} render={link} size="sm">
      {content}
    </Item>
  ) : (
    <Item className={cn(failed && "is-failed")} data-status={item.status} size="sm">{content}</Item>
  );
}

function ActivitySection({
  agentId,
  empty,
  items,
  title,
}: {
  agentId: string;
  empty: string;
  items: ActivityItem[];
  title: string;
}) {
  return (
    <PageSection title={title}>
      {items.length === 0 ? (
        <PageEmpty>{empty}</PageEmpty>
      ) : (
        <PageRows>
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 ? <Separator /> : null}
              <ActivityRow agentId={agentId} item={item} />
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** In progress, Scheduled and Completed, read from the ledgers the work already lives in. */
export function BotActivitySections({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (activity.isPending) return null;
  if (activity.error)
    return (
      <PageSection title={"活动"}>
        <p className="mt-4 text-destructive text-sm" role="alert">
          {"无法加载此机器人的活动。"}
        </p>
      </PageSection>
    );
  return (
    <>
      <ActivitySection
        agentId={agentId}
        empty="当前没有正在运行或等待你处理的任务。"
        items={activity.data.inProgress}
        title={"进行中"}
      />
      <ActivitySection
        agentId={agentId}
        empty="暂无计划任务。"
        items={activity.data.scheduled}
        title={"已计划"}
      />
      <ActivitySection
        agentId={agentId}
        empty="暂时还没有已完成的任务。"
        items={activity.data.completed}
        title={"已完成"}
      />
    </>
  );
}
