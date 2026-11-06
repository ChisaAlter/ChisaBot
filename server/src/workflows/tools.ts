/**
 * 在聊天里用工作流（docs/workflows.md §从聊天运行）：每个机器人都有 list_workflows 和 run_workflow。
 * 用户说「运行调研报告工作流，主题是…」或输入「/工作流 代码审查 …」，机器人就调 run_workflow，
 * 拿到运行页面的链接回给用户。长期任务 / 定时任务的回合也有这两个工具，所以「每天 8 点运行每日简报」
 * 就是一个普通的定时任务。工作流自己的步骤拿不到它们（不允许套娃）。
 */
import { z } from "zod";
import type { AuditInitiator } from "../audit";
import { currentConfirmTurn, currentToolAbort, TOOL_STOPPED_ZH } from "../confirmations/context";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { RUN_STATUS_LABEL, STEP_STATUS_LABEL, type WorkflowDefinition } from "../../../shared/workflows";
import { type WorkflowEngine, WorkflowRunError } from "./engine";
import { loadPresets } from "./presets";
import type { RunSource, StoredRun, WorkflowStore } from "./store";

type Candidate = { id: string; kind: "preset" | "mine"; definition: WorkflowDefinition };

async function candidates(store: WorkflowStore, ownerUserId: string): Promise<Candidate[]> {
  const mine = await store.list(ownerUserId);
  return [
    ...mine.map((w) => ({ id: w.id, kind: "mine" as const, definition: w.definition })),
    ...loadPresets().map((p) => ({ id: p.id, kind: "preset" as const, definition: p.definition })),
  ];
}

export function findWorkflow(list: Candidate[], query: string): Candidate | null {
  const q = query.trim().replace(/^\/+/, "").replace(/(工作流|workflow)$/i, "").trim().toLowerCase();
  if (!q) return null;
  return (
    list.find((c) => c.id.toLowerCase() === q) ??
    list.find((c) => c.definition.slug === q) ??
    list.find((c) => c.definition.name.toLowerCase() === q) ??
    list.find((c) => c.definition.name.toLowerCase().includes(q) || q.includes(c.definition.name.toLowerCase())) ??
    null
  );
}

function describe(c: Candidate) {
  return {
    id: c.id,
    name: c.definition.name,
    slug: c.definition.slug,
    kind: c.kind === "preset" ? "预设" : "我的",
    description: c.definition.description,
    inputs: c.definition.inputs.map((i) => ({
      key: i.key,
      label: i.label,
      type: i.type,
      required: !!i.required,
      ...(i.options ? { options: i.options } : {}),
      ...(i.default !== undefined ? { default: i.default } : {}),
    })),
    roles: c.definition.bots.map((b) => b.name),
    approvalSteps: c.definition.steps.filter((s) => s.approval).map((s) => s.name),
  };
}

function summarizeRun(run: StoredRun) {
  return {
    runId: run.id,
    workflowId: run.workflowId,
    workflow: run.workflowName,
    status: run.status,
    statusLabel: RUN_STATUS_LABEL[run.status],
    url: `/workflows/runs/${run.id}`,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    error: run.error,
    outputPreview: run.output ? run.output.slice(0, 1200) : null,
    steps: run.state.steps.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.roleName,
      bot: s.botName,
      status: s.status,
      statusLabel: STEP_STATUS_LABEL[s.status],
      ...(s.attempt && s.attempt > 1 ? { attempt: s.attempt } : {}),
      ...(s.reworkCount ? { reworkCount: s.reworkCount } : {}),
      ...(s.rejectTo ? { rejectTo: s.rejectTo } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(s.approval ? { approval: s.approval } : {}),
      ...(s.gateResult ? { gateResult: s.gateResult } : {}),
      ...(s.output ? { outputPreview: s.output.slice(0, 500) } : {}),
    })),
  };
}

/** 是否是用户本人直接发起的对话（网页或 IM），只有这种来源才允许审批/打回/重试/取消工作流。 */
export function isInteractivePersonInitiator(initiator: AuditInitiator | undefined): boolean {
  if (!initiator || initiator.kind === "person") return true;
  if (initiator.kind === "routine" && (initiator.id.startsWith("im:") || initiator.id.startsWith("confirm:"))) return true;
  return false;
}

export function workflowChatTools(options: {
  store: WorkflowStore;
  /** 取执行器（懒取：装工具时执行器可能还没建好，真正调用时才需要）。 */
  engine: () => WorkflowEngine;
  ownerUserId: string;
  actorName?: string;
  botId: string;
  initiator?: AuditInitiator;
}): GrantedTool[] {
  if (options.initiator?.kind === "workflow") return [];
  // 面板后台刷新回合不提供工作流工具
  if (options.initiator?.kind === "routine" && options.initiator.id.startsWith("lp_")) return [];

  const source: RunSource =
    options.initiator?.kind === "routine" || options.initiator?.kind === "responsibility" ? "routine" : "chat";
  const listParams = z.object({});
  const runParams = z.object({
    workflow: z.string().min(1).max(120).describe("工作流的名称、标识（slug）或 id，例如「调研报告」或 research-report"),
    inputs: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("输入参数，键是 list_workflows 返回的 inputs[].key"),
  });
  const getRunParams = z.object({
    runId: z.string().max(80).optional().describe("工作流运行 id（如 wfr_...）；不传则查看最近一次运行"),
    workflow: z.string().max(120).optional().describe("按工作流名称或 slug 筛选最近的运行"),
  });
  const controlRunParams = z.object({
    runId: z.string().min(1).max(80).describe("要操作的工作流运行 id（如 wfr_...）"),
    action: z
      .enum(["approve", "reject", "retry", "cancel"])
      .describe("approve=批准等待审批的步骤；reject=拒绝审批（可打回上游步骤重做或停止）；retry=重试失败/停止的运行；cancel=停止正在运行的流程"),
    stepId: z.string().max(60).optional().describe("目标步骤 id（approve/reject 时不传则自动定位当前等待审批的步骤；retry 时不传则从失败步骤开始）"),
    rejectTo: z
      .string()
      .max(60)
      .optional()
      .describe("当 action=reject 时，指定打回给前面哪一步重做（传步骤 id）；传 __cancel__ 则直接终止整条运行"),
    retryMode: z
      .enum(["targeted_fix", "full_redo"])
      .optional()
      .describe("重试或打回重做时的上下文模式：targeted_fix=保留该步骤原有对话记忆继续修（默认）；full_redo=清空上下文重新开始"),
    comment: z.string().max(1000).optional().describe("审批意见、打回修改要求或重试补充说明"),
  });

  const tools: GrantedTool[] = [
    {
      name: "list_workflows",
      ref: "workflows/list_workflows",
      description:
        "列出用户可以运行的工作流（预设 + 用户自己的），以及每个工作流需要的输入参数。用户提到「工作流」、输入以 /工作流 开头、或想一次让几个机器人按步骤协作完成任务时先调用它。",
      parameters: listParams,
      async execute() {
        const list = await candidates(options.store, options.ownerUserId);
        return JSON.stringify({ workflows: list.map(describe) });
      },
    },
    {
      name: "run_workflow",
      ref: "workflows/run_workflow",
      description:
        "运行一个工作流（异步后台任务，受理即返回，不要在同一轮对话里循环轮询等待跑完）。必填输入缺了会返回缺哪些，向用户问清再调用；不要编造输入。开始后返回运行页面链接（如 /workflows/runs/xxx），把链接用 Markdown 发给用户。",
      parameters: runParams,
      async execute(args) {
        if (currentConfirmTurn()?.stopped() || currentToolAbort()?.aborted) {
          return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
        }
        const parsed = runParams.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} 参数格式不对：需要 workflow（名称）和可选的 inputs。`;
        const list = await candidates(options.store, options.ownerUserId);
        const found = findWorkflow(list, parsed.data.workflow);
        if (!found)
          return JSON.stringify({
            ok: false,
            error: `没有叫「${parsed.data.workflow}」的工作流。`,
            available: list.map((c) => c.definition.name),
          });
        const missing = found.definition.inputs
          .filter((i) => i.required && i.default === undefined)
          .filter((i) => {
            const v = parsed.data.inputs?.[i.key];
            return v === undefined || (typeof v === "string" && !v.trim());
          })
          .map((i) => ({ key: i.key, label: i.label, ...(i.options ? { options: i.options } : {}) }));
        if (missing.length > 0)
          return JSON.stringify({ ok: false, needInputs: missing, message: "这些输入是必填的，请先问用户。" });
        try {
          const run = await options.engine().start({
            ownerUserId: options.ownerUserId,
            workflowId: found.id,
            definition: found.definition,
            inputs: parsed.data.inputs ?? {},
            fallbackBotId: options.botId,
            source,
          });
          return JSON.stringify({
            ok: true,
            accepted: true,
            runId: run.id,
            url: `/workflows/runs/${run.id}`,
            workflow: found.definition.name,
            steps: found.definition.steps.map((s) => s.name),
            approvalSteps: found.definition.steps.filter((s) => s.approval).map((s) => s.name),
            message: "已开始在后台运行。请立即把运行链接告诉用户并结束本轮回复，不要在同一轮里轮询等待完成。",
          });
        } catch (error) {
          if (error instanceof WorkflowRunError) return JSON.stringify({ ok: false, error: error.message });
          throw error;
        }
      },
    },
    {
      name: "get_workflow_run",
      ref: "workflows/get_workflow_run",
      description:
        "查询工作流运行的当前进度、各步骤状态、等待审批的节点、报错信息或产出摘要。不传 runId 时默认返回最近一次运行的状态。",
      parameters: getRunParams,
      async execute(args) {
        const parsed = getRunParams.safeParse(args ?? {});
        if (!parsed.success) return `${REFUSAL_MARKER} 参数格式不对。`;
        if (parsed.data.runId?.trim()) {
          const run = await options.store.getOwnRun(options.ownerUserId, parsed.data.runId.trim());
          if (!run) return JSON.stringify({ ok: false, error: `找不到运行 ${parsed.data.runId}。` });
          return JSON.stringify({ ok: true, run: summarizeRun(run) });
        }
        const recent = await options.store.listRuns(options.ownerUserId, 10);
        const q = parsed.data.workflow?.trim().toLowerCase();
        const filtered = q
          ? recent.filter((r) => r.workflowName.toLowerCase().includes(q) || r.workflowId.toLowerCase().includes(q) || r.definition.slug.includes(q))
          : recent;
        const firstRun = filtered[0];
        if (!firstRun) {
          return JSON.stringify({ ok: true, runs: [], message: "还没有工作流运行记录。" });
        }
        return JSON.stringify({
          ok: true,
          latest: summarizeRun(firstRun),
          recent: filtered.slice(0, 5).map((r) => ({
            runId: r.id,
            workflow: r.workflowName,
            status: r.status,
            statusLabel: RUN_STATUS_LABEL[r.status],
            url: `/workflows/runs/${r.id}`,
            createdAt: r.createdAt.toISOString(),
          })),
        });
      },
    },
  ];

  // 控制写工具仅在用户交互式会话中提供，后台定时/自动任务不可调用（服务端强绑定发起人身份）
  if (isInteractivePersonInitiator(options.initiator)) {
    tools.push({
      name: "control_workflow_run",
      ref: "workflows/control_workflow_run",
      description:
        "在聊天里替用户操控工作流运行：批准（approve）、拒绝并打回前面步骤重做（reject + rejectTo）、从失败步骤带记忆重试（retry）、或停止运行（cancel）。操作是异步受理的：调用成功后立即向用户汇报状态并结束本轮，不要在同一轮循环轮询。",
      parameters: controlRunParams,
      async execute(args) {
        if (currentConfirmTurn()?.stopped() || currentToolAbort()?.aborted) {
          return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
        }
        if (!isInteractivePersonInitiator(options.initiator)) {
          return `${REFUSAL_MARKER} 后台自动回合不允许操控工作流运行状态。`;
        }
        const parsed = controlRunParams.safeParse(args);
        if (!parsed.success) {
          return `${REFUSAL_MARKER} control_workflow_run 参数格式不对：${parsed.error.issues[0]?.message ?? ""}`;
        }
        const { runId, action, stepId, rejectTo, retryMode, comment } = parsed.data;
        const by = options.actorName?.trim() || "用户";
        try {
          const run = await options.store.getOwnRun(options.ownerUserId, runId);
          if (!run) return JSON.stringify({ ok: false, error: `找不到运行 ${runId}。` });

          if (action === "cancel") {
            await options.engine().cancel(options.ownerUserId, runId);
            return JSON.stringify({
              ok: true,
              accepted: true,
              action,
              runId,
              url: `/workflows/runs/${runId}`,
              message: "已停止该工作流运行。",
            });
          }

          if (action === "retry") {
            const retried = await options.engine().retry({
              ownerUserId: options.ownerUserId,
              runId,
              ...(stepId ? { stepId } : {}),
              ...(retryMode ? { mode: retryMode } : {}),
              ...(comment ? { comment } : {}),
              by,
            });
            return JSON.stringify({
              ok: true,
              accepted: true,
              action,
              runId,
              status: retried.status,
              url: `/workflows/runs/${runId}`,
              message: "已受理重试并在后台继续执行，请勿在同一回合内轮询等待。",
            });
          }

          // approve / reject
          const waitingStep = stepId
            ? run.state.steps.find((s) => s.id === stepId)
            : run.state.steps.find((s) => s.status === "waiting_approval");
          if (!waitingStep) {
            return JSON.stringify({ ok: false, error: "当前没有处于「等待审批」状态的步骤。" });
          }
          await options.engine().approve({
            ownerUserId: options.ownerUserId,
            runId,
            stepId: waitingStep.id,
            decision: action === "approve" ? "approve" : "reject",
            ...(comment ? { comment } : {}),
            ...(rejectTo ? { rejectTo } : {}),
            ...(retryMode ? { retryMode } : {}),
            by,
          });
          const updated = await options.store.getOwnRun(options.ownerUserId, runId);
          return JSON.stringify({
            ok: true,
            accepted: true,
            action,
            runId,
            stepId: waitingStep.id,
            status: updated?.status ?? "queued",
            url: `/workflows/runs/${runId}`,
            message:
              action === "approve"
                ? `已批准「${waitingStep.name}」，流程继续在后台运行。`
                : updated?.status === "cancelled"
                  ? `已拒绝「${waitingStep.name}」，运行已停止。`
                  : `已拒绝「${waitingStep.name}」并打回前面步骤重做，后台已重新排队执行。`,
          });
        } catch (error) {
          if (error instanceof WorkflowRunError) return JSON.stringify({ ok: false, error: error.message });
          throw error;
        }
      },
    });
  }

  return tools;
}

/**
 * 契约自省工具（借鉴 LoopForge workbench_tool_schema）：
 * 让机器人在调用复杂工具前可以按名称精确读取参数的 JSON Schema 契约，避免盲猜字段名或枚举值。
 */
export function createInspectToolSchemaTool(getTools: () => readonly GrantedTool[]): GrantedTool {
  const params = z.object({
    names: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(10)
      .optional()
      .describe("要查看参数契约的工具名称列表（不确定全名时可填关键字）"),
    toolName: z.string().trim().min(1).max(100).optional().describe("单个要查询的工具名称"),
    name: z.string().trim().min(1).max(100).optional().describe("单个要查询的工具名称"),
  });
  return {
    name: "inspect_tool_schema",
    ref: "system/inspect_tool_schema",
    description:
      "在调用参数复杂的工具（如工作流操控、面板编辑、定时任务、外部连接器）之前，查询该工具的完整参数 JSON Schema 契约与字段说明。不要盲目猜测参数字段或枚举值。",
    parameters: params,
    async execute(args) {
      const parsed = params.safeParse(args);
      const queries = parsed.success
        ? [...(parsed.data.names ?? []), ...(parsed.data.toolName ? [parsed.data.toolName] : []), ...(parsed.data.name ? [parsed.data.name] : [])]
        : [];
      if (queries.length === 0) return `${REFUSAL_MARKER} 请提供要查询的工具名数组 names 或 toolName。`;
      const all = getTools();
      const schemas: Record<string, { ref?: string; description: string; schema: unknown }> = {};
      const notFound: string[] = [];
      for (const query of queries) {
        const q = query.toLowerCase();
        const matches = all.filter(
          (t) =>
            t.name !== "inspect_tool_schema" &&
            (t.name.toLowerCase() === q || t.ref?.toLowerCase() === q || t.name.toLowerCase().includes(q)),
        );
        if (matches.length === 0) {
          notFound.push(query);
          continue;
        }
        for (const match of matches.slice(0, 5)) {
          let schema: unknown = null;
          try {
            schema = z.toJSONSchema(match.parameters);
          } catch {
            schema = { note: "Schema unavailable" };
          }
          schemas[match.name] = {
            ...(match.ref ? { ref: match.ref } : {}),
            description: match.description,
            schema,
          };
        }
      }
      return JSON.stringify({
        schemas,
        ...(notFound.length ? { notFound, availableTools: all.map((t) => t.name) } : {}),
      });
    },
  };
}
