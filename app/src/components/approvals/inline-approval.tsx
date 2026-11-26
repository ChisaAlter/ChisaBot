import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { ConfirmCardView } from "@/components/chat/confirm-card";
import { SmoothCollapse } from "@/components/ui/motion-primitives";
import {
  type ApprovalDecision,
  approvalInboxOptions,
  decideApproval,
} from "@/lib/approvals";
import { useKeptVisibility } from "@/lib/kept-visible";
import { DURATION_MS, usePresenceMount, useRetainedValue } from "@/lib/motion";

/**
 * A pending approval, drawn in the conversation where the action it holds would have been.
 *
 * The same request as the Approvals page, read from the same owner-scoped inbox, so a decision made
 * in either place is the one decision. Once decided the server runs the action exactly once and
 * continues the conversation, and this gives the line back to the tool's own renderer.
 */
export function InlineApproval({
  toolCallId,
  fallback,
}: {
  toolCallId?: string;
  fallback: ReactNode;
}) {
  const cache = useQueryClient();
  const visibility = useKeptVisibility();
  const inbox = useQuery(approvalInboxOptions({ poll: () => visibility.get() }));
  const [decidedStatus, setDecidedStatus] = useState<
    "approved" | "denied" | null
  >(null);
  const request = toolCallId
    ? inbox.data?.requests.find(
        (candidate) => candidate.action.toolCallId === toolCallId,
      )
    : undefined;
  const pending = request?.status === "pending";
  const retainedRequest = useRetainedValue(pending ? request : null);
  const cardPresence = usePresenceMount(pending, DURATION_MS.collapse);
  const decision = useMutation({
    mutationFn: (choice: ApprovalDecision) =>
      decideApproval(request?.id ?? "", choice),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const shownRequest = pending ? request : retainedRequest;
  const showingCard = Boolean(
    shownRequest && (pending || (cardPresence.mounted && decidedStatus)),
  );
  if (!showingCard || !shownRequest) return <>{fallback}</>;
  const handOff = shownRequest.action.policy?.behaviour === "hand_off";
  const decide = async (choice: ApprovalDecision) => {
    if (decision.isPending) return;
    setDecidedStatus(choice === "deny" ? "denied" : "approved");
    await decision.mutateAsync(choice);
  };
  // 上游审批（云端浏览器的安全规则、规则「先问」等）也用 ChisaBot 的确认卡片外观（DESIGN.md §58）。
  const what = shownRequest.action.toolRef
    .replace(/^computer_|^host\//, "")
    .replaceAll("_", " ");
  const payment = /pay|checkout|purchase|付款|支付|下单/i.test(
    `${shownRequest.action.policy?.reason ?? ""} ${shownRequest.action.scope}`,
  );
  const reason = zhReason(shownRequest.action.policy?.reason);
  const trimmedScope = shownRequest.action.scope.trim();
  const canAllowAlways = !handOff && !payment && trimmedScope.length > 0;
  const scopeHint = canAllowAlways
    ? formatApprovalScopeHint(trimmedScope)
    : undefined;
  return (
    <SmoothCollapse open={pending} unmountOnExit>
      <ConfirmCardView
        actionBusy={decision.isPending}
        alwaysLabel={canAllowAlways ? "始终允许此范围" : undefined}
        approveLabel={handOff ? "我已自己完成" : "确认"}
        denyLabel={handOff ? "不要执行" : "取消"}
        model={{
          category: payment ? "purchase" : "device",
          eyebrow: handOff ? "这一步要你亲自完成" : undefined,
          title: handOff
            ? (reason ?? `${what}：${shownRequest.action.scope}`)
            : `云端浏览器：${what}`,
          target: shownRequest.action.scope,
          details: reason && !handOff ? [{ label: "原因", value: reason }] : [],
          status: pending ? "pending" : (decidedStatus ?? "approved"),
        }}
        onAllowAlways={
          canAllowAlways ? () => decide("allow_always") : undefined
        }
        onApprove={() => decide(handOff ? "handled" : "allow_once")}
        onDeny={() => decide("deny")}
        scopeHint={scopeHint}
        testId={pending ? "upstream-approval-card" : undefined}
      />
    </SmoothCollapse>
  );
}

const MULTI_PART_TLDS = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "co.uk",
  "org.uk",
  "co.jp",
  "go.jp",
  "ne.jp",
  "com.au",
  "com.tw",
  "com.hk",
]);

const FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "txt",
  "log",
  "py",
  "kt",
  "java",
  "go",
  "rs",
  "css",
  "html",
  "xml",
  "yml",
  "yaml",
  "toml",
  "sh",
  "bat",
  "ps1",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "pdf",
  "csv",
  "zip",
  "tar",
  "gz",
]);

const PATH_PREFIX_DIRS = new Set([
  "src",
  "app",
  "server",
  "pc",
  "android",
  "shared",
  "docs",
  "tests",
  "test",
  "etc",
  "var",
  "usr",
  "tmp",
  "home",
  "dist",
  "build",
]);

const COMMAND_PREFIX =
  /^(?:cmd:|shell:|\$\s+|(?:git|npm|bun|pnpm|yarn|docker|kubectl|curl|wget|rm|mv|cp|chmod|chown|python|python3|node|bash|sh|zsh|powershell|pwsh|cat|ls|find|grep|rg|sed|awk|make|gradle|cargo|go)\s+)/i;

function extractRootDomain(host: string): string {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  const tail2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (MULTI_PART_TLDS.has(tail2) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function isIpOrLocalHost(host: string): boolean {
  if (host === "localhost" || host.includes(":")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function describeHostScope(rawHost: string): string {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return "";
  if (isIpOrLocalHost(host) || !host.includes(".")) {
    return `主机范围「${host}」：记住后对该地址的同类操作不再询问，可在「设置 → 权限与审批」撤销`;
  }
  const rootDomain = extractRootDomain(host);
  if (host === rootDomain) {
    return `域名范围「${host}」：记住后将覆盖该域名及子域的同类操作，可在「设置 → 权限与审批」撤销`;
  }
  return `域名范围「${host}」：记住后将覆盖该地址及所属主域（${rootDomain} 及子域）的同类操作，可在「设置 → 权限与审批」撤销`;
}

/** 将待审批请求中的 action.scope 转成面向用户的简体中文影响域提示。 */
export function formatApprovalScopeHint(scope: string): string {
  const raw = scope.trim();
  if (!raw) return "";
  if (raw === "*") {
    return "全局范围（*）：记住后该机器人对所有同类操作都不再询问，可在「设置 → 权限与审批」撤销";
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.hostname) return describeHostScope(parsed.hostname);
    } catch {
      // 非法 URL 继续按通用范围处理
    }
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
    const [owner, repo] = raw.split("/");
    const ext = repo.includes(".")
      ? repo.split(".").pop()?.toLowerCase()
      : undefined;
    if (
      owner !== "." &&
      owner !== ".." &&
      !PATH_PREFIX_DIRS.has(owner.toLowerCase()) &&
      (!ext || !FILE_EXTENSIONS.has(ext))
    ) {
      return `仓库范围「${raw}」：记住后仅对该仓库的同类操作不再询问，可在「设置 → 权限与审批」撤销`;
    }
  }
  if (
    /^(?:\/|\.\.?\/|~\/|[A-Za-z]:[\\/])/.test(raw) ||
    raw.includes("\\") ||
    raw.includes("/")
  ) {
    return `路径范围「${raw}」：记住后仅对该路径的同类文件操作不再询问，可在「设置 → 权限与审批」撤销`;
  }
  if (COMMAND_PREFIX.test(raw) || /[|&;]/.test(raw)) {
    return `命令范围「${raw}」：记住后再次执行该范围命令将不再询问，可在「设置 → 权限与审批」撤销`;
  }
  if (/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/.test(raw)) {
    const withoutPort = raw.replace(/:\d{1,5}$/, "");
    const cleanHost = withoutPort.replace(/^\[|\]$/g, "").toLowerCase();
    const ext = cleanHost.includes(".")
      ? cleanHost.split(".").pop()?.toLowerCase()
      : undefined;
    if (
      isIpOrLocalHost(cleanHost) ||
      (cleanHost.includes(".") && (!ext || !FILE_EXTENSIONS.has(ext)))
    ) {
      return describeHostScope(cleanHost);
    }
  }
  return `作用域「${raw}」：记住后该机器人对同范围操作不再询问，可在「设置 → 权限与审批」撤销`;
}

/** 上游的英文原因换成中文（界面文字一律简体中文）。 */
function zhReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  if (/pay|purchas|money/i.test(reason)) return "付款、购买、转账要你亲自完成";
  if (/password|passcode|credential|two-factor|recovery/i.test(reason))
    return "改密码、验证码等登录凭据要你亲自完成";
  if (/security|sharing|access settings/i.test(reason))
    return "改安全、共享或权限设置要你亲自完成";
  if (/rule asks/i.test(reason)) return "你的规则要求先问你";
  if (/review changes/i.test(reason)) return "你设置了改动前先问你";
  if (/[\u4e00-\u9fff]/.test(reason)) return reason;
  return "这一步需要你确认";
}

/**
 * The pending approvals for a group of tool calls, for a transcript that draws those calls itself
 * rather than through each tool's renderer: the browser-activity group folds every click and field
 * into one collapsed line, so a card inside a step would never be seen. Drawn beside the group,
 * outside the fold, one card per waiting call; nothing at all when none is waiting.
 */
export function PendingApprovals({
  toolCallIds,
}: {
  toolCallIds: readonly string[];
}) {
  const visibility = useKeptVisibility();
  const inbox = useQuery(approvalInboxOptions({ poll: () => visibility.get() }));
  const waiting = new Set(
    (inbox.data?.requests ?? [])
      .filter((request) => request.status === "pending")
      .flatMap((request) =>
        request.action.toolCallId ? [request.action.toolCallId] : [],
      ),
  );
  const ids = toolCallIds.filter((id) => waiting.has(id));
  const hasWaiting = ids.length > 0;
  const lastIds = useRef<string[]>([]);
  if (hasWaiting) {
    lastIds.current = ids;
  }
  const presence = usePresenceMount(hasWaiting, DURATION_MS.collapse);
  const shownIds = hasWaiting ? ids : lastIds.current;
  if (!presence.mounted || shownIds.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {shownIds.map((id) => (
        <InlineApproval key={id} toolCallId={id} fallback={null} />
      ))}
    </div>
  );
}
