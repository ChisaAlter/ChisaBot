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
import { toolAllowed, type ToolRule } from "../../../shared/workflows";
import type { AuditInitiator } from "../audit";
import type { GrantedTool } from "../plugins/tools";

type Policy = {
  rules: ToolRule[];
  /** 被拦下的调用，记进运行事件。 */
  onBlocked?: (name: string) => void;
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
  return toolAllowed(policy.rules, name, ref);
}

function refusal(name: string) {
  return `Refused. 工作流的约束不允许使用工具 ${name}。`;
}

/** 包住 loadToolsForActor：过滤 + 执行时复核。不是工作流发起的回合原样返回。 */
export function restrictToolsForWorkflow<A extends unknown[]>(
  initiator: AuditInitiator | undefined,
  load: (...args: A) => Promise<GrantedTool[]>,
): (...args: A) => Promise<GrantedTool[]> {
  if (!isWorkflowInitiator(initiator)) return load;
  return async (...args: A) => {
    const tools = await load(...args);
    return tools
      .filter((tool) => workflowToolAllowed(initiator, tool.name, tool.ref))
      .map((tool) => ({
        ...tool,
        execute: async (input: unknown, context) => {
          if (!workflowToolAllowed(initiator, tool.name, tool.ref)) {
            const policy = policyFor(initiator);
            if (policy && policy !== "deny-all") policy.onBlocked?.(tool.name);
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
