import {
  IconCheck,
  IconDeviceMobile,
  IconQrcode,
  IconRefresh,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useExternalConnection, useInterval } from "@/hooks";
import { ClientError } from "@/lib/client";
import {
  cancelPairing,
  createPairing,
  deviceKeys,
  type PairingTicket,
  pairingErrorMessage,
  pairingStatus,
} from "@/lib/devices";
import { qrPath } from "@/lib/qr";
import { cn } from "@/lib/utils";
import { pairingUri } from "../../../../shared/devices";

/**
 * 设置 → 设备 →「绑定手机」（DESIGN.md §33）。
 *
 * 弹窗里是一次性二维码：内容 = 服务器地址 + 5 分钟有效、只能用一次的绑定码。
 * 每 2 秒问一次状态：等待扫码 → 已绑定（二维码淡出，✓ 和手机名淡入）。码过期自动换新码；
 * 连续自动换 {@link MAX_AUTO_REFRESH} 次没人扫就停下，等人点「刷新二维码」。关窗即作废当前码。
 */

const POLL_MS = 2000;
const MAX_AUTO_REFRESH = 6;

type Phase =
  | { kind: "loading" }
  | { kind: "pending"; ticket: PairingTicket }
  | { kind: "paused" }
  | { kind: "bound"; name: string }
  | { kind: "error"; message: string };

function useCountdown(key: string | null, ttlSeconds: number) {
  // 服务器时钟和本机可能差几分钟：只用 ttlSeconds + 本机单调时钟倒数（同 useApprovalCountdown 的做法）。
  // 渲染期按 key 同步派生，避免新 ticket 写入当帧读到旧码归零后的 left === 0 而二次换码。
  const activeKey = key ? `${key}\0${ttlSeconds}` : null;
  const [state, setState] = useState<{ key: string | null; left: number }>({
    key: activeKey,
    left: ttlSeconds,
  });
  const startRef = useRef(0);
  const prevKeyRef = useRef<string | null>(null);
  if (prevKeyRef.current !== activeKey) {
    prevKeyRef.current = activeKey;
    startRef.current = key ? performance.now() : 0;
  }

  useInterval(
    () => {
      const next = Math.max(
        0,
        Math.ceil(ttlSeconds - (performance.now() - startRef.current) / 1000),
      );
      setState((prev) =>
        prev.key === activeKey && prev.left === next
          ? prev
          : { key: activeKey, left: next },
      );
    },
    activeKey ? 500 : null,
    activeKey,
  );
  return state.key === activeKey ? state.left : ttlSeconds;
}

function mmss(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function PairQr({ value, dim }: { value: string; dim?: boolean }) {
  const qr = useMemo(() => qrPath(value), [value]);
  const quiet = 2;
  const box = qr.size + quiet * 2;
  return (
    <svg
      aria-label="绑定二维码"
      className={cn("pair-qr-svg", dim && "is-dim")}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
    >
      <rect fill="#fff" height={box} width={box} x={-quiet} y={-quiet} />
      <path d={qr.path} fill="#0b1220" />
    </svg>
  );
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException || error instanceof Error) &&
    error.name === "AbortError"
  );
}

export function PairPhoneDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const autoRefreshes = useRef(0);
  const current = useRef<string | null>(null);
  const issueAbort = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const rotating = useRef<string | null>(null);
  const leftRef = useRef(0);
  const server = typeof window === "undefined" ? "" : window.location.origin;
  const [selectedOrigin, setSelectedOrigin] = useState<string | null>(null);

  const issue = useCallback(async () => {
    issueAbort.current?.abort();
    const controller = new AbortController();
    issueAbort.current = controller;
    const previous = current.current;
    const ticket = await createPairing("phone", { signal: controller.signal });
    if (controller.signal.aborted || issueAbort.current !== controller) {
      void cancelPairing(ticket.id);
      return null;
    }
    rotating.current = null;
    current.current = ticket.id;
    if (previous && previous !== ticket.id) void cancelPairing(previous);
    setPhase({ kind: "pending", ticket });
    return ticket;
  }, []);

  const onIssueError = useCallback((error: unknown) => {
    if (isAbort(error)) return;
    setPhase({ kind: "error", message: pairingErrorMessage(error) });
  }, []);

  const rotateTicket = useCallback(
    (deadId: string, cancelOnServer: boolean) => {
      if (
        !openRef.current ||
        current.current !== deadId ||
        rotating.current === deadId
      ) {
        return;
      }
      if (autoRefreshes.current >= MAX_AUTO_REFRESH) {
        if (cancelOnServer) void cancelPairing(deadId);
        current.current = null;
        setPhase({ kind: "paused" });
        return;
      }
      rotating.current = deadId;
      autoRefreshes.current += 1;
      // 服务端已失效（expired / cancelled / 404）时先清空 current，防止 issue() 成功后多余 DELETE。
      if (!cancelOnServer) current.current = null;
      issue().catch((err: unknown) => {
        if (rotating.current === deadId) rotating.current = null;
        if (openRef.current) onIssueError(err);
      });
    },
    [issue, onIssueError],
  );

  // 打开时签发；关闭时作废。
  useExternalConnection(open, () => {
    openRef.current = true;
    autoRefreshes.current = 0;
    rotating.current = null;
    setPhase({ kind: "loading" });
    let alive = true;
    issue().catch((error: unknown) => {
      if (alive && openRef.current) onIssueError(error);
    });
    return () => {
      alive = false;
      openRef.current = false;
      rotating.current = null;
      issueAbort.current?.abort();
      issueAbort.current = null;
      if (current.current) void cancelPairing(current.current);
      current.current = null;
    };
  });

  const ticket = phase.kind === "pending" ? phase.ticket : null;
  const alternateOrigins = (ticket?.alternateOrigins ?? []).filter(
    (origin) => origin && origin !== server,
  );
  const activeServer =
    selectedOrigin && alternateOrigins.includes(selectedOrigin)
      ? selectedOrigin
      : server;
  const remainingAlternates = [server, ...alternateOrigins].filter(
    (origin) => origin && origin !== activeServer,
  );
  const qrValue = ticket
    ? pairingUri(
        activeServer,
        ticket.code,
        remainingAlternates.length > 0 || ticket.e2eePublicKey
          ? {
              ...(remainingAlternates.length > 0
                ? { alternates: remainingAlternates }
                : {}),
              ...(ticket.e2eePublicKey
                ? { e2eePub: ticket.e2eePublicKey }
                : {}),
            }
          : undefined,
      )
    : "";
  const left = useCountdown(ticket?.id ?? null, ticket?.ttlSeconds ?? 300);
  leftRef.current = left;

  // 轮询绑定状态。
  useExternalConnection(
    ticket ? `${ticket.id}\0${ticket.expiresAt}` : null,
    (_activeKey, signal) => {
      if (!ticket) return;
      let timer = 0;
      const tick = async () => {
        try {
          const status = await pairingStatus(ticket.id, signal);
          if (signal.aborted) return;
          if (status.state === "bound") {
            current.current = null;
            setPhase({
              kind: "bound",
              name: status.device?.name ?? "这台手机",
            });
            void queryClient.invalidateQueries({ queryKey: deviceKeys.all });
            return;
          }
          if (status.state === "expired" || status.state === "cancelled") {
            rotateTicket(ticket.id, false);
            return;
          }
        } catch (error) {
          if (
            !signal.aborted &&
            error instanceof ClientError &&
            error.status === 404
          ) {
            rotateTicket(ticket.id, false);
            return;
          }
          /* 偶发网络错误或取消：下一轮再问。 */
        }
        if (!signal.aborted) timer = window.setTimeout(tick, POLL_MS);
      };
      timer = window.setTimeout(tick, POLL_MS);
      return () => {
        window.clearTimeout(timer);
      };
    },
  );

  // 过期自动换码。
  useExternalConnection(
    ticket && left <= 0 ? `${ticket.id}:expired` : null,
    () => {
      if (!ticket) return;
      rotateTicket(ticket.id, true);
    },
  );

  const refresh = useAsyncAction(
    async () => {
      autoRefreshes.current = 0;
      rotating.current = null;
      try {
        await issue();
      } catch (error) {
        if (!openRef.current || isAbort(error)) return;
        const message = pairingErrorMessage(error);
        setPhase((prev) =>
          prev.kind === "pending" && leftRef.current > 0
            ? prev
            : { kind: "error", message },
        );
        throw error;
      }
    },
    { errorToast: (error) => `刷新失败：${pairingErrorMessage(error)}` },
  );

  const status =
    phase.kind === "bound"
      ? { tone: "is-ok", text: "已绑定" }
      : phase.kind === "pending"
        ? { tone: "is-accent", text: "等待扫码" }
        : phase.kind === "paused"
          ? { tone: "is-muted", text: "已暂停刷新" }
          : phase.kind === "error"
            ? { tone: "is-danger", text: "生成失败" }
            : { tone: "is-muted", text: "生成中…" };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="pair-dialog max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{"绑定手机"}</DialogTitle>
          <DialogDescription>
            {
              "用 ChisaBot 安卓 App 扫这个二维码，手机就会登录到你的账号并出现在设备列表里。"
            }
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="pair-body">
          <div className={cn("pair-qr", phase.kind === "bound" && "is-bound")}>
            {phase.kind === "pending" ? (
              <PairQr value={qrValue} />
            ) : phase.kind === "loading" ? (
              <div aria-hidden className="pair-qr-skeleton" />
            ) : (
              <div aria-hidden className="pair-qr-skeleton is-still" />
            )}
            {phase.kind === "bound" ? (
              <div className="pair-qr-done" role="status">
                <span className="pair-qr-check">
                  <IconCheck className="size-8" stroke={2.4} />
                </span>
                <b>{phase.name}</b>
                <span>{"已绑定，手机正在进入主机器人"}</span>
              </div>
            ) : null}
            {phase.kind === "paused" || phase.kind === "error" ? (
              <div className="pair-qr-done is-plain">
                <IconQrcode className="size-7 opacity-70" />
                <span>
                  {phase.kind === "paused" ? "二维码已暂停刷新" : phase.message}
                </span>
              </div>
            ) : null}
          </div>

          <div className="pair-meta">
            <span
              aria-live="polite"
              className={cn("device-badge", status.tone)}
            >
              {phase.kind === "pending" ? (
                <span className="device-dot is-ok pair-dot" />
              ) : null}
              <T>{status.text}</T>
            </span>
            {phase.kind === "pending" ? (
              <span className="pair-countdown">{`${mmss(left)} 后自动刷新 · 只能用一次`}</span>
            ) : null}
          </div>

          <ol className="pair-steps">
            <li>
              <IconDeviceMobile aria-hidden className="size-4" />
              <span>
                {"在手机上打开 ChisaBot，登录页点 "}
                <b>{"扫码绑定"}</b>
              </span>
            </li>
            <li>
              <IconQrcode aria-hidden className="size-4" />
              <span>
                {"对准二维码，服务器地址 "}
                <code className="device-code pair-server">{activeServer}</code>
                {" 会自动填好"}
              </span>
            </li>
          </ol>

          {phase.kind === "pending" && alternateOrigins.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{"切换地址："}</span>
              {[server, ...alternateOrigins].map((origin) => {
                const selected = origin === activeServer;
                return (
                  <button
                    key={origin}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setSelectedOrigin(origin === server ? null : origin)
                    }
                    className={cn(
                      "rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors",
                      selected
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border/60 bg-background/60 hover:bg-muted",
                    )}
                  >
                    {origin}
                  </button>
                );
              })}
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter className="pair-footer">
          {phase.kind === "bound" ? (
            <>
              <Button
                onClick={() => {
                  autoRefreshes.current = 0;
                  rotating.current = null;
                  setPhase({ kind: "loading" });
                  issue().catch((error: unknown) => {
                    if (openRef.current) onIssueError(error);
                  });
                }}
                type="button"
                variant="outline"
              >
                {"再绑定一台"}
              </Button>
              <Button onClick={() => onOpenChange(false)} type="button">
                {"完成"}
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                {"关闭"}
              </Button>
              <Button
                disabled={phase.kind === "loading"}
                feedback="refresh"
                onClick={() => void refresh.run()}
                state={refresh.state}
                type="button"
              >
                <IconRefresh />
                {"刷新二维码"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PairPhoneButton({
  size = "sm",
  variant = "outline",
}: {
  size?: "sm" | "default";
  variant?: "outline" | "default";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        size={size}
        type="button"
        variant={variant}
      >
        <IconQrcode />
        {"绑定手机"}
      </Button>
      <PairPhoneDialog onOpenChange={setOpen} open={open} />
    </>
  );
}
