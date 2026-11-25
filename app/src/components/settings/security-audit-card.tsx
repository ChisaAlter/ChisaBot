import {
  IconDeviceDesktop,
  IconLock,
  IconRefresh,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import {
  type ApprovalInboxData,
  approvalInboxOptions,
  type HostCommandPolicy,
} from "@/lib/approvals";
import {
  type PcSecurityAudit,
  type PcSecurityAuditFile,
  pcBridge,
  usePcLocal,
} from "@/lib/pc-bridge";
import { vaultQueryOptions } from "@/lib/vault";

const HOST_COMMAND_LABELS: Record<HostCommandPolicy, string> = {
  ask: "宿主机命令需审批",
  allow: "允许宿主机命令",
  never: "禁止宿主机命令",
};

function formatBackendLabel(backend: string, tokenProtected: boolean): string {
  switch (backend) {
    case "dpapi":
      return "dpapi（Windows 本机加密）";
    case "keychain":
      return "keychain（macOS 钥匙串加密）";
    case "keyring":
      return "keyring（系统密钥环加密）";
    case "basic_text":
      return "basic_text（系统安全存储已降级，新令牌不再走弱加密）";
    case "none":
      return "none（无可用系统加密，令牌以明文保存）";
    default:
      return tokenProtected ? `已加密（${backend}）` : `未加密（${backend}）`;
  }
}

function formatFileAudit(file: PcSecurityAuditFile, platform: string): string {
  if (!file.exists) return `${file.name}: 未创建`;
  if (file.isSymlink) return `${file.name}: 符号链接风险（拒绝读写）`;
  if (file.secure) {
    return platform === "win32"
      ? `${file.name}: 普通文件正常`
      : `${file.name}: 0600 正常`;
  }
  const modeText =
    typeof file.mode === "number"
      ? `0${file.mode.toString(8).padStart(3, "0")}`
      : "异常";
  return `${file.name}: 当前 ${modeText}（需收敛为 0600）`;
}

function describeApprovalGate(data: ApprovalInboxData): {
  enabled: boolean;
  summary: string;
} {
  const enabled = data.preferences?.enabled ?? data.enabled;
  const autoReview =
    data.preferences?.autoReview ?? data.team?.enforceAutoReview ?? false;
  const hostPolicy =
    data.hostCommands ?? data.preferences?.hostCommands ?? "ask";
  const parts = [
    enabled ? "已开启审批拦截" : "审批拦截已关闭",
    autoReview
      ? data.team?.enforceAutoReview
        ? "团队强制自动审核"
        : "自动审核已开启"
      : "人工逐项复核",
    HOST_COMMAND_LABELS[hostPolicy],
  ];
  return { enabled, summary: parts.join(" · ") };
}

function StatusTag({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "neutral";
  children: string;
}) {
  const toneClass =
    tone === "ok"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300"
        : "border-border bg-muted/60 text-muted-foreground";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${toneClass}`}
    >
      {children}
    </span>
  );
}

/**
 * 设置页「安全自检总览」卡片：汇聚展示云端保险箱加密托管、审批保护门禁、
 * 以及（桌面客户端内）PC 本机令牌加密后端与 config.json / audit.jsonl 权限自检。
 */
export function SecurityAuditCard() {
  const queryClient = useQueryClient();
  const vaultQuery = useQuery(vaultQueryOptions());
  const approvalsQuery = useQuery(approvalInboxOptions());
  const [pcLocal, setPcLocal] = usePcLocal();
  const bridge = pcBridge();

  const pcAuditQuery = useQuery({
    queryKey: ["pc", "security-audit"] as const,
    queryFn: async (): Promise<PcSecurityAudit> => {
      if (!bridge?.securityAudit) {
        throw new Error("当前桌面端不支持安全自检");
      }
      return bridge.securityAudit();
    },
    enabled: Boolean(pcLocal && bridge?.securityAudit),
  });

  const hardenMutation = useMutation({
    mutationFn: async (): Promise<PcSecurityAudit> => {
      if (!bridge?.hardenPermissions) {
        throw new Error("当前桌面端不支持一键加固权限");
      }
      return bridge.hardenPermissions();
    },
    onSuccess: async (audit) => {
      await queryClient.invalidateQueries({
        queryKey: ["pc", "security-audit"],
      });
      if (bridge) {
        try {
          setPcLocal(await bridge.state());
        } catch {
          // 忽略主进程状态同步竞态，audit 结果本身已是最新
        }
      }
      const hasSymlink = audit.files.some((item) => item.isSymlink);
      const allSecure = audit.files.every((item) => item.secure);
      if (allSecure) {
        toast.success("已将本机配置与审计日志权限收敛为 0600");
      } else if (hasSymlink) {
        toast.error("已跳过符号链接文件，请检查本机配置目录异常链接");
      } else {
        toast.success("已完成本机权限加固");
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "权限加固失败");
    },
  });

  const vaultCount = vaultQuery.data?.length ?? 0;
  const vaultDomainsCount = new Set(
    (vaultQuery.data ?? []).flatMap((item) => item.domains),
  ).size;

  const approvalGate = approvalsQuery.data
    ? describeApprovalGate(approvalsQuery.data)
    : null;

  const auditData = pcAuditQuery.data;
  const pcBackend =
    auditData?.encryptionBackend ??
    pcLocal?.encryptionBackend ??
    (pcLocal?.tokenProtected ? "protected" : "none");
  const pcTokenProtected =
    auditData?.tokenProtected ?? pcLocal?.tokenProtected ?? false;
  const pcPlatform = auditData?.platform ?? pcLocal?.platform ?? "";
  const pcFiles = auditData?.files ?? [];
  const needsHardening = pcFiles.some(
    (file) => file.exists && !file.secure && !file.isSymlink,
  );
  const pcHasWarning =
    pcBackend === "basic_text" ||
    pcBackend === "none" ||
    !pcTokenProtected ||
    pcFiles.some((file) => !file.secure);

  const pcDetailParts = [
    `令牌加密后端：${formatBackendLabel(pcBackend, pcTokenProtected)}`,
    bridge?.securityAudit
      ? pcAuditQuery.isPending
        ? "正在检查 config.json 与 audit.jsonl 权限…"
        : pcAuditQuery.isError
          ? `本机文件自检失败（${pcAuditQuery.error.message}）`
          : pcFiles.map((file) => formatFileAudit(file, pcPlatform)).join("；")
      : "当前桌面端版本不支持文件权限自检",
  ];

  return (
    <PageSection
      description={"汇聚云端保险箱加密托管、审批保护门禁与本机凭据防护状态。"}
      title={"安全自检总览"}
    >
      <PageRows data-testid="security-audit-card">
        <Item data-testid="security-audit-vault" size="sm">
          <ItemMedia variant="icon">
            <IconLock className="size-4" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{"云端保险箱加密托管"}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {vaultQuery.isPending
                ? "正在读取保险箱托管状态…"
                : vaultQuery.isError
                  ? `保险箱状态暂时无法读取：${vaultQuery.error.message}`
                  : vaultCount > 0
                    ? `已托管 ${vaultCount} 项密钥（覆盖 ${vaultDomainsCount} 个外域白名单），仅在服务端解密并按白名单域名隔离注入，不进入模型上下文。`
                    : "尚未托管密钥；添加后将由服务端加密存储，并严格按外域白名单隔离替换。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {vaultQuery.isPending ? (
              <StatusTag tone="neutral">{"检查中"}</StatusTag>
            ) : vaultQuery.isError ? (
              <Button
                onClick={() => void vaultQuery.refetch()}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconRefresh className="size-3.5" />
                {"重试"}
              </Button>
            ) : (
              <StatusTag tone={vaultCount > 0 ? "ok" : "neutral"}>
                {vaultCount > 0 ? `已托管 ${vaultCount} 项` : "未托管"}
              </StatusTag>
            )}
          </ItemActions>
        </Item>

        <Separator />

        <Item data-testid="security-audit-approvals" size="sm">
          <ItemMedia variant="icon">
            <IconShieldCheck className="size-4" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{"审批保护门禁"}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {approvalsQuery.isPending
                ? "正在读取审批保护门禁状态…"
                : approvalsQuery.isError
                  ? `审批策略暂时无法读取：${approvalsQuery.error.message}`
                  : (approvalGate?.summary ?? "")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {approvalsQuery.isPending ? (
              <StatusTag tone="neutral">{"检查中"}</StatusTag>
            ) : approvalsQuery.isError ? (
              <Button
                onClick={() => void approvalsQuery.refetch()}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconRefresh className="size-3.5" />
                {"重试"}
              </Button>
            ) : (
              <StatusTag tone={approvalGate?.enabled ? "ok" : "warn"}>
                {approvalGate?.enabled ? "已开启" : "未开启"}
              </StatusTag>
            )}
          </ItemActions>
        </Item>

        {pcLocal ? (
          <>
            <Separator />
            <Item data-testid="security-audit-pc" size="sm">
              <ItemMedia variant="icon">
                <IconDeviceDesktop className="size-4" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{"PC 本机安全自检"}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {pcDetailParts.join(" · ")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {pcAuditQuery.isError ? (
                  <Button
                    onClick={() => void pcAuditQuery.refetch()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <IconRefresh className="size-3.5" />
                    {"重试"}
                  </Button>
                ) : null}
                {needsHardening && bridge?.hardenPermissions ? (
                  <Button
                    data-testid="security-audit-harden-btn"
                    disabled={hardenMutation.isPending}
                    onClick={() => hardenMutation.mutate()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {hardenMutation.isPending ? "加固中…" : "立即加固权限"}
                  </Button>
                ) : (
                  <StatusTag
                    tone={
                      pcAuditQuery.isPending
                        ? "neutral"
                        : pcHasWarning
                          ? "warn"
                          : "ok"
                    }
                  >
                    {pcAuditQuery.isPending
                      ? "检查中"
                      : pcHasWarning
                        ? "需关注"
                        : "已加固"}
                  </StatusTag>
                )}
              </ItemActions>
            </Item>
          </>
        ) : null}
      </PageRows>
    </PageSection>
  );
}
