import { IconLock } from "@tabler/icons-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { ToolRenderProps } from "@/lib/chat/renderers";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { readSignIn, requestSignIn } from "@/lib/passwords/mutations";
import { FINAL_SIGN_IN } from "@/lib/passwords/queries";
import { useActiveBotHolder } from "./active-bot";
import { useComputerToolRenderer } from "./approval-tools";
import { useComputerAvailable } from "./computer-available";

/** How long the open chat waits for the person to answer. The server's request lasts as long. */
const WAIT_MS = 15 * 60_000;
const POLL_MS = 1_500;

/** Must match SIGN_IN_TOOL_DESCRIPTION in server/src/computer/headless-tools.ts. */
const DESCRIPTION =
  "Ask the person you work for to sign you in to a website. They get a private sign-in form outside this conversation (or take over the browser), and their login is typed straight into your browser by the computer. You never see the username, password or code, and must never ask for them any other way. Open the site's sign-in page first, then call this with the site's address. This turn pauses until they answer; you are then told only whether it worked.";

type Outcome = {
  ok?: boolean;
  signedIn?: boolean;
  site?: string;
  requestId?: string;
  result?: string;
  reason?: string;
};

function parse(result: string | undefined): Outcome {
  if (!result) return {};
  try {
    const value = JSON.parse(result) as unknown;
    return value && typeof value === "object" ? (value as Outcome) : {};
  } catch {
    return {};
  }
}

/**
 * The open chat's half of `computer_request_sign_in`.
 *
 * The handler opens the request and waits on it; the render draws a card whose button opens the
 * private form in a dialog. The form posts to the server, never into this tool call, so neither the
 * arguments nor the result the model reads ever carry a credential. An unattended turn uses the
 * headless tool of the same name, and its owner gets the form as a link on their delivery channels.
 */
export function SignInTool() {
  useComputerToolRenderer({
    name: "computer_request_sign_in",
    parameters: z.object({
      site: z
        .string()
        .describe("The website's address, e.g. https://example.com"),
      reason: z
        .string()
        .optional()
        .describe("Why you need to be signed in, in a few words"),
    }),
    render: SignInCall,
  });
  return null;
}

function SignInCall({ args, result, status, toolCallId }: ToolRenderProps<{ site: string; reason?: string }>) {
  const requests = useQuery({ queryKey: ["passwords", "pending"], enabled: result === undefined, refetchInterval: result === undefined ? 1500 : false,
    queryFn: async () => (await client("/api/sign-in-requests")).json() as Promise<{ requests: { id: string; toolCallId?: string }[] }>,
  });
  const outcome = parse(result);
  const requestId = outcome.requestId ?? requests.data?.requests.find(request => request.toolCallId === toolCallId)?.id;
  return <SignInCard site={args.site ?? ""} requestId={requestId} running={status !== "complete"} outcome={outcome} />;
}

function SignInCard({
  site,
  requestId,
  running,
  outcome,
}: {
  site: string;
  requestId?: string;
  running: boolean;
  outcome: Outcome;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <ToolLine
        label={
          running ? "等待您登录" : outcome.signedIn ? "已登录" : "登录未完成"
        }
        detail={site}
        running={running}
        failed={!running && !outcome.signedIn}
      >
        {!running && (outcome.result ?? outcome.reason) ? (
          <p className="text-muted-foreground text-sm">
            {outcome.result ?? outcome.reason}
          </p>
        ) : undefined}
      </ToolLine>
      {/* Outside the line, so the one thing the person must do is not behind a disclosure. */}
      {running && requestId ? (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            <IconLock />
            {"打开私有登录"}
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {"登录到"}
                  {site}
                </DialogTitle>
                <DialogDescription>
                  {"在您的机器人浏览器中打开，不进入此对话。"}
                </DialogDescription>
              </DialogHeader>
              <DialogBody className="mt-4 overflow-y-auto">
                <SignInForm requestId={requestId} />
              </DialogBody>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </div>
  );
}
