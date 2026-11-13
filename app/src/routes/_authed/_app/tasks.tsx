import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { TaskCenterView } from "@/components/task-center/task-center";
import { TaskCenterDialog } from "@/components/task-center/task-center-dialog";
import { botsTarget } from "@/lib/bots-location";

const views = [
  "inbox",
  "outbox",
  "active",
  "history",
  "sources",
  "context",
  "capabilities",
];
export const Route = createFileRoute("/_authed/_app/tasks")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { view: TaskCenterView; task?: string } => ({
    view:
      typeof search.view === "string" && views.includes(search.view)
        ? (search.view as TaskCenterView)
        : "inbox",
    ...(typeof search.task === "string" ? { task: search.task } : {}),
  }),
  component: TaskCenterRoute,
});
function TaskCenterRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  /*
   * 保留旧书签和 ?view/?task 深链接。应用内入口直接打开外壳弹层，不再导航到此路由。
   * 深链接内切分区不压历史，关闭时退回来源；直接进入、没有历史时回到机器人。
   */
  const close = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ ...botsTarget(), replace: true } as never);
  };
  return (
    <TaskCenterDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      view={search.view}
      taskId={search.task}
      onNavigate={(view, task) =>
        void navigate({
          replace: true,
          search: { view, ...(task ? { task } : {}) },
        })
      }
    />
  );
}
