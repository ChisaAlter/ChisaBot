import { client } from "@/lib/client";

export type RecordedDemonstrationKind = "click" | "type" | "key" | "scroll";

export type RecordedDemonstrationTarget = {
  role: string;
  name: string;
  sensitive: boolean;
};

export type RecordedDemonstrationAction = {
  kind: RecordedDemonstrationKind;
  key?: string;
  deltaY?: number;
  url: string;
  target: RecordedDemonstrationTarget;
  recordedAt: string;
};

export type DemonstrationSession = {
  id: string;
  ownerUserId: string;
  botId: string;
  status: "recording" | "stopped";
  goal?: string;
  startedAt: string;
  stoppedAt?: string;
  actions: RecordedDemonstrationAction[];
};

export type StopDemonstrationResult = {
  recording: DemonstrationSession;
  compilePrompt: string;
};

const ALLOWED_KINDS = new Set<string>(["click", "type", "key", "scroll"]);

/** 构造浏览器实时流 WS 路径；录制中附带 `?recording=` 透传给服务端与云端浏览器。 */
export function buildLiveStreamPath(
  computerId: string,
  recordingId?: string | null,
): string {
  const base = `/api/computers/${encodeURIComponent(computerId)}/stream`;
  const trimmed = recordingId?.trim();
  return trimmed ? `${base}?recording=${encodeURIComponent(trimmed)}` : base;
}

/** 解析 WS 透传的 `demonstration.action` 帧；结构不合法时返回 null。 */
export function parseDemonstrationActionMessage(
  parsed: Record<string, unknown>,
): RecordedDemonstrationAction | null {
  if (parsed.type !== "demonstration.action") return null;
  const rawAction = parsed.action;
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
    return null;
  }
  const action = rawAction as Record<string, unknown>;
  if (typeof action.kind !== "string" || !ALLOWED_KINDS.has(action.kind)) {
    return null;
  }
  if (typeof action.url !== "string") return null;

  const rawTarget = action.target;
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
    return null;
  }
  const target = rawTarget as Record<string, unknown>;
  if (
    typeof target.role !== "string" ||
    typeof target.name !== "string" ||
    typeof target.sensitive !== "boolean"
  ) {
    return null;
  }

  const normalized: RecordedDemonstrationAction = {
    kind: action.kind as RecordedDemonstrationKind,
    url: action.url,
    target: {
      role: target.role,
      name: target.sensitive ? "[sensitive field]" : target.name,
      sensitive: target.sensitive,
    },
    recordedAt:
      typeof action.recordedAt === "string" && action.recordedAt.trim()
        ? action.recordedAt
        : new Date().toISOString(),
  };

  if (typeof action.key === "string" && action.key) {
    normalized.key = action.key;
  }
  if (typeof action.deltaY === "number" && Number.isFinite(action.deltaY)) {
    normalized.deltaY = action.deltaY;
  }

  return normalized;
}

/** 把单条脱敏示教步骤转成紧凑可读的中文短标签。 */
export function describeDemonstrationAction(
  action: RecordedDemonstrationAction,
): string {
  const label = action.target.sensitive
    ? "敏感字段（已脱敏）"
    : action.target.name.trim() || action.target.role;
  switch (action.kind) {
    case "click":
      return `点击「${label}」`;
    case "type":
      return action.target.sensitive
        ? "输入敏感字段（已脱敏）"
        : `输入「${label}」`;
    case "key":
      return `按键 ${action.key ?? "Key"}`;
    case "scroll":
      return (action.deltaY ?? 0) >= 0 ? "向下滚动" : "向上滚动";
  }
}

export async function startDemonstration(
  botId: string,
  goal?: string,
): Promise<DemonstrationSession> {
  const trimmed = goal?.trim();
  return client<DemonstrationSession>(
    `/api/computers/${encodeURIComponent(botId)}/demonstrations/start`,
    "recording",
    {
      method: "POST",
      body: trimmed ? { goal: trimmed } : {},
      fallback: "无法开始录制示教。",
    },
  );
}

export async function stopDemonstration(
  botId: string,
  recordingId: string,
): Promise<StopDemonstrationResult> {
  const response = await client(
    `/api/computers/${encodeURIComponent(botId)}/demonstrations/${encodeURIComponent(recordingId)}/stop`,
    {
      method: "POST",
      body: {},
      fallback: "无法结束录制示教。",
    },
  );
  const body = (await response.json().catch(() => null)) as {
    recording?: DemonstrationSession;
    compilePrompt?: string;
  } | null;
  if (!body?.recording || typeof body.compilePrompt !== "string") {
    throw new Error("无法读取示教录制结果。");
  }
  return {
    recording: body.recording,
    compilePrompt: body.compilePrompt,
  };
}
