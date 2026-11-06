import { createFileRoute } from "@tanstack/react-router";
import {
  TaskCenter,
  type TaskCenterView,
} from "@/components/task-center/task-center";

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
  return (
    <TaskCenter
      view={search.view}
      taskId={search.task}
      onNavigate={(view, task) =>
        void navigate({ search: { view, ...(task ? { task } : {}) } })
      }
    />
  );
}
