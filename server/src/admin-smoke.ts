/**
 * 管理员自检：一次真实的模型往返，不碰任何对话（docs/admin-smoke.md）。
 *
 * 以前的发布自检是在某个机器人的对话里真的发一句「ok」，消息就永远留在用户的对话里了。这里换成
 * `POST /api/admin/smoke`：
 *
 * - 走和聊天完全相同的模型解析（`resolveConnection` / 给了 `agentId` 时 `resolveConnectionForAgent`，
 *   即机器人自己的模型覆盖）和相同的 AI SDK 客户端（`connectionLanguageModel`），所以它通过就说明
 *   「这台服务器此刻能用聊天用的那套配置跟模型说上话」；
 * - 问模型一道随机的两位数加法（每次数字不同，排除缓存）。模型有非空回复就算通过——这证明「配置 →
 *   模型服务 → 回复」整条往返是通的；答对了另外记 `answered: true`。以前是让模型「原样回一个口令」，
 *   但有的模型（实测 mimo，2026-10-13）会把它当成提示注入拒绝，自检时好时坏，和服务器本身无关；
 * - **不写数据库**：不建频道、不写消息、不写记忆、不触发投递，响应 `persisted: false`。只在服务器
 *   日志打一行结果，题目和回复不进日志。
 *
 * 仅管理员。公网网关照常先认证会话；本机 127.0.0.1:3001 的开发用户也是管理员，发布脚本用它。
 */
import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "./auth/guards";
import { requireAdmin } from "./auth/guards";
import { type FallbackUse, fallbackNotice, withFallbackListener } from "./agents/model-fallback";
import {
  fallbackConnectionModel,
  type RuntimeModelConnection,
} from "./copilot";
import { withModelConnectionScope } from "./model-connection-context";

export const SMOKE_TIMEOUT_MS = 45_000;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export type SmokeResult = {
  ok: boolean;
  /** 永远是 false：自检不落库。写在响应里，调用方（发布脚本）可以断言它。 */
  persisted: false;
  provider: "openai" | "anthropic";
  model: string;
  agentId: string | null;
  latencyMs: number;
  /** 模型有没有答对那道加法题。 */
  answered: boolean;
  /** 旧字段，和 `answered` 相同（旧版页面 / 脚本读它）。 */
  echoed: boolean;
  /** 模型回复的前 200 个字（排查用）。 */
  reply: string;
  message: string;
  /**
   * 主模型额度用完 / 不可用、自检改用了备用模型（DESIGN.md §61）：和聊天同一套回退，所以自检
   * 通过就说明「用户此刻发消息能得到回答」。`model` 仍是配置的主模型。
   */
  fallback?: FallbackUse;
  /**
   * CB-100：配置了 Hermes（CHISABOT_HERMES_URL）时真的连一次它。`unreachable` 会让整个自检失败
   * （以前自检只直连模型、绕过 Hermes，所以 Hermes 连不上时发布照样通过）。没配置时是 `skipped`。
   * 只看「连得上」（任意 HTTP 状态都算 ok），就绪与否仍由 /api/admin/health 报告。
   */
  hermes: "ok" | "unreachable" | "skipped";
  hermesError?: string;
};

/** 连一次 Hermes 的结果；`reachable` 为 true 表示 TCP/HTTP 握手成功（任意 HTTP 状态）。 */
export type HermesReachability = { reachable: boolean; error?: string };

type Generate = (
  connection: RuntimeModelConnection,
  prompt: string,
  signal: AbortSignal,
) => Promise<string>;

/** 默认的生成：和聊天同一个 AI SDK 客户端（含额度用完时的备用模型），非流式、短回复。 */
export const generateWithConnection: Generate = async (
  connection,
  prompt,
  signal,
) => {
  const model = fallbackConnectionModel(connection.model, connection.apiKey);
  const result = await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    // 会先「思考」的模型要留够余量，不然思考用完了正文是空的。
    maxOutputTokens: 1024,
    abortSignal: signal,
  });
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
};

export type SmokeQuestion = { a: number; b: number; answer: number };

/** 一道每次都不同的两位数加法。 */
export function smokeQuestion(): SmokeQuestion {
  const bytes = randomBytes(2);
  const a = 10 + (bytes[0]! % 90);
  const b = 10 + (bytes[1]! % 90);
  return { a, b, answer: a + b };
}

export function smokePrompt(question: Pick<SmokeQuestion, "a" | "b">): string {
  return `${question.a} + ${question.b} 等于多少？只回复结果数字。`;
}

/** 回复里有没有正确答案（全角数字也认；整数完整匹配，「185」不算答对 85）。 */
export function smokeAnswered(reply: string, answer: number): boolean {
  const normalized = reply.replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  const numbers: string[] = normalized.match(/\d+/gu) ?? [];
  return numbers.includes(String(answer));
}

/**
 * CB-100b：选 Hermes 内核的真实标记是 CHISABOT_AGENT_KERNEL=hermes（compose-image.sh 从 .env 读它），
 * 而服务器只凭 CHISABOT_HERMES_URL 决定连不连 Hermes。二者不一致（内核选 hermes 却没给 URL）时，
 * 自检必须报 unreachable，不能报 skipped。
 */
export function resolveSmokeHermesProbe(input: {
  agentKernel: string | undefined;
  hermesUrl: string | undefined;
  probe: (() => Promise<HermesReachability>) | undefined;
}): (() => Promise<HermesReachability>) | undefined {
  if (input.hermesUrl?.trim() && input.probe) return input.probe;
  if (input.agentKernel?.trim().toLowerCase() === "hermes") {
    return async () => ({
      reachable: false,
      error: "内核是 hermes（CHISABOT_AGENT_KERNEL=hermes），但没有配置 CHISABOT_HERMES_URL",
    });
  }
  return input.probe;
}

export function createAdminSmokeRoutes(options: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  resolveConnection: () => Promise<RuntimeModelConnection>;
  resolveConnectionForAgent?: (
    agentId: string,
  ) => Promise<RuntimeModelConnection>;
  generate?: Generate;
  /** CB-100：配置了 Hermes 时传入；自检会连它一次，连不上则 ok=false。 */
  probeHermes?: () => Promise<HermesReachability>;
  timeoutMs?: number;
  log?: (line: string) => void;
}) {
  const generate = options.generate ?? generateWithConnection;
  const log = options.log ?? ((line: string) => console.info(line));
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.use("*", options.requireUser);
  routes.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.post("/", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
    } | null;
    const rawAgent =
      typeof body?.agentId === "string" ? body.agentId.trim() : "";
    if (rawAgent && !AGENT_ID.test(rawAgent)) {
      return context.json({ error: "机器人 id 格式不对。" }, 400);
    }
    const agentId = rawAgent || null;
    if (agentId && !options.resolveConnectionForAgent) {
      return context.json({ error: "这台服务器不支持按机器人自检。" }, 400);
    }

    return withModelConnectionScope(async () => {
      let connection: RuntimeModelConnection;
      try {
        connection =
          agentId && options.resolveConnectionForAgent
            ? await options.resolveConnectionForAgent(agentId)
            : await options.resolveConnection();
      } catch {
        return context.json({ error: "模型配置暂时无法读取。" }, 503);
      }
      const question = smokeQuestion();
      const start = performance.now();
      let reply = "";
      let failure: string | null = null;
      let fallback: FallbackUse | undefined;
      try {
        reply = await withFallbackListener(
          (use) => {
            fallback ??= use;
          },
          () =>
            generate(
              connection,
              smokePrompt(question),
              AbortSignal.timeout(options.timeoutMs ?? SMOKE_TIMEOUT_MS),
            ),
        );
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        failure =
          name === "TimeoutError" || name === "AbortError"
            ? "模型在限定时间内没有回复。"
            : "模型请求失败（连接、密钥或模型名有问题）。";
      }
      const latencyMs = Math.round(performance.now() - start);
      let hermes: SmokeResult["hermes"] = "skipped";
      let hermesError: string | undefined;
      if (options.probeHermes) {
        try {
          const probe = await options.probeHermes();
          hermes = probe.reachable ? "ok" : "unreachable";
          if (!probe.reachable) hermesError = (probe.error ?? "无法连接").slice(0, 200);
        } catch (error) {
          hermes = "unreachable";
          hermesError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        }
      }
      const answered = !failure && smokeAnswered(reply, question.answer);
      const modelOk = !failure && reply.trim().length > 0;
      const ok = modelOk && hermes !== "unreachable";
      const result: SmokeResult = {
        ok,
        persisted: false,
        provider: connection.model.provider,
        model: connection.model.defaultModel,
        agentId,
        latencyMs,
        answered,
        echoed: answered,
        reply: reply.slice(0, 200),
        message:
          (hermes === "unreachable"
            ? `智能体运行时（Hermes）无法连接：${hermesError ?? "无法连接"}。${modelOk ? "模型本身可用。" : ""}`
            : "") +
          (failure ??
          (answered
            ? "自检通过：模型正确回答了测试题。"
            : ok
              ? "自检通过：模型有回复（答案没对上，但连接和模型往返正常）。"
              : "模型返回了空回复。")) + (fallback && !failure ? `（${fallbackNotice(fallback)}）` : ""),
        ...(fallback ? { fallback } : {}),
        hermes,
        ...(hermesError ? { hermesError } : {}),
      };
      // 秘密不进日志：只有结果、模型名和耗时。
      log(
        `[admin-smoke] ok=${result.ok} answered=${answered} model=${result.model}${fallback ? ` fallback=${fallback.to}` : ""} agent=${agentId ?? "-"} hermes=${hermes} ${latencyMs}ms`,
      );
      return context.json(result, result.ok ? 200 : 502);
    });
  });

  return routes;
}
