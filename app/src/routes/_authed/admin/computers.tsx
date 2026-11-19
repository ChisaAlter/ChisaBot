import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { ExecutionNodePanel } from "@/components/settings/execution-node-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import {
  forgetOrphanComputerMutationOptions,
  setComputerStateMutationOptions,
} from "@/lib/computers/mutations";
import {
  type ComputerProfile,
  computerFleetQueryOptions,
  sortComputers,
} from "@/lib/computers/queries";

export const Route = createFileRoute("/_authed/admin/computers")({
  component: ComputersPage,
});


function ComputersPage() {
  /** Bot id currently running a stop/reset request. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the browser profile, so it requires confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Updating restarts a running computer mid-task, so it is confirmed too. */
  const [confirmingUpdate, setConfirmingUpdate] = useState<string | null>(null);
  /** Deleting a left-over browser removes its sign-ins for good, so it is confirmed too. */
  const [confirmingForget, setConfirmingForget] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const nameFor = useBotNames();

  const fleet = useQuery(computerFleetQueryOptions());
  const setState = useMutation(setComputerStateMutationOptions(queryClient));
  const forget = useMutation(forgetOrphanComputerMutationOptions(queryClient));

  const computers = fleet.data?.computers ? sortComputers(fleet.data.computers) : null;
  /** 名字：机器人的名字；默认浏览器；已删除的机器人。服务器没说的时候退回旧的按 id 查名字。 */
  const titleOf = (computer: ComputerProfile) =>
    computer.owner === "deleted"
      ? "已删除的机器人"
      : computer.owner === "default"
        ? "默认浏览器"
        : (computer.botName ?? nameFor(computer.botId));
  const titleFor = (botId: string | null) => {
    const found = computers?.find((computer) => computer.botId === botId);
    return found ? titleOf(found) : botId ? nameFor(botId) : "";
  };
  const isolation = fleet.data?.isolation ?? null;
  /*
   * A list that could not be read. A refused stop, reset or update is said beside the buttons
   * instead, because the top of this page is a long scroll away from them.
   */
  const problem = fleet.error ? "无法列出计算机。" : null;

  const runForget = (botId: string) => {
    setBusy(botId);
    forget.mutate(
      { botId },
      {
        onSettled: () => setBusy(null),
        onSuccess: () => setConfirmingForget(null),
      },
    );
  };

  const run = (botId: string, action: "stop" | "reset" | "update") => {
    setBusy(botId);
    setConfirming(null);
    setConfirmingUpdate(null);
    setState.mutate({ action, botId }, { onSettled: () => setBusy(null) });
  };

  return (
    <PageShell
      description={
        "每个机器人的浏览器和它保存的配置文件。配置文件让机器人明天还能保持登录，重置配置文件会让它退出所有内容。"
      }
      title={"云端浏览器"}
    >
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {isolation === "shared" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          {"所有机器人共用这一台云端电脑：登录状态、文件和浏览器配置文件是同一份。一个人自用的部署这样就够了。"}
        </p>
      ) : isolation === "per-bot" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          {
            "每个机器人都有自己的计算机：自己的容器、自己的文件和自己的浏览器配置文件。"
          }
        </p>
      ) : null}

      <ExecutionNodePanel settingItem="computers.execution-nodes" />

      <PageSection title={"此部署中的计算机"}>
        {setState.error || (forget.error && confirmingForget === null) ? (
          <p
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
          >
            {(setState.error ?? forget.error)?.message}
          </p>
        ) : null}
        {computers === null && problem ? (
          <PageEmpty>{"列表无法加载。"}</PageEmpty>
        ) : computers === null ? null : computers.length === 0 ? (
          <PageEmpty>
            {"尚未有计算机。下次机器人打开页面时会出现一个。"}
          </PageEmpty>
        ) : (
          <PageRows>
            {computers.map((computer, index) => (
              <StaggerItem index={index} key={computer.botId}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle title={computer.botId}>
                      {titleOf(computer)}
                    </ItemTitle>
                    {computer.owner === "deleted" ? (
                      <ItemDescription>
                        <span className="font-mono text-xs">{computer.botId}</span>
                        {" · 机器人已经删除，这个浏览器还留着它的配置文件和登录状态。"}
                      </ItemDescription>
                    ) : null}
                    <ItemDescription>
                      {computer.running
                        ? `浏览器运行于 ${new Date(computer.startedAt ?? "").toLocaleTimeString("zh-CN")}`
                        : "没有正在运行的浏览器。下次机器人需要时它会启动。"}
                      {" · "}
                      {computer.egress === undefined
                        ? "出口未报告"
                        : computer.egress === null
                          ? "直接离开"
                          : `通过 ${computer.egress} 离开`}
                      {computer.updateAvailable ? "· 有更新可用" : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {computer.owner === "deleted" ? (
                      <Button
                        disabled={busy === computer.botId}
                        onClick={() => {
                          forget.reset();
                          setConfirmingForget(computer.botId);
                        }}
                        size="sm"
                        variant="outline"
                      >
                        {"删除"}
                      </Button>
                    ) : (
                      <>
                    {computer.updateAvailable ? (
                      <Button
                        disabled={busy === computer.botId}
                        onClick={() => setConfirmingUpdate(computer.botId)}
                        size="sm"
                        variant="outline"
                      >
                        {"更新计算机"}
                      </Button>
                    ) : null}
                    <Button
                      disabled={busy === computer.botId || !computer.running}
                      onClick={() => void run(computer.botId, "stop")}
                      size="sm"
                      variant="outline"
                    >
                      {busy === computer.botId ? "正在处理中…" : "停止浏览器"}
                    </Button>
                    <Button
                      disabled={busy === computer.botId}
                      onClick={() => setConfirming(computer.botId)}
                      size="sm"
                      variant="outline"
                    >
                      {"重置"}
                    </Button>
                      </>
                    )}
                  </ItemActions>
                </Item>
                {index !== computers.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      {/*
       * A DIALOG RATHER THAN AN INLINE CONFIRM. Resetting signs a Bot out of everything it has ever
       * logged into and cannot be undone, and the row it was confirmed on was one of several
       * identical-looking rows. The dialog names the Bot, so the sentence somebody agrees to says
       * which computer it destroys.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={confirming !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {`重置「${titleFor(confirming)}」的浏览器？`}
            </DialogTitle>
            <DialogDescription>
              {
                "它的配置文件被删除，因此机器人已从它登录的每个服务中注销并开始干净。这不能被撤销。"
              }
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirming(null)}
              size="sm"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              disabled={busy === confirming}
              onClick={() => {
                if (confirming) void run(confirming, "reset");
              }}
              size="sm"
              variant="destructive"
            >
              {busy === confirming ? "正在重置…" : "重置它"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingUpdate(null);
        }}
        open={confirmingUpdate !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {`更新「${titleFor(confirmingUpdate)}」的计算机？`}
            </DialogTitle>
            <DialogDescription>
              {
                "它移动到此部署现在运行的计算机镜像上。它的文件和登录被保留。如果它正在运行，它会重新启动，这会中断它当前正在做的任何事情。"
              }
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirmingUpdate(null)}
              size="sm"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              disabled={busy === confirmingUpdate}
              onClick={() => {
                if (confirmingUpdate) void run(confirmingUpdate, "update");
              }}
              size="sm"
            >
              {busy === confirmingUpdate ? "更新中…" : "更新它"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open && busy !== confirmingForget) setConfirmingForget(null);
        }}
        open={confirmingForget !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{"删除这个浏览器？"}</DialogTitle>
            <DialogDescription>
              {
                "它属于一个已经删除的机器人。浏览器的配置文件、登录状态（cookies）和接管记录会一起删除，不能撤销。"
              }
            </DialogDescription>
          </DialogHeader>
          {confirmingForget ? (
            <p className="font-mono text-muted-foreground text-xs">
              {confirmingForget}
            </p>
          ) : null}
          {forget.error && confirmingForget !== null ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
              role="alert"
            >
              {forget.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={busy === confirmingForget}
              onClick={() => setConfirmingForget(null)}
              size="sm"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              disabled={busy === confirmingForget}
              onClick={() => {
                if (confirmingForget) runForget(confirmingForget);
              }}
              size="sm"
              variant="destructive"
            >
              {busy === confirmingForget ? "正在删除…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="mt-4 text-muted-foreground text-sm">
        <strong>{"停止"}</strong>{" "}
        {
          "关闭浏览器并保留其登录信息：机器人接下来要做的第一件事是在它离开的地方重新启动它。"
        }{" "}
        <strong>{"重置"}</strong>{" "}
        {"删除配置文件，这样机器人退出所有内容并干净开始。"}
        <strong>{"删除"}</strong>{" "}
        {"只出现在已删除的机器人留下的浏览器上：连同它的登录状态一起删掉。删除机器人时它的浏览器会自动删除。"}
        <strong>{"更新计算机"}</strong>{" "}
        {
          "当计算机运行比此部署更旧的镜像时出现，并将其移动到新版本，保留其文件和登录记录。三者都记录在"
        }{" "}
        <Link className="underline" to="/admin/audit">
          {"审计"}
        </Link>
        .
      </p>
    </PageShell>
  );
}
