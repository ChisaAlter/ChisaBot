import { IconClock, IconCoins, IconListNumbers, IconPlayerPlayFilled, IconShieldCheck, IconTool } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  effectiveConstraints,
  TOOL_GROUP_INFO,
  type WorkflowDefinition,
  type WorkflowInput,
} from "../../../../shared/workflows";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useMainBot } from "@/lib/settings/message-list";
import { tokensText, workflowDetailQueryOptions, workflowKeys, workflowsApi } from "@/lib/workflows";

type Value = string | boolean;

function initialValue(input: WorkflowInput): Value {
  if (input.type === "boolean") return input.default === true;
  return input.default === undefined ? "" : String(input.default);
}

export function toolSummary(def: WorkflowDefinition): string {
  const rule = effectiveConstraints(def).tools;
  const label = (x: string) => (x in TOOL_GROUP_INFO ? TOOL_GROUP_INFO[x as keyof typeof TOOL_GROUP_INFO].label : x);
  if (rule.allow?.length) return `只允许：${rule.allow.map(label).join("、")}`;
  if (rule.deny?.length) return `禁止：${rule.deny.map(label).join("、")}`;
  return "不限制";
}

/** 「运行」：填参数、给每个角色挑机器人、看一眼约束，然后开始。 */
export function RunWorkflowDialog({
  workflowId,
  onOpenChange,
}: {
  workflowId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = workflowId !== null;
  const detail = useQuery({ ...workflowDetailQueryOptions(workflowId ?? ""), enabled: open });
  const agents = useQuery(agentListQueryOptions());
  const { mainBotId } = useMainBot();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const def = detail.data?.workflow.definition;
  const roster = useMemo(() => (agents.data ?? []).filter((bot) => !bot.hidden), [agents.data]);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  // 打开时按定义重置表单；机器人默认用角色绑定的，否则主机器人，否则第一个。
  useEffect(() => {
    if (!def) return;
    setValues(Object.fromEntries(def.inputs.map((input) => [input.key, initialValue(input)])));
    setErrors({});
    setFailure(null);
  }, [def]);
  useEffect(() => {
    if (!def || roster.length === 0) return;
    const fallback = roster.find((b) => b.id === mainBotId)?.id ?? roster[0]!.id;
    setBindings(
      Object.fromEntries(def.bots.map((role) => [role.key, roster.some((b) => b.id === role.botId) ? role.botId! : fallback])),
    );
  }, [def, roster, mainBotId]);

  const start = useAsyncAction(async () => {
    if (!def || !workflowId) return;
    const missing: Record<string, string> = {};
    for (const input of def.inputs) {
      const value = values[input.key];
      if (input.required && input.type !== "boolean" && (value === undefined || String(value).trim() === ""))
        missing[input.key] = "必填";
      if (input.type === "url" && value && !/^https?:\/\//i.test(String(value))) missing[input.key] = "需要 http(s) 网址";
      if (input.type === "number" && value !== "" && value !== undefined && !Number.isFinite(Number(value)))
        missing[input.key] = "需要数字";
    }
    setErrors(missing);
    if (Object.keys(missing).length > 0) throw new Error("还有必填项没填");
    setFailure(null);
    try {
      const { run } = await workflowsApi.run(workflowId, values, bindings);
      await queryClient.invalidateQueries({ queryKey: workflowKeys.library });
      setTimeout(() => {
        onOpenChange(false);
        void navigate({ to: "/workflows/runs/$runId", params: { runId: run.id } });
      }, 450);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "无法开始运行");
      throw error;
    }
  });

  const limits = def ? effectiveConstraints(def) : null;
  const approvals = def?.steps.filter((s) => s.approval).map((s) => s.name) ?? [];

  return (
    <Dialog onOpenChange={(next) => start.state !== "pending" && onOpenChange(next)} open={open}>
      <DialogContent className="wf-run-dialog sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span aria-hidden className="text-xl leading-none">
              {def?.icon ?? "⚙️"}
            </span>
            {def ? `运行「${def.name}」` : "运行工作流"}
          </DialogTitle>
          <DialogDescription>{def?.description || "填好参数后开始。每一步的进度、审批和结果都在运行页里。"}</DialogDescription>
        </DialogHeader>

        {!def ? (
          detail.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {"这个工作流无法加载。"}
            </p>
          ) : (
            <div className="grid gap-3">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-24" />
            </div>
          )
        ) : (
          <form
            className="wf-run-form"
            id="wf-run-form"
            onSubmit={(event) => {
              event.preventDefault();
              void start.run().catch(() => {});
            }}
          >
            {def.inputs.length > 0 ? (
              <fieldset className="wf-fieldset">
                <legend>{"参数"}</legend>
                {def.inputs.map((input) => (
                  <InputField
                    error={errors[input.key]}
                    input={input}
                    key={input.key}
                    onChange={(value) => setValues((prev) => ({ ...prev, [input.key]: value }))}
                    value={values[input.key] ?? initialValue(input)}
                  />
                ))}
              </fieldset>
            ) : null}

            <fieldset className="wf-fieldset">
              <legend>{"参与的机器人"}</legend>
              {roster.length === 0 ? (
                <p className="text-sm text-muted-foreground">{agents.isPending ? "正在加载机器人…" : "还没有可用的机器人。"}</p>
              ) : (
                def.bots.map((role) => (
                  <div className="wf-role-row" key={role.key}>
                    <div className="min-w-0 flex-1">
                      <div className="wf-role-name">{role.name}</div>
                      {role.description ? <div className="wf-role-desc">{role.description}</div> : null}
                    </div>
                    <Select
                      items={Object.fromEntries(roster.map((b) => [b.id, b.name]))}
                      onValueChange={(next) => setBindings((prev) => ({ ...prev, [role.key]: String(next) }))}
                      value={bindings[role.key] ?? ""}
                    >
                      <SelectTrigger aria-label={`由谁担任${role.name}`} className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roster.map((bot) => (
                          <SelectItem key={bot.id} value={bot.id}>
                            <span className="flex items-center gap-2">
                              <AbstractAvatar agentId={bot.id} name={bot.name} seed={bot.avatarSeed} size={18} />
                              {bot.name}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))
              )}
            </fieldset>

            {limits ? (
              // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
              <div className="wf-limits" aria-label="约束" role="group">
                <span className="wf-limit">
                  <IconListNumbers className="size-3.5" />
                  {`最多 ${limits.maxSteps} 步`}
                </span>
                <span className="wf-limit">
                  <IconCoins className="size-3.5" />
                  {`预算约 ${tokensText(limits.maxTokens)} token`}
                </span>
                <span className="wf-limit">
                  <IconClock className="size-3.5" />
                  {`限时 ${limits.timeLimitMinutes} 分钟`}
                </span>
                <span className="wf-limit">
                  <IconTool className="size-3.5" />
                  {toolSummary(def)}
                </span>
                {approvals.length ? (
                  <span className="wf-limit is-warn">
                    <IconShieldCheck className="size-3.5" />
                    {`「${approvals.join("」「")}」前需要你批准`}
                  </span>
                ) : null}
              </div>
            ) : null}
            {failure ? (
              <p className="text-sm text-destructive" role="alert">
                {failure}
              </p>
            ) : null}
          </form>
        )}

        <DialogFooter>
          <Button disabled={start.state === "pending"} onClick={() => onOpenChange(false)} type="button" variant="outline">
            {"取消"}
          </Button>
          <Button
            disabled={!def || roster.length === 0}
            feedback={{ pending: "启动中…", success: "已开始", error: "无法开始" }}
            form="wf-run-form"
            state={start.state}
            type="submit"
          >
            <IconPlayerPlayFilled />
            {"开始运行"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InputField({
  input,
  value,
  onChange,
  error,
}: {
  input: WorkflowInput;
  value: Value;
  onChange: (value: Value) => void;
  error?: string;
}) {
  const id = `wf-in-${input.key}`;
  const label = (
    <label className="wf-label" htmlFor={id}>
      {input.label}
      {input.required ? <span className="wf-req">{"*"}</span> : null}
    </label>
  );
  const help = error ? (
    <p className="wf-help is-error" role="alert">
      {error}
    </p>
  ) : input.help ? (
    <p className="wf-help">{input.help}</p>
  ) : null;
  if (input.type === "boolean")
    return (
      <div className="wf-field is-inline">
        {label}
        <Switch checked={value === true} id={id} onCheckedChange={(next) => onChange(Boolean(next))} />
      </div>
    );
  if (input.type === "select")
    return (
      <div className="wf-field">
        {label}
        <Select items={Object.fromEntries((input.options ?? []).map((o) => [o, o]))} onValueChange={(next) => onChange(String(next ?? ""))} value={String(value)}>
          <SelectTrigger aria-invalid={!!error || undefined} className="w-full" id={id}>
            <SelectValue placeholder="请选择" />
          </SelectTrigger>
          <SelectContent>
            {(input.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {help}
      </div>
    );
  if (input.type === "textarea")
    return (
      <div className="wf-field">
        {label}
        <Textarea
          aria-invalid={!!error || undefined}
          className="min-h-24"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={input.placeholder}
          value={String(value)}
        />
        {help}
      </div>
    );
  return (
    <div className="wf-field">
      {label}
      <Input
        aria-invalid={!!error || undefined}
        id={id}
        inputMode={input.type === "number" ? "decimal" : input.type === "url" ? "url" : undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder={input.placeholder}
        type={input.type === "url" ? "url" : "text"}
        value={String(value)}
      />
      {help}
    </div>
  );
}
