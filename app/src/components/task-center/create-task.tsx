import { useMutation, useQuery } from "@tanstack/react-query";
import { type RefObject, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  taskCenterApi,
  taskCenterCapabilityOptions,
} from "@/lib/task-center-api";
import {
  TASK_CATEGORIES,
  TASK_LEVEL_LABELS,
  TASK_LEVELS,
  TASK_RISKS,
  type TaskCategory,
  type TaskInput,
  type TaskRisk,
} from "../../../../shared/task-center";
import { CATEGORY_LABELS, RISK_LABELS } from "./labels";

export function CreateTask({
  open,
  onOpenChange,
  onCreated,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <CreateTaskForm
          finalFocus={finalFocus}
          onCreated={onCreated}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}
function CreateTaskForm({
  onCreated,
  onClose,
  finalFocus,
}: {
  onCreated: (id: string) => void;
  onClose: () => void;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const agents = useQuery(agentListQueryOptions());
  const capabilities = useQuery(taskCenterCapabilityOptions());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<TaskCategory>("other");
  const [risk, setRisk] = useState<TaskRisk>("internal");
  const [level, setLevel] = useState(3);
  const [executor, setExecutor] = useState("bot");
  const [agentId, setAgentId] = useState("");
  const [start, setStart] = useState(true);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const executors =
    capabilities.data?.capabilities.filter(
      (entry) => entry.kind === "executor",
    ) ?? [];
  const save = useMutation({
    mutationFn: async () => {
      const input: TaskInput = {
        title,
        description,
        category,
        risk,
        level,
        executor,
        agentId: agentId || null,
      };
      const id = createdId ?? (await taskCenterApi.createTask(input)).task.id;
      setCreatedId(id);
      if (start) await taskCenterApi.controlTask(id, "start");
      return id;
    },
    onSuccess: onCreated,
  });
  return (
    <DialogContent
      className="tc-create-dialog"
      finalFocus={finalFocus}
      overlayClassName="bg-black/40 supports-backdrop-filter:backdrop-blur-sm"
    >
      <DialogHeader>
        <DialogTitle>新建任务</DialogTitle>
        <DialogDescription>
          写下目标和交付标准，任务中心会规划执行步骤。
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <form
          id="task-center-create"
          className="tc-form"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label className="tc-field">
            任务名称
            <Input
              autoFocus
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={Boolean(createdId)}
              placeholder="例如：整理本周项目的未完成事项"
            />
          </label>
          <label className="tc-field">
            目标与交付标准
            <Textarea
              required
              maxLength={16000}
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={Boolean(createdId)}
              placeholder="需要完成什么、可使用哪些资料，以及怎样算完成。"
            />
          </label>
          <div className="tc-form-grid">
            <label className="tc-field">
              分类
              <select
                className="tc-select"
                value={category}
                disabled={Boolean(createdId)}
                onChange={(event) =>
                  setCategory(event.target.value as TaskCategory)
                }
              >
                {TASK_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="tc-field">
              执行方式
              <select
                className="tc-select"
                value={executor}
                disabled={Boolean(createdId)}
                onChange={(event) => setExecutor(event.target.value)}
              >
                <option value="bot">ChisaBot 机器人</option>
                {executors
                  .filter((entry) => entry.id !== "bot")
                  .map((entry) => (
                    <option
                      key={entry.id}
                      value={entry.id}
                      disabled={!entry.available}
                    >
                      {entry.name}
                      {entry.available ? "" : "（待配置）"}
                    </option>
                  ))}
              </select>
            </label>
            <label className="tc-field">
              负责机器人
              <select
                className="tc-select"
                value={agentId}
                disabled={Boolean(createdId) || agents.isPending}
                onChange={(event) => setAgentId(event.target.value)}
              >
                <option value="">使用默认机器人</option>
                {agents.data
                  ?.filter((agent) => !agent.hidden)
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="tc-field">
              自主程度
              <select
                className="tc-select"
                value={level}
                disabled={Boolean(createdId)}
                onChange={(event) => setLevel(Number(event.target.value))}
              >
                {TASK_LEVELS.map((value) => (
                  <option key={value} value={value}>
                    L{value} · {TASK_LEVEL_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="tc-field">
            操作范围
            <select
              className="tc-select"
              value={risk}
              disabled={Boolean(createdId)}
              onChange={(event) => setRisk(event.target.value as TaskRisk)}
            >
              {TASK_RISKS.map((value) => (
                <option key={value} value={value}>
                  {RISK_LABELS[value]}
                </option>
              ))}
            </select>
            <span className="tc-muted">
              对外沟通、发布与敏感操作会进入 Outbox，等待你确认。
            </span>
          </label>
          <label className="tc-checkbox">
            <input
              type="checkbox"
              checked={start}
              onChange={(event) => setStart(event.target.checked)}
            />
            创建后开始规划与执行
          </label>
          {agents.error ? (
            <p className="tc-error" role="alert">
              {agents.error.message}
            </p>
          ) : null}
          {capabilities.error ? (
            <p className="tc-error" role="alert">
              执行能力加载失败：{capabilities.error.message}
            </p>
          ) : null}
          {save.error ? (
            <p className="tc-error" role="alert">
              {createdId ? "任务已保存，但未能开始。" : ""}
              {save.error.message}
            </p>
          ) : null}
        </form>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          type="submit"
          form="task-center-create"
          disabled={!title.trim() || !description.trim()}
          state={save.isPending ? "pending" : "idle"}
          feedback={{
            pending: "正在保存…",
            success: "已保存",
            error: "保存失败",
          }}
        >
          {createdId ? "重新开始" : start ? "创建并开始" : "放入 Inbox"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
