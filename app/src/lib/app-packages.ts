import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import type {
  AppPackageDetail,
  AppPackageRevisionSummary,
  AppPackageSummary,
  AppPackageValidationResult,
  ChisaAppPackage,
  ExecutionNodeHealthResult,
  ExecutionNodeInput,
  ExecutionNodesListResponse,
  ExecutionNodeView,
  McpServerEnhancementPatch,
  McpServerEnhancementView,
} from "../../../shared/app-packages";

/**
 * Wave 8 前端数据访问层：
 * - `/api/apps/*`：AI 自研微应用 / MCP 插件包（草稿审阅、安装授权、配置、OAuth、版本回滚、脱敏导入导出）；
 * - `/api/mcp-enhancements/*`：远端 MCP 增强（SSE / 加密 Header / OAuth2 / 自定义指令 / 单工具开关 / mcp-last-good）；
 * - `/api/admin/execution-nodes/*`：远程执行节点可视化热配置、连通性探活与一键热切换。
 *
 * 全部请求统一走 `@/lib/client`，严禁裸 fetch。
 */

export type {
  AppPackageDetail,
  AppPackageRevisionSummary,
  AppPackageSummary,
  AppPackageValidationResult,
  ChisaAppPackage,
  ExecutionNodeHealthResult,
  ExecutionNodeInput,
  ExecutionNodesListResponse,
  ExecutionNodeView,
  McpServerEnhancementPatch,
  McpServerEnhancementView,
};

export const appPackagesKeys = {
  all: ["app-packages"] as const,
  detail: (id: string) => ["app-packages", "detail", id] as const,
  revisions: (id: string) => ["app-packages", "revisions", id] as const,
  mcpEnhancement: (serverId: string) =>
    ["mcp-enhancements", serverId] as const,
  executionNodes: ["execution-nodes"] as const,
};

export type AppPackagesListResponse = {
  apps: AppPackageSummary[];
  oauthCallbackUrl: string | null;
};

export const appPackagesQueryOptions = () =>
  queryOptions({
    queryKey: appPackagesKeys.all,
    queryFn: async (): Promise<AppPackagesListResponse> => {
      const response = await client("/api/apps", {
        fallback: "无法加载 AI 微应用列表",
      });
      return (await response.json()) as AppPackagesListResponse;
    },
  });

export const appPackageDetailQueryOptions = (appId: string, enabled = true) =>
  queryOptions({
    queryKey: appPackagesKeys.detail(appId),
    enabled: enabled && Boolean(appId),
    queryFn: () =>
      client<AppPackageDetail>(
        `/api/apps/${encodeURIComponent(appId)}`,
        "app",
        { fallback: "无法加载微应用源码与详情" },
      ),
  });

export function validateAppPackage(
  pkg: unknown,
): Promise<AppPackageValidationResult> {
  return client<AppPackageValidationResult>("/api/apps/validate", "validation", {
    method: "POST",
    body: { package: pkg },
    fallback: "应用包静态安全预检失败",
  });
}

export async function importAppPackage(
  pkg: unknown,
): Promise<{ app: AppPackageSummary; isUpdate: boolean }> {
  const response = await client("/api/apps/import", {
    method: "POST",
    body: { package: pkg },
    fallback: "导入应用包失败",
  });
  return (await response.json()) as {
    app: AppPackageSummary;
    isUpdate: boolean;
  };
}

export async function installAppPackage(input: {
  id: string;
  expectedDigest: string;
  probe?: boolean;
}): Promise<{
  app: AppPackageSummary;
  tools?: unknown[];
  probeError?: string;
}> {
  const response = await client(
    `/api/apps/${encodeURIComponent(input.id)}/install`,
    {
      method: "POST",
      body: {
        expectedDigest: input.expectedDigest,
        probe: input.probe === true,
      },
      fallback: "批准并安装微应用失败",
      timeoutMs: 45_000,
    },
  );
  return (await response.json()) as {
    app: AppPackageSummary;
    tools?: unknown[];
    probeError?: string;
  };
}

export function disableAppPackage(id: string): Promise<AppPackageSummary> {
  return client<AppPackageSummary>(
    `/api/apps/${encodeURIComponent(id)}/disable`,
    "app",
    {
      method: "POST",
      fallback: "停用微应用失败",
    },
  );
}

export function updateAppPackageConfig(input: {
  id: string;
  values: Record<string, string>;
  clearKeys?: string[];
}): Promise<AppPackageSummary> {
  return client<AppPackageSummary>(
    `/api/apps/${encodeURIComponent(input.id)}/config`,
    "app",
    {
      method: "PUT",
      body: {
        values: input.values,
        ...(input.clearKeys && input.clearKeys.length > 0
          ? { clearKeys: input.clearKeys }
          : {}),
      },
      fallback: "保存微应用配置失败",
    },
  );
}

export function updateAppPackageOAuth(input: {
  id: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string | null;
  scope?: string;
  headerName?: string;
}): Promise<AppPackageSummary> {
  return client<AppPackageSummary>(
    `/api/apps/${encodeURIComponent(input.id)}/oauth`,
    "app",
    {
      method: "PUT",
      body: {
        ...(input.accessToken !== undefined
          ? { accessToken: input.accessToken }
          : {}),
        ...(input.refreshToken !== undefined
          ? { refreshToken: input.refreshToken }
          : {}),
        ...(input.tokenType !== undefined
          ? { tokenType: input.tokenType }
          : {}),
        ...(input.expiresAt !== undefined
          ? { expiresAt: input.expiresAt }
          : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.headerName !== undefined
          ? { headerName: input.headerName }
          : {}),
      },
      fallback: "更新微应用 OAuth 令牌失败",
    },
  );
}

export async function startAppPackageOAuth(
  id: string,
): Promise<{ authorizationUrl: string; redirectUri: string }> {
  const response = await client(
    `/api/apps/${encodeURIComponent(id)}/oauth/start`,
    {
      method: "POST",
      fallback: "无法生成 OAuth2 授权链接",
    },
  );
  return (await response.json()) as {
    authorizationUrl: string;
    redirectUri: string;
  };
}

export function clearAppPackageOAuth(id: string): Promise<AppPackageSummary> {
  return client<AppPackageSummary>(
    `/api/apps/${encodeURIComponent(id)}/oauth`,
    "app",
    {
      method: "DELETE",
      fallback: "解绑 OAuth 令牌失败",
    },
  );
}

export function rollbackAppPackage(input: {
  id: string;
  digest: string;
  approve?: boolean;
}): Promise<AppPackageSummary> {
  return client<AppPackageSummary>(
    `/api/apps/${encodeURIComponent(input.id)}/rollback`,
    "app",
    {
      method: "POST",
      body: { digest: input.digest, approve: input.approve === true },
      fallback: "回滚微应用版本失败",
    },
  );
}

export function exportAppPackage(
  id: string,
  digest?: string,
): Promise<ChisaAppPackage> {
  const query = digest ? `?digest=${encodeURIComponent(digest)}` : "";
  return client<ChisaAppPackage>(
    `/api/apps/${encodeURIComponent(id)}/export${query}`,
    "package",
    { fallback: "导出脱敏应用包失败" },
  );
}

export async function deleteAppPackage(id: string): Promise<void> {
  await client(`/api/apps/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "删除微应用失败",
  });
}

// ── 远端 MCP 连接器增强 ───────────────────────────────────────────────────

export const mcpEnhancementQueryOptions = (serverId: string, enabled = true) =>
  queryOptions({
    queryKey: appPackagesKeys.mcpEnhancement(serverId),
    enabled: enabled && Boolean(serverId),
    queryFn: async (): Promise<McpServerEnhancementView | null> => {
      const response = await tryClient(
        `/api/mcp-enhancements/${encodeURIComponent(serverId)}`,
      );
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as {
        enhancement?: McpServerEnhancementView;
      } | null;
      return body?.enhancement ?? null;
    },
  });

export function updateMcpEnhancement(
  serverId: string,
  patch: McpServerEnhancementPatch,
): Promise<McpServerEnhancementView> {
  return client<McpServerEnhancementView>(
    `/api/mcp-enhancements/${encodeURIComponent(serverId)}`,
    "enhancement",
    {
      method: "PUT",
      body: patch,
      fallback: "保存远端 MCP 增强配置失败",
    },
  );
}

// ── 远程执行节点可视化热切换 ──────────────────────────────────────────────

export const executionNodesQueryOptions = () =>
  queryOptions({
    queryKey: appPackagesKeys.executionNodes,
    queryFn: async (): Promise<ExecutionNodesListResponse> => {
      const response = await client("/api/admin/execution-nodes", {
        fallback: "无法加载远程执行节点配置",
      });
      return (await response.json()) as ExecutionNodesListResponse;
    },
  });

export function createExecutionNode(
  input: ExecutionNodeInput,
): Promise<ExecutionNodeView> {
  return client<ExecutionNodeView>("/api/admin/execution-nodes", "node", {
    method: "POST",
    body: input,
    fallback: "新增远程执行节点失败",
  });
}

export function updateExecutionNode(
  id: string,
  input: Partial<ExecutionNodeInput>,
): Promise<ExecutionNodeView> {
  return client<ExecutionNodeView>(
    `/api/admin/execution-nodes/${encodeURIComponent(id)}`,
    "node",
    {
      method: "PUT",
      body: input,
      fallback: "更新远程执行节点失败",
    },
  );
}

export async function deleteExecutionNode(id: string): Promise<void> {
  await client(`/api/admin/execution-nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "删除远程执行节点失败",
  });
}

export async function activateExecutionNode(
  id: string,
): Promise<ExecutionNodesListResponse> {
  const response = await client(
    `/api/admin/execution-nodes/${encodeURIComponent(id)}/activate`,
    {
      method: "POST",
      fallback: "热切换远程执行节点失败",
    },
  );
  return (await response.json()) as ExecutionNodesListResponse;
}

export async function deactivateExecutionNodes(): Promise<ExecutionNodesListResponse> {
  const response = await client("/api/admin/execution-nodes/deactivate", {
    method: "POST",
    fallback: "切回静态环境变量模式失败",
  });
  return (await response.json()) as ExecutionNodesListResponse;
}

export async function probeExecutionNodeById(
  id: string,
): Promise<{ node: ExecutionNodeView; health: ExecutionNodeHealthResult }> {
  const response = await client(
    `/api/admin/execution-nodes/${encodeURIComponent(id)}/probe`,
    {
      method: "POST",
      fallback: "探测远程执行节点连通性失败",
      timeoutMs: 15_000,
    },
  );
  return (await response.json()) as {
    node: ExecutionNodeView;
    health: ExecutionNodeHealthResult;
  };
}

export function probeExecutionNodeDraft(input: {
  nodeId?: string;
  baseUrl: string;
  token?: string;
  allowPrivateNetwork?: boolean;
}): Promise<ExecutionNodeHealthResult> {
  return client<ExecutionNodeHealthResult>(
    "/api/admin/execution-nodes/probe",
    "health",
    {
      method: "POST",
      body: input,
      fallback: "探测远程执行节点连通性失败",
      timeoutMs: 15_000,
    },
  );
}
