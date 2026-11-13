import { createContext, type ReactNode, useContext, useState } from "react";
import { lazyDialog } from "@/components/ui/lazy-dialog";
import type { TaskCenterView } from "./task-center";

const TaskCenterDialog = lazyDialog(() =>
  import("./task-center-dialog").then((m) => m.TaskCenterDialog),
);
type OpenTaskCenter = (view?: TaskCenterView, taskId?: string) => void;
const TaskCenterContext = createContext<OpenTaskCenter | null>(null);

/** 弹层属于登录外壳，不属于路由；从聊天、设置或管理打开都保留原页。 */
export function TaskCenterProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<{
    open: boolean;
    view: TaskCenterView;
    taskId?: string;
  }>({ open: false, view: "inbox" });
  const [openTaskCenter] = useState<OpenTaskCenter>(
    () =>
      (view: TaskCenterView = "inbox", taskId?: string) =>
        setSelection({ open: true, view, taskId }),
  );
  return (
    <TaskCenterContext value={openTaskCenter}>
      {children}
      <TaskCenterDialog
        {...selection}
        onOpenChange={(open) =>
          setSelection((current) => ({ ...current, open }))
        }
        onNavigate={(view, taskId) =>
          setSelection({ open: true, view, taskId })
        }
      />
    </TaskCenterContext>
  );
}

export function useOpenTaskCenter(): OpenTaskCenter {
  const open = useContext(TaskCenterContext);
  if (!open) throw new Error("任务中心入口必须位于 TaskCenterProvider 内");
  return open;
}
