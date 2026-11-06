/**
 * 工作流运行里的工具约束（docs/workflows.md §约束）。
 *
 * 每个步骤的回合用自己的发起者 `{ kind: "workflow", id: "<runId>/<stepId>" }` 跑。这里按发起者 id
 * 登记这一步生效的规则；`index.ts` 在三个地方用它：
 *  - 给机器人装工具时（loadToolsForActor）：被禁止的工具根本不出现在模型面前；
 *  - 无头工具（云端浏览器 computer_*、组件）：同样先过滤；
 *  - 执行时再判一次：万一模型硬调了一个名字，执行包装直接拒绝并记审计。
 * 照抄 proactive/restriction.ts 的做法（主动任务的只读限制），不是一套新机制。
 */
import { z } from "zod";
import { toolAllowed, type ToolRule, type WorkflowGateResult } from "../../../shared/workflows";
import type { AuditInitiator } from "../audit";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";

export const SUBMIT_GATE_RESULT_TOOL = "submit_gate_result";

type Policy = {
  rules: ToolRule[];
  /** 被拦下的调用，记进运行事件。 */
  onBlocked?: (name: string) => void;
  /** 开启结构化验证门（Gate）的步骤，在此接收机器人的裁决。 */
  onGateSubmit?: (result: WorkflowGateResult) => void;
};

const policies = new Map<string, Policy>();

export function registerStepPolicy(initiatorId: string, policy: Policy) {
  policies.set(initiatorId, policy);
}

export function clearStepPolicy(initiatorId: string) {
  policies.delete(initiatorId);
}

export function isWorkflowInitiator(initiator: AuditInitiator | undefined | null): initiator is { kind: "workflow"; id: string } {
  return !!initiator && initiator.kind === "workflow";
}

/** 当前发起者的规则。工作流发起者却没登记（进程重启后的残留回合）= 一律拒绝。 */
export function policyFor(initiator: AuditInitiator | undefined | null): Policy | null | "deny-all" {
  if (!isWorkflowInitiator(initiator)) return null;
  return policies.get(initiator.id) ?? "deny-all";
}

export function workflowToolAllowed(initiator: AuditInitiator | undefined | null, name: string, ref?: string): boolean {
  const policy = policyFor(initiator);
  if (policy === null) return true;
  if (policy === "deny-all") return false;
  if (name === SUBMIT_GATE_RESULT_TOOL && policy.onGateSubmit) return true;
  return toolAllowed(policy.rules, name, ref);
}

function refusal(name: string) {
  return `${REFUSAL_MARKER} 工作流的约束不允许使用工具 ${name}。`;
}

/**
 * 远程 Agent 工具回调门守卫：在 index.ts 远程回调入口第一时间拦截违反工作流步骤约束的调用。
 */
export function guardWorkflowCallback(
  initiator: AuditInitiator | undefined | null,
  name: string,
  ref?: string,
): { text: string; isError: true } | null {
  if (!isWorkflowInitiator(initiator)) return null;
  if (!workflowToolAllowed(initiator, name, ref)) {
    const policy = policyFor(initiator);
    if (policy && policy !== "deny-all") policy.onBlocked?.(name);
    return { text: refusal(name), isError: true };
  }
  return null;
}

const gateFindingSchema = z
  .object({
    severity: z.enum(["high", "medium", "low"]).describe("问题严重程度"),
    title: z.string().trim().min(1).max(200).describe("问题标题"),
    evidence: z.string().trim().max(1000).optional().describe("具体证据、位置或复现说明"),
    detail: z.string().trim().max(1000).optional().describe("问题详情补充"),
  })
  .strict();

const gateParamsSchema = z
  .object({
    decision: z
      .enum(["pass", "rework", "fail", "human"])
      .describe("pass=通过并进入下一步；rework=打回重做/继续修正；fail=直接判定失败；human=需要人类介入拍板"),
    reason: z.string().trim().min(1).max(2000).optional().describe("裁决结论与核心原因说明"),
    summary: z.string().trim().min(1).max(2000).optional().describe("裁决结论摘要（等同于 reason）"),
    actionRequired: z.string().trim().max(1000).optional().describe("当 decision 为 rework 或 human 时，明确需要修改或人工决定的事项"),
    findings: z.array(gateFindingSchema).max(20).optional().describe("发现的具体问题列表"),
  })
  .strict();

function createGateTool(initiator: { kind: "workflow"; id: string }): GrantedTool {
  return {
    name: SUBMIT_GATE_RESULT_TOOL,
    ref: `workflows/${SUBMIT_GATE_RESULT_TOOL}`,
    description:
      "提交当前工作流步骤的结构化验证门（Gate）裁决结果。当本步骤要求进行审查、验收或质量门禁判定时，必须调用此工具给出明确结论（pass / rework / fail / human）。",
    parameters: gateParamsSchema,
    initiator,
    async execute(args: unknown) {
      const policy = policyFor(initiator);
      if (!policy || policy === "deny-all" || !policy.onGateSubmit) {
        return refusal(SUBMIT_GATE_RESULT_TOOL);
      }
      const parsed = gateParamsSchema.safeParse(args);
      if (!parsed.success) {
        return `${REFUSAL_MARKER} submit_gate_result 参数格式不对：${parsed.error.issues[0]?.message ?? "请检查必填项"}`;
      }
      const reasonText = parsed.data.reason ?? parsed.data.summary ?? "已完成验收裁决";
      const findings = parsed.data.findings?.map((f) => ({
        severity: f.severity,
        title: f.title,
        ...(f.evidence || f.detail ? { evidence: f.evidence ?? f.detail } : {}),
      }));
      const result: WorkflowGateResult = {
        decision: parsed.data.decision,
        reason: reasonText,
        summary: reasonText,
        ...(parsed.data.actionRequired ? { actionRequired: parsed.data.actionRequired } : {}),
        ...(findings?.length ? { findings } : {}),
        submittedAt: new Date().toISOString(),
      };
      policy.onGateSubmit(result);
      return JSON.stringify({ ok: true, decision: result.decision, message: "已记录验证门裁决结果。" });
    },
  };
}

/** 包住 loadToolsForActor：过滤 + 执行时复核 + 按需注入步骤专属验证门工具。不是工作流发起的回合原样返回。 */
export function restrictToolsForWorkflow<A extends unknown[]>(
  initiator: AuditInitiator | undefined,
  load: (...args: A) => Promise<GrantedTool[]>,
): (...args: A) => Promise<GrantedTool[]> {
  if (!isWorkflowInitiator(initiator)) return load;
  return async (...args: A) => {
    const tools = await load(...args);
    const policy = policyFor(initiator);
    const gateTools = policy && policy !== "deny-all" && policy.onGateSubmit ? [createGateTool(initiator)] : [];
    return [...tools, ...gateTools]
      .filter((tool) => workflowToolAllowed(initiator, tool.name, tool.ref))
      .map((tool) => ({
        ...tool,
        execute: async (input: unknown, context) => {
          if (!workflowToolAllowed(initiator, tool.name, tool.ref)) {
            const current = policyFor(initiator);
            if (current && current !== "deny-all") current.onBlocked?.(tool.name);
            return refusal(tool.name);
          }
          return tool.execute(input, context);
        },
      }));
  };
}

/** 包住找别的机器人（message_bot）和面板工具：同样按名字过滤。 */
export function restrictNamedToolsForWorkflow<A extends unknown[], R extends { name: string; ref?: string }>(
  initiator: AuditInitiator | undefined,
  load: (...args: A) => Promise<readonly R[]>,
): (...args: A) => Promise<R[]> {
  if (!isWorkflowInitiator(initiator)) return async (...args: A) => [...(await load(...args))];
  return async (...args: A) => (await load(...args)).filter((tool) => workflowToolAllowed(initiator, tool.name, tool.ref));
}

/** 无头工具（computer_* 等）用的过滤，形状是 { definition: { name } }。 */
export function filterHeadlessForWorkflow<T extends { definition: { name: string } }>(
  initiator: AuditInitiator | undefined,
  tools: T[],
): T[] {
  if (!isWorkflowInitiator(initiator)) return tools;
  return tools.filter((tool) => workflowToolAllowed(initiator, tool.definition.name));
}
