import { tryClient } from "@/lib/client";

/** `POST /api/admin/smoke` 的结果（server/src/admin-smoke.ts，docs/admin-smoke.md）。 */
export type AdminSmokeResult = {
  ok: boolean;
  persisted: false;
  provider: "openai" | "anthropic";
  model: string;
  agentId: string | null;
  latencyMs: number;
  /** 答对了测试题（有回复但答错也算通过）。旧服务器没有这个字段。 */
  answered?: boolean;
  echoed: boolean;
  reply: string;
  message: string;
};

/** 管理员自检：一次真实的模型往返，不落库。失败（502）也返回结果，方便页面显示原因。 */
export async function runAdminSmoke(agentId?: string): Promise<AdminSmokeResult> {
  const response = await tryClient("/api/admin/smoke", {
    method: "POST",
    body: agentId ? { agentId } : {},
    // The server allows the model 45s, plus response transport.
    timeoutMs: 60_000,
  });
  const body = (await response.json().catch(() => null)) as
    | (Partial<AdminSmokeResult> & { error?: string })
    | null;
  if (!body || typeof body.ok !== "boolean") {
    throw new Error(body?.error ?? "自检请求失败。");
  }
  return body as AdminSmokeResult;
}
