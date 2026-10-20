import {
  IconArrowDown,
  IconArrowUp,
  IconBraces,
  IconCopy,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  HANDOFF_LABEL,
  INPUT_TYPE_LABEL,
  OUTPUT_FORMAT_LABEL,
  TOOL_GROUP_INFO,
  type ToolRule,
  WORKFLOW_HANDOFFS,
  WORKFLOW_INPUT_TYPES,
  WORKFLOW_OUTPUT_FORMATS,
  WORKFLOW_TOOL_GROUPS,
  type WorkflowDefinition,
  type WorkflowInput,
  type WorkflowStep,
  type WorkflowToolGroup,
} from "../../../../shared/workflows";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardBody, CardHeader } from "@/components/ui/skyglass";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * 工作流的表单编辑器（DESIGN.md §26）。整份定义是一个对象，改哪里就换掉哪一块；保存前用和服务器
 * 同一套 zod + 结构检查（shared/workflows.ts）把问题列在页头下面。
 */

type Patch = (next: WorkflowDefinition) => void;

const ICONS = ["⚙️", "🔎", "🧑‍💻", "📰", "🧩", "✍️", "📊", "📦", "🗂️", "🧪", "🌐", "📝", "🤝", "🚀"];

function nextKey(prefix: string, taken: string[]) {
  for (let i = 1; i < 999; i++) if (!taken.includes(`${prefix}${i}`)) return `${prefix}${i}`;
  return `${prefix}${Date.now()}`;
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const copy = [...list];
  const [item] = copy.splice(index, 1);
  copy.splice(target, 0, item!);
  return copy;
}

export function SimpleSelect({
  value,
  onChange,
  options,
  disabled,
  className,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
  label: string;
}) {
  return (
    <Select
      disabled={disabled}
      items={Object.fromEntries(options.map((o) => [o.value, o.label]))}
      onValueChange={(next) => onChange(String(next ?? ""))}
      value={value}
    >
      <SelectTrigger aria-label={label} className={cn("w-full", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("wf-field", className)}>
      <span className="wf-label">{label}</span>
      {children}
      {hint ? <span className="wf-help">{hint}</span> : null}
    </label>
  );
}

function RowActions({
  index,
  count,
  onMove,
  onRemove,
  onDuplicate,
  disabled,
  what,
}: {
  index: number;
  count: number;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onDuplicate?: () => void;
  disabled?: boolean;
  what: string;
}) {
  if (disabled) return null;
  return (
    <span className="wf-row-actions">
      <Button aria-label={`上移${what}`} disabled={index === 0} onClick={() => onMove(-1)} size="icon-sm" type="button" variant="ghost">
        <IconArrowUp />
      </Button>
      <Button aria-label={`下移${what}`} disabled={index === count - 1} onClick={() => onMove(1)} size="icon-sm" type="button" variant="ghost">
        <IconArrowDown />
      </Button>
      {onDuplicate ? (
        <Button aria-label={`复制${what}`} onClick={onDuplicate} size="icon-sm" type="button" variant="ghost">
          <IconCopy />
        </Button>
      ) : null}
      <Button aria-label={`删除${what}`} className="wf-danger-ghost" disabled={count <= 1 && what !== "参数" && what !== "技能"} onClick={onRemove} size="icon-sm" type="button" variant="ghost">
        <IconTrash />
      </Button>
    </span>
  );
}

/** 三态：默认 / 允许 / 禁止。有任何「允许」时只放行允许的。 */
export function ToolRuleEditor({ value, onChange, disabled }: { value: ToolRule; onChange: (rule: ToolRule) => void; disabled?: boolean }) {
  const state = (group: WorkflowToolGroup) => (value.deny?.includes(group) ? "deny" : value.allow?.includes(group) ? "allow" : "default");
  const set = (group: WorkflowToolGroup, next: "default" | "allow" | "deny") => {
    const allow = (value.allow ?? []).filter((g) => g !== group);
    const deny = (value.deny ?? []).filter((g) => g !== group);
    if (next === "allow") allow.push(group);
    if (next === "deny") deny.push(group);
    onChange({ ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) });
  };
  const extra = [...(value.allow ?? []), ...(value.deny ?? [])].filter((x) => !(WORKFLOW_TOOL_GROUPS as readonly string[]).includes(x));
  return (
    <div className="wf-tools">
      {WORKFLOW_TOOL_GROUPS.map((group) => (
        <div className="wf-tool-row" key={group}>
          <div className="min-w-0 flex-1">
            <div className="wf-tool-name">{TOOL_GROUP_INFO[group].label}</div>
            <div className="wf-help">{TOOL_GROUP_INFO[group].description}</div>
          </div>
          <ToolRuleSeg current={state(group)} disabled={disabled} group={group} onPick={(next) => set(group, next)} />
        </div>
      ))}
      {extra.length ? <p className="wf-help">{`另外按名字限制的工具：${extra.join("、")}（在 WORKFLOW.md 里编辑）`}</p> : null}
      <p className="wf-help">{"有任何一项设为「允许」时，就只能用允许的那些；「禁止」永远优先。服务器在给机器人列工具和执行时都会检查。"}</p>
    </div>
  );
}

type RuleValue = "default" | "allow" | "deny";
const RULE_VALUES: RuleValue[] = ["default", "allow", "deny"];

/** 每一行一条三态规则；键盘约定走共用的 `useSegmentedKeys`（2026-10-20）。 */
function ToolRuleSeg({ group, current, onPick, disabled }: { group: WorkflowToolGroup; current: RuleValue; onPick: (next: RuleValue) => void; disabled?: boolean }) {
  const keys = useSegmentedKeys<RuleValue>({ value: current, values: RULE_VALUES, onChange: onPick, disabled });
  return (
    <div className="wf-seg" {...keys.groupProps} ref={keys.groupRef} role="radiogroup" aria-label={TOOL_GROUP_INFO[group].label}>
      {RULE_VALUES.map((option) => (
        <button
          aria-checked={current === option}
          className={cn("wf-seg-item", current === option && "is-on", option === "deny" && "is-deny", option === "allow" && "is-allow")}
          disabled={disabled}
          key={option}
          onClick={() => onPick(option)}
          role="radio"
          tabIndex={keys.itemTabIndex(option)}
          type="button"
        >
          {option === "default" ? "默认" : option === "allow" ? "允许" : "禁止"}
        </button>
      ))}
    </div>
  );
}

export function WorkflowEditor({ value, onChange, readOnly }: { value: WorkflowDefinition; onChange: Patch; readOnly?: boolean }) {
  const def = value;
  const set = (patch: Partial<WorkflowDefinition>) => onChange({ ...def, ...patch });
  // 图标选择也是 radiogroup：键盘约定走共用钩子（2026-10-20）。
  const iconKeys = useSegmentedKeys<string>({ value: def.icon, values: ICONS, onChange: (icon) => set({ icon }), disabled: readOnly });
  const agents = useQuery(agentListQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  const roster = (agents.data ?? []).filter((b) => !b.hidden);
  const librarySkills = plugins.data?.skills ?? [];
  const skillOptions = useMemo(
    () => [
      ...(def.skills ?? []).map((s) => ({ slug: s.slug, title: s.title, kind: "内置" })),
      ...librarySkills.filter((s) => !(def.skills ?? []).some((e) => e.slug === s.slug)).map((s) => ({ slug: s.slug, title: s.title, kind: "技能库" })),
    ],
    [def.skills, librarySkills],
  );

  const setStep = (index: number, patch: Partial<WorkflowStep>) => {
    const steps = def.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    set({ steps });
  };
  const setInput = (index: number, patch: Partial<WorkflowInput>) => set({ inputs: def.inputs.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  const constraints = def.constraints ?? {};
  const setConstraints = (patch: Partial<WorkflowDefinition["constraints"]>) => set({ constraints: { ...constraints, ...patch } });
  const num = (text: string) => (text.trim() === "" ? undefined : Math.round(Number(text)));

  return (
    <div className="wf-editor">
      <Card>
        <CardHeader description="名字、图标和一句话说明会出现在工作流库里。" title="基本信息" />
        <CardBody className="wf-grid-2">
          <Field className="wf-span-2" label="图标">
            <div className="wf-icons" {...iconKeys.groupProps} ref={iconKeys.groupRef} role="radiogroup" aria-label="图标">
              {ICONS.map((icon) => (
                <button
                  aria-checked={def.icon === icon}
                  className={cn("wf-icon-pick", def.icon === icon && "is-on")}
                  disabled={readOnly}
                  key={icon}
                  onClick={() => set({ icon })}
                  role="radio"
                  tabIndex={iconKeys.itemTabIndex(icon)}
                  type="button"
                >
                  {icon}
                </button>
              ))}
              <Input aria-label="自定义图标" className="h-9 w-16 text-center" disabled={readOnly} maxLength={8} onChange={(e) => set({ icon: e.target.value })} value={def.icon} />
            </div>
          </Field>
          <Field label="名称">
            <Input disabled={readOnly} maxLength={40} onChange={(e) => set({ name: e.target.value })} value={def.name} />
          </Field>
          <Field hint="小写字母、数字、连字符；导出的文件名就是它。" label="标识">
            <Input className="font-mono" disabled={readOnly} maxLength={48} onChange={(e) => set({ slug: e.target.value.toLowerCase() })} value={def.slug} />
          </Field>
          <Field className="wf-span-2" label="说明">
            <Textarea className="min-h-16" disabled={readOnly} maxLength={400} onChange={(e) => set({ description: e.target.value })} value={def.description} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          action={
            readOnly ? null : (
              <Button
                disabled={def.bots.length >= 8}
                onClick={() => {
                  const key = nextKey("role", def.bots.map((b) => b.key));
                  set({ bots: [...def.bots, { key, name: `角色 ${def.bots.length + 1}` }] });
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconPlus />
                {"添加角色"}
              </Button>
            )
          }
          description="每个角色运行时交给一个机器人；同一个机器人可以担任多个角色。可以给角色绑定默认机器人。"
          title={`机器人角色（${def.bots.length}）`}
        />
        <CardBody className="wf-list">
          {def.bots.map((role, index) => (
            <div className="wf-item" key={role.key}>
              <div className="wf-item-h">
                <span className="wf-item-no">{index + 1}</span>
                <Input aria-label="角色名" className="h-9 max-w-[200px]" disabled={readOnly} maxLength={24} onChange={(e) => set({ bots: def.bots.map((b, i) => (i === index ? { ...b, name: e.target.value } : b)) })} value={role.name} />
                <code className="wf-key">{role.key}</code>
                <span className="flex-1" />
                <RowActions
                  count={def.bots.length}
                  disabled={readOnly}
                  index={index}
                  onMove={(d) => set({ bots: move(def.bots, index, d) })}
                  onRemove={() => set({ bots: def.bots.filter((_, i) => i !== index) })}
                  what="角色"
                />
              </div>
              <div className="wf-grid-2">
                <Field label="职责">
                  <Input disabled={readOnly} maxLength={400} onChange={(e) => set({ bots: def.bots.map((b, i) => (i === index ? { ...b, description: e.target.value || undefined } : b)) })} placeholder="这个角色负责什么" value={role.description ?? ""} />
                </Field>
                <Field label="默认机器人">
                  <Select
                    disabled={readOnly}
                    items={{ "": "运行时选择", ...Object.fromEntries(roster.map((b) => [b.id, b.name])) }}
                    onValueChange={(next) => set({ bots: def.bots.map((b, i) => (i === index ? { ...b, botId: next ? String(next) : undefined } : b)) })}
                    value={role.botId ?? ""}
                  >
                    <SelectTrigger aria-label="默认机器人" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{"运行时选择"}</SelectItem>
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
                </Field>
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          action={
            readOnly ? null : (
              <Button
                disabled={def.inputs.length >= 16}
                onClick={() => {
                  const key = nextKey("input", def.inputs.map((i) => i.key));
                  set({ inputs: [...def.inputs, { key, label: `参数 ${def.inputs.length + 1}`, type: "text" }] });
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconPlus />
                {"添加参数"}
              </Button>
            )
          }
          description="运行时让人填的内容。步骤要求里用 {{inputs.标识}} 引用。"
          title={`输入参数（${def.inputs.length}）`}
        />
        <CardBody className="wf-list">
          {def.inputs.length === 0 ? <p className="wf-muted">{"没有参数：运行时直接开始。"}</p> : null}
          {def.inputs.map((input, index) => (
            <div className="wf-item" key={`${input.key}-${index}`}>
              <div className="wf-item-h">
                <span className="wf-item-no">{index + 1}</span>
                <Input aria-label="参数名" className="h-9 max-w-[200px]" disabled={readOnly} maxLength={40} onChange={(e) => setInput(index, { label: e.target.value })} value={input.label} />
                <Input aria-label="参数标识" className="h-9 max-w-[140px] font-mono text-xs" disabled={readOnly} maxLength={32} onChange={(e) => setInput(index, { key: e.target.value })} value={input.key} />
                <span className="flex-1" />
                <RowActions
                  count={def.inputs.length}
                  disabled={readOnly}
                  index={index}
                  onMove={(d) => set({ inputs: move(def.inputs, index, d) })}
                  onRemove={() => set({ inputs: def.inputs.filter((_, i) => i !== index) })}
                  what="参数"
                />
              </div>
              <div className="wf-grid-3">
                <Field label="类型">
                  <SimpleSelect
                    disabled={readOnly}
                    label="类型"
                    onChange={(type) => setInput(index, { type: type as WorkflowInput["type"] })}
                    options={WORKFLOW_INPUT_TYPES.map((t) => ({ value: t, label: INPUT_TYPE_LABEL[t] }))}
                    value={input.type}
                  />
                </Field>
                <Field label="默认值">
                  <Input disabled={readOnly} onChange={(e) => setInput(index, { default: e.target.value === "" ? undefined : input.type === "number" ? Number(e.target.value) : e.target.value })} value={input.default === undefined ? "" : String(input.default)} />
                </Field>
                <div className="wf-field is-inline wf-field-switch">
                  <span className="wf-label">{"必填"}</span>
                  <Switch checked={!!input.required} disabled={readOnly} onCheckedChange={(v) => setInput(index, { required: Boolean(v) || undefined })} />
                </div>
                {input.type === "select" ? (
                  <Field className="wf-span-3" hint="用逗号或顿号分隔" label="选项">
                    <Input disabled={readOnly} onChange={(e) => setInput(index, { options: e.target.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean) })} value={(input.options ?? []).join("，")} />
                  </Field>
                ) : (
                  <Field className="wf-span-3" label="提示文字">
                    <Input disabled={readOnly} maxLength={120} onChange={(e) => setInput(index, { placeholder: e.target.value || undefined })} value={input.placeholder ?? ""} />
                  </Field>
                )}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          action={
            readOnly ? null : (
              <Button
                disabled={def.steps.length >= 30}
                onClick={() => {
                  const id = nextKey("step", def.steps.map((s) => s.id));
                  set({ steps: [...def.steps, { id, name: `第 ${def.steps.length + 1} 步`, bot: def.bots[0]!.key, prompt: "" }] });
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconPlus />
                {"添加步骤"}
              </Button>
            )
          }
          description="按顺序执行。相邻且「并行组」相同的步骤同时进行。用 {{steps.标识}} 引用前面步骤的输出。"
          title={`步骤（${def.steps.length}）`}
        />
        <CardBody className="wf-list">
          {def.steps.map((step, index) => (
            <StepEditor
              count={def.steps.length}
              def={def}
              index={index}
              key={`${step.id}-${index}`}
              onChange={(patch) => setStep(index, patch)}
              onDuplicate={() => {
                const id = nextKey(`${step.id}_`, def.steps.map((s) => s.id));
                const steps = [...def.steps];
                steps.splice(index + 1, 0, { ...structuredClone(step), id, name: `${step.name}（副本）`.slice(0, 40) });
                set({ steps });
              }}
              onMove={(d) => set({ steps: move(def.steps, index, d) })}
              onRemove={() => set({ steps: def.steps.filter((_, i) => i !== index) })}
              readOnly={readOnly}
              skillOptions={skillOptions}
              step={step}
            />
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          action={
            readOnly ? null : (
              <Button
                disabled={(def.skills?.length ?? 0) >= 12}
                onClick={() => {
                  const slug = nextKey("skill-", (def.skills ?? []).map((s) => s.slug));
                  set({ skills: [...(def.skills ?? []), { slug, title: "新技能", instructions: "写下这个技能要求机器人怎么做。" }] });
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconPlus />
                {"添加内置技能"}
              </Button>
            )
          }
          description="跟着工作流一起导出、分享的技能，只在这个工作流里用。技能库里的技能在步骤里直接勾选。"
          title={`内置技能（${def.skills?.length ?? 0}）`}
        />
        <CardBody className="wf-list">
          {(def.skills ?? []).length === 0 ? <p className="wf-muted">{"没有内置技能。"}</p> : null}
          {(def.skills ?? []).map((skill, index, list) => (
            <div className="wf-item" key={`${skill.slug}-${index}`}>
              <div className="wf-item-h">
                <code className="wf-key">{"/"}</code>
                <Input aria-label="技能标识" className="h-9 max-w-[180px] font-mono text-xs" disabled={readOnly} maxLength={48} onChange={(e) => set({ skills: list.map((s, i) => (i === index ? { ...s, slug: e.target.value.toLowerCase() } : s)) })} value={skill.slug} />
                <Input aria-label="技能名称" className="h-9 max-w-[220px]" disabled={readOnly} maxLength={60} onChange={(e) => set({ skills: list.map((s, i) => (i === index ? { ...s, title: e.target.value } : s)) })} value={skill.title} />
                <span className="flex-1" />
                <RowActions count={list.length} disabled={readOnly} index={index} onMove={(d) => set({ skills: move(list, index, d) })} onRemove={() => set({ skills: list.filter((_, i) => i !== index) })} what="技能" />
              </div>
              <Textarea aria-label="技能内容" className="min-h-24 text-[13px]" disabled={readOnly} maxLength={8000} onChange={(e) => set({ skills: list.map((s, i) => (i === index ? { ...s, instructions: e.target.value } : s)) })} value={skill.instructions} />
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader description="服务器强制执行：超出就停下并记进运行记录和审计。" title="约束" />
        <CardBody className="wf-grid-2">
          <Field hint={`留空 = 步骤数（${def.steps.length}）`} label="最多步骤数">
            <Input disabled={readOnly} inputMode="numeric" onChange={(e) => setConstraints({ maxSteps: num(e.target.value) })} placeholder={String(def.steps.length)} value={constraints.maxSteps ?? ""} />
          </Field>
          <Field hint="估算：输入 + 输出；留空 = 60000" label="Token 预算">
            <Input disabled={readOnly} inputMode="numeric" onChange={(e) => setConstraints({ maxTokens: num(e.target.value) })} placeholder="60000" value={constraints.maxTokens ?? ""} />
          </Field>
          <Field hint="不含等待审批的时间；留空 = 20" label="时间上限（分钟）">
            <Input disabled={readOnly} inputMode="numeric" onChange={(e) => setConstraints({ timeLimitMinutes: num(e.target.value) })} placeholder="20" value={constraints.timeLimitMinutes ?? ""} />
          </Field>
          <Field hint="1–5；留空 = 5" label="单步时间上限（分钟）">
            <Input disabled={readOnly} inputMode="numeric" onChange={(e) => setConstraints({ stepTimeoutMinutes: num(e.target.value) })} placeholder="5" value={constraints.stepTimeoutMinutes ?? ""} />
          </Field>
          <Field label="最终输出格式">
            <SimpleSelect
              disabled={readOnly}
              label="最终输出格式"
              onChange={(format) => setConstraints({ output: { ...constraints.output, format: format as "markdown" } })}
              options={WORKFLOW_OUTPUT_FORMATS.map((f) => ({ value: f, label: OUTPUT_FORMAT_LABEL[f] }))}
              value={constraints.output?.format ?? "markdown"}
            />
          </Field>
          <Field hint="超出会截断；留空不限" label="最终输出最多字数">
            <Input disabled={readOnly} inputMode="numeric" onChange={(e) => setConstraints({ output: { ...constraints.output, maxChars: num(e.target.value) } })} value={constraints.output?.maxChars ?? ""} />
          </Field>
          <Field className="wf-span-2" label="对最终输出的要求">
            <Input disabled={readOnly} maxLength={1000} onChange={(e) => setConstraints({ output: { ...constraints.output, instructions: e.target.value || undefined } })} placeholder="例如：先给表格，再给结论" value={constraints.output?.instructions ?? ""} />
          </Field>
          <div className="wf-span-2">
            <div className="wf-label mb-2">{"工具（整个工作流）"}</div>
            <ToolRuleEditor disabled={readOnly} onChange={(tools) => setConstraints({ tools })} value={constraints.tools ?? {}} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function StepEditor({
  def,
  step,
  index,
  count,
  onChange,
  onMove,
  onRemove,
  onDuplicate,
  readOnly,
  skillOptions,
}: {
  def: WorkflowDefinition;
  step: WorkflowStep;
  index: number;
  count: number;
  onChange: (patch: Partial<WorkflowStep>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  readOnly?: boolean;
  skillOptions: { slug: string; title: string; kind: string }[];
}) {
  const [toolsOpen, setToolsOpen] = useState(Boolean(step.tools?.allow?.length || step.tools?.deny?.length));
  const refs = [
    ...def.inputs.map((i) => ({ label: i.label, token: `{{inputs.${i.key}}}` })),
    ...def.steps.slice(0, index).map((s) => ({ label: `「${s.name}」的输出`, token: `{{steps.${s.id}}}` })),
  ];
  const skills = step.skills ?? [];
  return (
    <div className={cn("wf-item wf-step-edit", step.group && "is-grouped")}>
      <div className="wf-item-h">
        <span className="wf-item-no">{index + 1}</span>
        <Input aria-label="步骤名" className="h-9 max-w-[220px]" disabled={readOnly} maxLength={40} onChange={(e) => onChange({ name: e.target.value })} value={step.name} />
        <Input aria-label="步骤标识" className="h-9 max-w-[130px] font-mono text-xs" disabled={readOnly} maxLength={32} onChange={(e) => onChange({ id: e.target.value })} value={step.id} />
        {step.group ? <span className="wf-chip">{`并行组 ${step.group}`}</span> : null}
        {step.approval ? <span className="wf-chip is-warn">{"需审批"}</span> : null}
        <span className="flex-1" />
        <RowActions count={count} disabled={readOnly} index={index} onDuplicate={onDuplicate} onMove={onMove} onRemove={onRemove} what="步骤" />
      </div>
      <div className="wf-grid-3">
        <Field label="由哪个角色做">
          <SimpleSelect disabled={readOnly} label="角色" onChange={(bot) => onChange({ bot })} options={def.bots.map((b) => ({ value: b.key, label: b.name }))} value={step.bot} />
        </Field>
        <Field label="带入前面的输出">
          <SimpleSelect
            disabled={readOnly}
            label="带入前面的输出"
            onChange={(handoff) => onChange({ handoff: handoff === "previous" ? undefined : (handoff as "all") })}
            options={WORKFLOW_HANDOFFS.map((h) => ({ value: h, label: HANDOFF_LABEL[h] }))}
            value={step.handoff ?? "previous"}
          />
        </Field>
        <Field hint="和相邻步骤填同一个名字就并行" label="并行组">
          <Input disabled={readOnly} maxLength={24} onChange={(e) => onChange({ group: e.target.value.trim() || undefined })} placeholder="不并行" value={step.group ?? ""} />
        </Field>
      </div>
      <Field label="要求">
        <Textarea className="min-h-28 text-[13px]" disabled={readOnly} maxLength={8000} onChange={(e) => onChange({ prompt: e.target.value })} placeholder="这一步要做什么、输出什么" value={step.prompt} />
      </Field>
      {!readOnly && refs.length ? (
        <div className="wf-refs" aria-label="插入引用">
          <IconBraces className="size-3.5 opacity-60" />
          {refs.map((ref) => (
            <button className="wf-ref" key={ref.token} onClick={() => onChange({ prompt: `${step.prompt}${step.prompt && !step.prompt.endsWith(" ") ? " " : ""}${ref.token}` })} title={ref.token} type="button">
              {ref.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="wf-field">
        <span className="wf-label">{"使用的技能"}</span>
        <div className="wf-skill-picks">
          {skillOptions.length === 0 ? <span className="wf-muted">{"还没有技能。可以在「内置技能」里加，或去「技能」页写。"}</span> : null}
          {skillOptions.map((skill) => {
            const on = skills.includes(skill.slug);
            return (
              <button
                aria-pressed={on}
                className={cn("wf-skill-pick", on && "is-on")}
                disabled={readOnly}
                key={skill.slug}
                onClick={() => onChange({ skills: on ? skills.filter((s) => s !== skill.slug) : [...skills, skill.slug] })}
                type="button"
              >
                <code>{`/${skill.slug}`}</code>
                {skill.title}
                <span className="wf-skill-kind">{skill.kind}</span>
              </button>
            );
          })}
          {skills.filter((s) => !skillOptions.some((o) => o.slug === s)).map((missing) => (
            <span className="wf-skill-pick is-missing" key={missing} title="找不到这个技能，运行时会跳过">
              <code>{`/${missing}`}</code>
              {"（找不到）"}
            </span>
          ))}
        </div>
      </div>
      <div className="wf-grid-3">
        <div className="wf-field is-inline wf-field-switch">
          <span className="wf-label">{"开始前需要人工批准"}</span>
          <Switch checked={!!step.approval} disabled={readOnly} onCheckedChange={(v) => onChange({ approval: Boolean(v) || undefined })} />
        </div>
        <div className="wf-field is-inline wf-field-switch">
          <span className="wf-label">{"可以保存面板"}</span>
          <Switch checked={!!step.panel} disabled={readOnly} onCheckedChange={(v) => onChange({ panel: Boolean(v) || undefined })} />
        </div>
        <Field label="这一步的输出格式">
          <SimpleSelect
            disabled={readOnly}
            label="这一步的输出格式"
            onChange={(output) => onChange({ output: output === "" ? undefined : (output as "markdown") })}
            options={[{ value: "", label: "默认" }, ...WORKFLOW_OUTPUT_FORMATS.map((f) => ({ value: f, label: OUTPUT_FORMAT_LABEL[f] }))]}
            value={step.output ?? ""}
          />
        </Field>
      </div>
      {step.approval ? (
        <Field label="审批说明">
          <Input disabled={readOnly} maxLength={400} onChange={(e) => onChange({ approvalNote: e.target.value || undefined })} placeholder="审批时给人看的话" value={step.approvalNote ?? ""} />
        </Field>
      ) : null}
      <button aria-expanded={toolsOpen} className="wf-more" onClick={() => setToolsOpen((v) => !v)} type="button">
        {toolsOpen ? "收起这一步的工具规则" : "这一步单独的工具规则…"}
      </button>
      {toolsOpen ? <ToolRuleEditor disabled={readOnly} onChange={(tools) => onChange({ tools: tools.allow || tools.deny ? tools : undefined })} value={step.tools ?? {}} /> : null}
    </div>
  );
}
