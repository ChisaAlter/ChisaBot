import { expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import { createImService } from "../src/im/service";
import type { WsLike } from "../src/im/types";

test("撤销 IM 白名单后丢弃排队消息、在途回答和后续主动推送", async () => {
  const row = {
    id: "im_revoked123",
    owner_user_id: "owner",
    platform: "onebot",
    name: "test",
    agent_id: "bot",
    enabled: true,
    config: { mode: "forward", url: "ws://protocol.test" },
    secrets: null,
    allow_users: ["guest"],
    owner_users: ["owner"],
    allow_devices: false,
    allow_private: false,
    account: null,
    last_message_at: null,
    last_error: null,
    created_at: new Date(),
  };
  let lastInbound: unknown;
  const logs: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const turns: string[] = [];
  let finishTurn = () => {};
  const blocked = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  let socket: WsLike;
  const outgoing = new Map<string, Record<string, unknown>>();
  const database = {
    $client: {
      begin: async (run: (tx: Database["$client"]) => Promise<unknown>) =>
        run(database.$client),
      reserve: async () => ({
        unsafe: database.$client.unsafe,
        release: () => {},
      }),
      unsafe: async (query: string, args: unknown[] = []) => {
        if (query.includes("pg_try_advisory_lock")) return [{ locked: true }];
        if (query.startsWith("INSERT INTO chisabot_im_outbox")) {
          outgoing.set(String(args[0]), {
            id: args[0],
            connection_id: args[1],
            owner_user_id: args[2],
            agent_id: args[3],
            thread_id: args[4],
            inbound: JSON.parse(String(args[5])),
            text: args[6],
            chunks: JSON.parse(String(args[7])),
            state: "queued",
          });
        }
        if (query.startsWith("SELECT * FROM chisabot_im_outbox")) {
          const record = outgoing.get(String(args[0]));
          return record ? [record] : [];
        }
        if (query.startsWith("UPDATE chisabot_im_outbox")) {
          const record = outgoing.get(String(args[0]));
          if (record) {
            record.state = query.match(/SET state='([^']+)'/)?.[1];
            return [{ id: record.id }];
          }
        }
        if (query.startsWith("SELECT * FROM chisabot_im_connections"))
          return [{ ...row }];
        if (query.startsWith("INSERT INTO chisabot_im_logs"))
          logs.push(String(args[2]));
        if (query.startsWith("UPDATE chisabot_im_connections SET name")) {
          row.allow_users = args[6] ? JSON.parse(String(args[6])) : [];
          row.owner_users = args[9] ? JSON.parse(String(args[9])) : [];
        }
        if (query.startsWith("UPDATE chisabot_im_chats SET last_inbound"))
          lastInbound = JSON.parse(String(args[2]));
        if (query.includes("SELECT connection_id,last_inbound FROM"))
          return [{ connection_id: row.id, last_inbound: lastInbound }];
        return [];
      },
    },
  } as unknown as Database;
  const service = createImService({
    database,
    encryptionKey: "unused",
    botAvailable: async () => true,
    resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
    resolveBotConversation: async () => "thread",
    runTurn: async (input) => {
      turns.push(String(input.instruction));
      if (turns.length === 1) await blocked;
      return { replyText: "回复" };
    },
    ws: () => {
      socket = {
        readyState: 1,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(data) {
          const message = JSON.parse(String(data));
          sent.push(message);
          queueMicrotask(() =>
            socket.onmessage?.({
              data: JSON.stringify({
                echo: message.echo,
                status: "ok",
                retcode: 0,
                data:
                  message.action === "get_login_info" ? { user_id: "bot" } : {},
              }),
            }),
          );
        },
        close() {
          socket.readyState = 3;
          socket.onclose?.({ code: 1000 });
        },
      };
      queueMicrotask(() => socket.onopen?.({}));
      return socket;
    },
  });
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("condition timed out");
      await Bun.sleep(5);
    }
  };
  const message = (id: number, user = "guest") =>
    socket.onmessage?.({
      data: JSON.stringify({
        post_type: "message",
        message_type: "private",
        self_id: "bot",
        user_id: user,
        message_id: id,
        message: `消息${id}`,
      }),
    });
  try {
    await service.startAll();
    message(1);
    await waitFor(() => turns.length === 1);
    message(2);
    await waitFor(
      () => logs.filter((line) => line.startsWith("收到 ")).length === 2,
    );
    await service.update("owner", row.id, { allowUsers: [] });
    finishTurn();
    await Bun.sleep(50);
    expect(turns).toHaveLength(1);
    expect(
      sent.filter((frame) => frame.action === "send_private_msg"),
    ).toHaveLength(0);
    await expect(service.pushToThread("thread", "主动消息")).rejects.toThrow(
      "已不在可用名单",
    );
    message(3, "owner");
    await waitFor(() =>
      sent.some((frame) => frame.action === "send_private_msg"),
    );
    expect(turns).toHaveLength(2);
  } finally {
    finishTurn();
    await service.stopAll();
  }
});
