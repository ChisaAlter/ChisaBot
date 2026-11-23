import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { DURATION_MS, usePresenceMount } from "@/lib/motion";
import { TaskCenter, type TaskCenterView } from "./task-center";

export function TaskCenterDialog({
  open,
  onOpenChange,
  view,
  taskId,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: TaskCenterView;
  taskId?: string;
  onNavigate: (view: TaskCenterView, taskId?: string) => void;
}) {
  const { mounted, onExited } = usePresenceMount(open, DURATION_MS.exit);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onExited();
      }}
    >
      <DialogContent className="tc-dialog h-[85svh] w-[calc(100%-2.5rem)] max-w-6xl gap-0 overflow-hidden p-0 max-sm:h-[100svh] max-sm:max-h-[100svh] max-sm:w-full max-sm:rounded-none">
        <DialogTitle className="sr-only" render={<span />}>
          任务中心
        </DialogTitle>
        <DialogDescription className="sr-only">
          把目标交给机器人，在这里掌握进展与关键决策。
        </DialogDescription>
        {mounted ? (
          <TaskCenter
            view={view}
            taskId={taskId}
            onNavigate={onNavigate}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
