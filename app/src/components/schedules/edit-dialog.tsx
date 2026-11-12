import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAsyncAction } from "@/components/ui/async-action";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useGuardedOpenChange } from "@/components/ui/unsaved-guard";
import type { AgentInstanceView } from "@/lib/local-agents";
import {
  type EditRepeat,
  editFormOf,
  editPatchOf,
  type ScheduleEditForm,
  type ScheduleEditPatch,
  scheduleZone,
  switchRepeat,
} from "@/lib/schedule-edit";
import { patchSchedule, scheduleKeys } from "@/lib/schedules";
import { formDirty } from "@/lib/unsaved";
import type { ScheduleView } from "../../../../shared/schedules";

const REPEAT_ZH: Record<EditRepeat, string> = {
  once: "一次",
  daily: "每天",
  weekdays: "工作日（周一到周五）",
  cron: "自定义（cron）",
};

const BOT_EXECUTOR_VALUE = "__bot__";

/** CB-106 §2：编辑已有定时任务的名字、时间和内容，走已有的 PATCH /api/schedules/:id。 */
export function ScheduleEditDialog({
  schedule: s,
  instances = [],
  onOpenChange,
  save: send = patchSchedule,
}: {
  schedule: ScheduleView | null;
  /** 可选绑定的子代理实例列表；未传时仅在当前已绑定实例时展示解绑项。 */
  instances?: AgentInstanceView[];
  onOpenChange: (open: boolean) => void;
  /** 测试里换掉；默认走 PATCH /api/schedules/:id。 */
  save?: typeof patchSchedule;
}) {
  return s ? (
    <ScheduleEditor
      instances={instances}
      key={s.id}
      schedule={s}
      onOpenChange={onOpenChange}
      save={send}
    />
  ) : null;
}

function ScheduleEditor({
  schedule: s,
  instances,
  onOpenChange,
  save: send,
}: {
  schedule: ScheduleView;
  instances: AgentInstanceView[];
  onOpenChange: (open: boolean) => void;
  save: typeof patchSchedule;
}) {
  const queryClient = useQueryClient();
  const [original] = useState(() => editFormOf(s));
  const [form, setForm] = useState(original);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = useAsyncAction(
    async (patch: ScheduleEditPatch) => {
      setError(null);
      try {
        await send(s.id, patch);
        await queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
        if (mounted.current) {
          toast.success(`已保存「${patch.title ?? s.title}」`);
          onOpenChange(false);
        }
      } catch (e) {
        if (mounted.current)
          setError(e instanceof Error ? e.message : "保存失败，请重试");
        throw e;
      }
    },
    { errorToast: false },
  );
  const saving = save.state === "pending";
  const guardedOpenChange = useGuardedOpenChange(
    formDirty(original, form),
    (open) => {
      if (mounted.current) onOpenChange(open);
    },
  );
  function submit() {
    if (saving) return;
    const result = editPatchOf(original, form);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    if (!Object.keys(result.patch).length) {
      onOpenChange(false);
      return;
    }
    void save.run(result.patch);
  }
  const set = (patch: Partial<ScheduleEditForm>) =>
    setForm({ ...form, ...patch });
  const selectableInstances = instances.filter(
    (inst) => inst.enabled || inst.id === form.agentInstanceId,
  );
  const selectedInstance = selectableInstances.find(
    (inst) => inst.id === form.agentInstanceId,
  );
  const showExecutorSelect =
    selectableInstances.length > 0 || Boolean(form.agentInstanceId);
  const currentExecutorLabel = !form.agentInstanceId
    ? "由对话机器人处理（默认）"
    : selectedInstance
      ? `${selectedInstance.name}（${selectedInstance.environmentName}）`
      : `子代理（${form.agentInstanceId}）`;
  return (
    <Dialog
      onOpenChange={(open, details) => {
        if (!saving) guardedOpenChange(open, details);
      }}
      open
    >
      <DialogContent className="im-dialog max-w-lg" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{`编辑「${s.title}」`}</DialogTitle>
          <DialogDescription>{`时间按${scheduleZone(s)}`}</DialogDescription>
        </DialogHeader>
        <DialogBody className="im-form mt-2">
          <label className="im-field" htmlFor="sch-edit-title">
            <span className="im-field-l">{"名字"}</span>
            <Input
              disabled={saving}
              data-testid="sch-edit-title"
              id="sch-edit-title"
              maxLength={60}
              onChange={(e) => set({ title: e.target.value })}
              value={form.title}
            />
          </label>
          <label className="im-field" htmlFor="sch-edit-repeat">
            <span className="im-field-l">{"重复"}</span>
            <Select
              disabled={saving}
              onValueChange={(value) =>
                setForm(
                  switchRepeat(
                    form,
                    value as EditRepeat,
                    new Date(),
                    s.timezone,
                  ),
                )
              }
              value={form.repeat}
            >
              <SelectTrigger
                aria-label={"重复方式"}
                className="w-full"
                data-testid="sch-edit-repeat"
                id="sch-edit-repeat"
              >
                <SelectValue>{REPEAT_ZH[form.repeat]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REPEAT_ZH) as EditRepeat[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {REPEAT_ZH[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {form.repeat === "cron" ? (
            <label className="im-field" htmlFor="sch-edit-cron">
              <span className="im-field-l">{"cron 表达式"}</span>
              <Input
                disabled={saving}
                className="font-mono"
                data-testid="sch-edit-cron"
                id="sch-edit-cron"
                onChange={(e) => set({ cron: e.target.value })}
                placeholder="0 */3 * * *"
                value={form.cron}
              />
              <span className="im-field-h">{`分 时 日 月 周，按${scheduleZone(s)}`}</span>
            </label>
          ) : (
            <label className="im-field" htmlFor="sch-edit-at">
              <span className="im-field-l">{`时间（${scheduleZone(s)}）`}</span>
              <Input
                disabled={saving}
                data-testid="sch-edit-at"
                id="sch-edit-at"
                onChange={(e) => set({ at: e.target.value })}
                type={form.repeat === "once" ? "datetime-local" : "time"}
                value={form.at}
              />
            </label>
          )}
          <label className="im-field" htmlFor="sch-edit-instruction">
            <span className="im-field-l">{"到点时做什么"}</span>
            <Textarea
              disabled={saving}
              data-testid="sch-edit-instruction"
              id="sch-edit-instruction"
              maxLength={4000}
              onChange={(e) => set({ instruction: e.target.value })}
              rows={4}
              value={form.instruction}
            />
          </label>
          {showExecutorSelect ? (
            <label className="im-field" htmlFor="sch-edit-agent-instance">
              <span className="im-field-l">{"执行智能体"}</span>
              <Select
                disabled={saving}
                onValueChange={(value) =>
                  set({
                    agentInstanceId:
                      !value || value === BOT_EXECUTOR_VALUE ? "" : value,
                  })
                }
                value={form.agentInstanceId || BOT_EXECUTOR_VALUE}
              >
                <SelectTrigger
                  aria-label={"执行智能体"}
                  className="w-full"
                  data-testid="sch-edit-agent-instance"
                  id="sch-edit-agent-instance"
                >
                  <SelectValue>{currentExecutorLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BOT_EXECUTOR_VALUE}>
                    {"由对话机器人处理（默认）"}
                  </SelectItem>
                  {selectableInstances.map((inst) => (
                    <SelectItem key={inst.id} value={inst.id}>
                      {`${inst.name}（${inst.environmentName}）`}
                    </SelectItem>
                  ))}
                  {form.agentInstanceId && !selectedInstance ? (
                    <SelectItem value={form.agentInstanceId}>
                      {`子代理（${form.agentInstanceId}）`}
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
              <span className="im-field-h">
                {"指定子代理实例后，到点将直接把指令派发给该智能体执行。"}
              </span>
            </label>
          ) : null}
          {error ? (
            <p className="img-probe is-bad" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={saving}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            {"取消"}
          </Button>
          <Button
            data-testid="sch-edit-save"
            state={save.state}
            feedback="save"
            onClick={submit}
          >
            {"保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
