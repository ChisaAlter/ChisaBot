import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { wakeUpTools } from "../src/agents/wake-up";
import {
  ComputerUnavailableError,
  ElementNotFoundError,
  NavigationRefusedError,
  PageTimeoutError,
  StaleSnapshotError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
  WorkspaceTooLargeError,
} from "../src/computer/client";
import { ActionRefusedError } from "../src/computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "../src/computer/headless-tools";
import { createConversationSurfaceTools } from "../src/conversations/surface-tools";
import {
  createDshToolGateway,
  isPreEffectFailure,
  isPromotableReadTool,
} from "../src/conversations/tool-gateway";
import type { ToolOperationStore } from "../src/conversations/tool-operations";
import { deviceTools } from "../src/devices/tools";
import { renderUiTools } from "../src/generative-ui/render-ui";
import type { GrantedTool } from "../src/plugins/tools";

function createFakeOperations() {
  const settled: {
    id: string;
    status: string;
    result: { content: string; error?: string };
  }[] = [];
  const store = {
    async claim() {
      return { kind: "claimed" as const, id: "op-1" };
    },
    async settle(
      id: string,
      status: string,
      result: { content: string; error?: string },
    ) {
      settled.push({ id, status, result });
    },
    async waitingForConfirmation() {},
    async markOutcomeUnknown() {},
    async markRunOutcomeUnknown() {},
    async listUnknown() {
      return [];
    },
    async resumeConfirmation() {
      return { kind: "claimed" as const, id: "op-1" };
    },
  } as unknown as ToolOperationStore;
  return { store, settled };
}

async function runSingleTool(tool: GrantedTool, args: Record<string, unknown>) {
  const { store, settled } = createFakeOperations();
  const gateway = createDshToolGateway(store);
  const binding = {
    sessionId: "sess-1",
    runId: "run-1",
    threadId: "thread-1",
    botId: "bot-1",
    actorId: "user-1",
    revision: 1,
    generation: "gen-1",
  };
  const { capability, close } = gateway.register({
    bindingId: "bind-1",
    identity: binding,
    input: {
      threadId: "thread-1",
      runId: "run-1",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    signal: new AbortController().signal,
    tools: [tool],
    continuationMessages: async () => [
      {
        id: "ast-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "sess-1:1:1:call-1",
            type: "function",
            function: {
              name: tool.name,
              arguments: JSON.stringify(args),
            },
          },
        ],
      },
    ],
  });
  try {
    const response = await gateway.routes.request("/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${capability}`,
      },
      body: JSON.stringify({
        binding,
        callId: "call-1",
        name: tool.name,
        args,
        turn: 1,
        step: 1,
        throughSeq: 1,
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body, settled };
  } finally {
    close();
  }
}

describe("ToolGateway read-only & pre-effect failure settlement", () => {
  test("computer_list_files({ path: '/' }) throwing WorkspaceRequestError settles as failed instead of outcome_unknown", async () => {
    const fakeGateway = {
      listFiles: async () => {
        throw new WorkspaceRequestError(
          "Use a path relative to your workspace, not an absolute one.",
        );
      },
    } as unknown as Parameters<
      typeof createHeadlessComputerTools
    >[0]["gateway"];
    const headlessTools = createHeadlessComputerTools({
      gateway: fakeGateway,
      botId: "bot-1",
      actor: { id: "user-1" },
    });
    const listFiles = headlessTools.find(
      (t) => t.definition.name === "computer_list_files",
    );
    expect(listFiles?.effect).toBe("read");
    const granted: GrantedTool = {
      name: listFiles?.definition.name ?? "computer_list_files",
      description: listFiles?.definition.description ?? "",
      parameters: z.object({ path: z.string().optional() }),
      ...(listFiles?.effect ? { effect: listFiles.effect } : {}),
      execute: async (args, ctx) =>
        JSON.stringify(
          await listFiles?.execute(args, {
            toolCallId: "sess-1:1:1:call-1",
            signal: ctx?.signal ?? new AbortController().signal,
          }),
        ),
    };
    expect(isPromotableReadTool(granted)).toBe(true);
    const { status, body, settled } = await runSingleTool(granted, {
      path: "/",
    });
    expect(status).toBe(200);
    expect(body.error).toBe(
      "Use a path relative to your workspace, not an absolute one.",
    );
    expect(String(body.content)).toContain("工具未完成：");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe("failed");
  });

  test("declared read tool throwing a generic runtime error settles as failed (never outcome_unknown)", async () => {
    const readTool: GrantedTool = {
      name: "computer_read_file",
      ref: "computer/read_file",
      effect: "read",
      description: "Read a workspace file",
      parameters: z.object({ path: z.string() }),
      execute: async () => {
        throw new Error("transient transport glitch");
      },
    };
    const { status, body, settled } = await runSingleTool(readTool, {
      path: "notes.md",
    });
    expect(status).toBe(200);
    expect(body.error).toBe("transient transport glitch");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe("failed");
  });

  test("mutating tools throwing pre-effect validation/refusal errors settle as failed so model can self-correct", async () => {
    const preEffectErrors = [
      new WorkspaceRequestError(
        "Use a path relative to your workspace, not an absolute one.",
      ),
      new WorkspaceRefusedError("Path escapes workspace."),
      new WorkspaceNotFoundError("File does not exist."),
      new WorkspaceTooLargeError("File exceeds download limit."),
      new ActionRefusedError("Blocked by policy."),
      new StaleSnapshotError("Page changed before click."),
      new ElementNotFoundError("Element ref e4 is gone."),
      new NavigationRefusedError("Private host blocked."),
    ];

    for (const err of preEffectErrors) {
      expect(isPreEffectFailure(err)).toBe(true);
      const writeTool: GrantedTool = {
        name: "computer_write_file",
        ref: "computer/write_file",
        description: "Write a file",
        parameters: z.object({ path: z.string(), content: z.string() }),
        execute: async () => {
          throw err;
        },
      };
      const { status, settled } = await runSingleTool(writeTool, {
        path: "/bad",
        content: "x",
      });
      expect(status).toBe(200);
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe("failed");
    }
  });

  test("mutating tools throwing uncertain post-dispatch errors STILL settle as outcome_unknown (202 interrupt)", async () => {
    const uncertainErrors = [
      new ComputerUnavailableError("Connection reset mid-write"),
      new PageTimeoutError("Timed out after clicking submit"),
      new Error("socket hang up"),
    ];

    for (const err of uncertainErrors) {
      expect(isPreEffectFailure(err)).toBe(false);
      const writeTool: GrantedTool = {
        name: "computer_write_file",
        ref: "computer/write_file",
        description: "Write a file",
        parameters: z.object({ path: z.string(), content: z.string() }),
        execute: async () => {
          throw err;
        },
      };
      const { status, body, settled } = await runSingleTool(writeTool, {
        path: "ok.txt",
        content: "x",
      });
      expect(status).toBe(202);
      expect((body.waiting as { kind?: string } | undefined)?.kind).toBe(
        "operation_unknown",
      );
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe("outcome_unknown");
    }
  });

  test("resumeConfirmation settles pre-effect failure as failed and uncertain write failure as outcome_unknown", async () => {
    const { store, settled } = createFakeOperations();
    const gateway = createDshToolGateway(store);
    const baseSnapshot = {
      threadId: "thread-1",
      runId: "run-1",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      toolCallId: "sess-1:1:1:call-1",
      toolName: "computer_write_file",
      args: { path: "/abs" },
    };

    const validationResult = await gateway.resumeConfirmation({
      ownerUserId: "user-1",
      requestId: "req-1",
      approved: true,
      snapshot: baseSnapshot,
      tools: [
        {
          name: "computer_write_file",
          description: "write",
          parameters: z.object({ path: z.string() }),
          execute: async () => {
            throw new WorkspaceRequestError("absolute path rejected");
          },
        },
      ],
      signal: new AbortController().signal,
    });
    expect(validationResult.error).toBe("absolute path rejected");
    expect(settled[0]?.status).toBe("failed");

    await expect(
      gateway.resumeConfirmation({
        ownerUserId: "user-1",
        requestId: "req-2",
        approved: true,
        snapshot: baseSnapshot,
        tools: [
          {
            name: "computer_write_file",
            description: "write",
            parameters: z.object({ path: z.string() }),
            execute: async () => {
              throw new Error("network died mid-write");
            },
          },
        ],
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HeadlessToolSuspension);
    expect(settled[1]?.status).toBe("outcome_unknown");
  });

  test("built-in read-only tools declare effect='read' while mutating tools do not", async () => {
    const computerTools = createHeadlessComputerTools({
      gateway: {} as Parameters<
        typeof createHeadlessComputerTools
      >[0]["gateway"],
      botId: "bot-1",
      actor: { id: "user-1" },
    });
    const byName = new Map(
      computerTools.map((t) => [t.definition.name, t.effect]),
    );
    for (const readName of [
      "computer_read",
      "computer_snapshot",
      "computer_screenshot",
      "computer_scroll",
      "computer_list_files",
      "computer_read_file",
    ]) {
      expect(byName.get(readName)).toBe("read");
    }
    for (const writeName of [
      "computer_navigate",
      "computer_click",
      "computer_type",
      "computer_write_file",
      "computer_run_command",
      "computer_tabs",
    ]) {
      expect(byName.get(writeName)).not.toBe("read");
    }

    const surface = await createConversationSurfaceTools({
      actor: { id: "u1", role: "user" } as Parameters<
        typeof createConversationSurfaceTools
      >[0]["actor"],
      botId: "b1",
      plugins: {
        listForAgent: async () => ({
          skills: [{ slug: "skill-creator" }],
          tools: [],
        }),
      } as unknown as Parameters<
        typeof createConversationSurfaceTools
      >[0]["plugins"],
      components: {
        listForAgent: async () => [],
      } as unknown as Parameters<
        typeof createConversationSurfaceTools
      >[0]["components"],
      sandboxed: {
        published: async () => [],
      } as unknown as Parameters<
        typeof createConversationSurfaceTools
      >[0]["sandboxed"],
      interactions: {} as Parameters<
        typeof createConversationSurfaceTools
      >[0]["interactions"],
    });
    const surfaceByName = new Map(
      surface.map((t) => [t.definition.name, t.effect]),
    );
    for (const readSurface of [
      "list_skills",
      "read_skill",
      "list_skill_tools",
    ]) {
      expect(surfaceByName.get(readSurface)).toBe("read");
    }

    const wake = wakeUpTools({
      store: {} as Parameters<typeof wakeUpTools>[0]["store"],
      ownerUserId: "u1",
      agentId: "b1",
    });
    expect(wake.find((t) => t.name === "list_follow_ups")?.effect).toBe("read");
    expect(wake.find((t) => t.name === "schedule_follow_up")?.effect).not.toBe(
      "read",
    );
    expect(wake.find((t) => t.name === "cancel_follow_up")?.effect).not.toBe(
      "read",
    );

    expect(renderUiTools()[0]?.effect).toBe("read");

    const dev = deviceTools({
      store: { forOwner: async () => [] } as unknown as Parameters<
        typeof deviceTools
      >[0]["store"],
      hub: {
        isOnline: () => true,
        supports: () => true,
      } as unknown as Parameters<typeof deviceTools>[0]["hub"],
      botId: "b1",
      actorId: "u1",
      devices: [
        {
          id: "d1",
          ownerUserId: "u1",
          name: "MyPC",
          platform: "win32",
          osVersion: "Win11",
          clientVersion: "0.1.50",
          hostname: "pc",
          paused: false,
          revoked: false,
          allowedRoots: ["C:\\work"],
          fullAccessUntil: null,
          lastSeenAt: new Date().toISOString(),
          capabilities: {
            shell: "allow",
            list_files: "allow",
            read_file: "allow",
            write_file: "allow",
            edit_file: "allow",
            screenshot: "allow",
            input: "allow",
            open: "allow",
            clipboard_read: "allow",
            clipboard_write: "allow",
            file_upload: "allow",
            file_download: "allow",
            mcp_discover: "allow",
          },
        } as unknown as Parameters<typeof deviceTools>[0]["devices"][number],
      ],
    });
    const devByName = new Map(dev.map((t) => [t.name, t.effect]));
    for (const readDev of [
      "device_list",
      "device_system_info",
      "device_shell_output",
      "device_list_files",
      "device_read_file",
      "device_search",
      "device_screenshot",
      "device_desktop_context",
      "device_mcp_discover",
    ]) {
      expect(devByName.get(readDev)).toBe("read");
    }
    for (const writeDev of [
      "device_run_shell",
      "device_shell_kill",
      "device_write_file",
      "device_edit_file",
      "device_apply_patch",
      "device_git",
      "device_processes",
      "device_clipboard",
      "device_windows",
      "device_mcp_call",
      "device_input",
      "device_open",
    ]) {
      expect(devByName.get(writeDev)).not.toBe("read");
    }
  });
});
