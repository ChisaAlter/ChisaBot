import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { parsePersonalDeliveryEvidence } from "../../shared/personal-sources";
import {
  withConfirmToolCall,
  withConfirmTurn,
} from "../src/confirmations/context";
import { createDatabase } from "../src/db/client";
import {
  DeliveryOutcomeUnknownError,
  DeliveryRejectedError,
} from "../src/delivery/durable-dispatch";
import { createImDelivery } from "../src/im/delivery";
import { parseIcsEvents } from "../src/personal-sources/calendar";
import { createPersonalDelivery } from "../src/personal-sources/delivery";
import { sendWebhook } from "../src/personal-sources/notify";
import { createPersonalSources } from "../src/personal-sources/service";
import { smtpFailure } from "../src/personal-sources/smtp";
import { REFUSAL_MARKER } from "../src/plugins/tools";
import { testDatabaseUrl } from "./support/database";

const ics = (...events: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((event) => ["BEGIN:VEVENT", event, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");
describe("personal calendar semantics", () => {
  test("RRULE preserves wall time across DST and applies EXDATE and moved occurrence", () => {
    const result = parseIcsEvents(
      ics(
        "UID:series\r\nDTSTART;TZID=America/New_York:20260307T090000\r\nDTEND;TZID=America/New_York:20260307T100000\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEXDATE;TZID=America/New_York:20260309T090000\r\nSUMMARY:Daily",
        "UID:series\r\nRECURRENCE-ID;TZID=America/New_York:20260310T090000\r\nDTSTART;TZID=America/New_York:20260310T110000\r\nDTEND;TZID=America/New_York:20260310T120000\r\nSUMMARY:Moved",
      ),
      {
        from: new Date("2026-03-07T00:00:00Z"),
        to: new Date("2026-03-11T00:00:00Z"),
      },
    );
    expect(result.map((e) => e.startIso)).toEqual([
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-10T15:00:00.000Z",
    ]);
    expect(result[2]?.summary).toBe("Moved");
    expect(new Set(result.map((e) => e.uid)).size).toBe(3);
  });
  test("floating time uses chosen zone, all-day preserves date, cancellation is omitted", () => {
    const result = parseIcsEvents(
      ics(
        "UID:floating\r\nDTSTART:20261108T090000\r\nDTEND:20261108T100000\r\nSUMMARY:Floating",
        "UID:day\r\nDTSTART;VALUE=DATE:20261108\r\nDTEND;VALUE=DATE:20261109\r\nSUMMARY:Day",
        "UID:cancel\r\nDTSTART:20261108T090000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelled",
      ),
      {
        from: new Date("2026-11-07Z"),
        to: new Date("2026-11-10Z"),
        timeZone: "Asia/Tokyo",
      },
    );
    expect(result).toHaveLength(2);
    expect(result.find((e) => e.uid === "floating")?.startIso).toBe(
      "2026-11-08T00:00:00.000Z",
    );
    expect(result.find((e) => e.uid === "day")).toMatchObject({
      allDay: true,
      startDate: "2026-11-08",
    });
  });
  test("cancelled recurrence override does not leak the original occurrence", () => {
    const result = parseIcsEvents(
      ics(
        "UID:s\r\nDTSTART:20261108T090000Z\r\nDTEND:20261108T100000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Daily",
        "UID:s\r\nRECURRENCE-ID:20261109T090000Z\r\nDTSTART:20261109T090000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancel",
      ),
      { from: new Date("2026-11-08Z"), to: new Date("2026-11-11Z") },
    );
    expect(result).toHaveLength(1);
  });
});

describe("transport acceptance", () => {
  test("HTTP 200 business rejection fails; missing receipt is uncertain; success is explicit", async () => {
    const input = {
      url: "https://open.feishu.cn/hook/test",
      kind: "feishu" as const,
      title: "Test",
      body: "fixture",
      id: "fixture",
    };
    await expect(
      sendWebhook({
        ...input,
        fetchImpl: (async () => Response.json({ code: 19024 })) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DeliveryRejectedError);
    await expect(
      sendWebhook({
        ...input,
        fetchImpl: (async () => Response.json({ ok: true })) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
    await expect(
      sendWebhook({
        ...input,
        fetchImpl: (async () => {
          throw new Error("socket lost");
        }) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(
      await sendWebhook({
        ...input,
        fetchImpl: (async () =>
          Response.json({
            code: 0,
            data: { message_id: "accepted-1" },
          })) as typeof fetch,
      }),
    ).toEqual(["accepted-1"]);
  });
  test("SMTP refusal/preconnect is rejected; loss after DATA is uncertain", () => {
    expect(smtpFailure({ command: "AUTH", responseCode: 535 })).toBeInstanceOf(
      DeliveryRejectedError,
    );
    expect(smtpFailure({ command: "CONN", code: "ETIMEDOUT" })).toBeInstanceOf(
      DeliveryRejectedError,
    );
    expect(smtpFailure({ command: "DATA", code: "ETIMEDOUT" })).toBeInstanceOf(
      DeliveryOutcomeUnknownError,
    );
    expect(
      smtpFailure({ command: "DATA", code: "ECONNECTION" }),
    ).toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(parsePersonalDeliveryEvidence("已发送成功")).toBeNull();
  });
});

(process.env.TEST_DATABASE_URL ? describe : describe.skip)(
  "personal sources durable integration",
  () => {
    const owner = `personal-test-${randomUUID()}`;
    const db = createDatabase(testDatabaseUrl(), { max: 6 });
    const store = createPersonalDelivery(db);
    let mailFails = false,
      webhookMode = "accepted",
      sends = 0,
      emailSends = 0;
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).includes("notify.example.com")) {
        sends++;
        if (webhookMode === "unknown") throw new Error("receipt lost");
        if (webhookMode === "limited")
          return new Response("rate limited", { status: 429 });
        return Response.json({ code: 0 });
      }
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const service = createPersonalSources(db, {
      encryptionKey: "fixture-only",
      fetchFn,
      readInbox: async () => {
        if (mailFails) throw new Error("IMAP down");
        return [
          {
            seq: 1,
            subject: "Fixture",
            from: "sender@example.com",
            date: new Date().toISOString(),
            unread: true,
          },
        ];
      },
      sendMail: async (message) => {
        emailSends++;
        expect(message.port).toBe(587);
        return ["smtp-accepted"];
      },
    });
    const app = service.routes(async (c, next) => {
      c.set("actor", { id: owner } as any);
      await next();
    });
    const request = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    beforeAll(async () => {
      await service.ensure();
    });
    afterAll(async () => {
      await db.$client.unsafe(
        "DELETE FROM chisabot_personal_deliveries WHERE owner_user_id=$1",
        [owner],
      );
      await db.$client.unsafe(
        "DELETE FROM chisabot_personal_sources WHERE owner_user_id=$1",
        [owner],
      );
      await db.$client.unsafe(
        "DELETE FROM chisabot_im_outbox WHERE owner_user_id=$1",
        [owner],
      );
      await db.$client.close();
    });
    test("real connection routes reject demos; credentials never enter tool schema or response", async () => {
      expect((await request("/calendar", { urlOrIcs: "demo" })).status).toBe(
        400,
      );
      expect((await request("/notify-webhook", { url: "demo" })).status).toBe(
        400,
      );
      expect(
        (
          await request("/email", {
            email: "test@example.com",
            imapHost: "demo.imap.local",
            password: "fixture-pass",
          })
        ).status,
      ).toBe(400);
      for (const name of [
        "calendar_connect",
        "email_connect",
        "notify_webhook_connect",
        "webhook_trigger_info",
      ]) {
        const tool = service.tools(owner).find((t) => t.name === name)!;
        expect(
          tool.parameters.safeParse({
            password: "secret",
            url: "https://private.example/token",
          }).success,
        ).toBe(false);
        expect(await tool.execute({})).toContain(
          "/settings/connected-accounts",
        );
      }
      const response = await request("/email", {
        email: "fixture@outlook.com",
        imapHost: "outlook.office365.com",
        password: "fixture-pass",
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("fixture-pass");
      const [cache] = await db.$client.unsafe(
        "SELECT jsonb_typeof(cached_emails) AS type FROM chisabot_personal_sources WHERE owner_user_id=$1",
        [owner],
      );
      expect(cache.type).toBe("array");
    });
    test("cache failures remain visible to chat/brief and cannot be scanned as fresh", async () => {
      mailFails = true;
      const read = await service.readEmails(owner);
      expect(read.state).toBe("cached");
      expect(read.items[0]?.subject).toBe("Fixture");
      const scanError = await service.scanEmails(owner).then(
        () => null,
        (error) => error,
      );
      expect(scanError?.message).toContain("收件箱读取失败");
      const tool = service
        .tools(owner)
        .find((t) => t.name === "email_list_recent")!;
      const result = await tool.execute({});
      expect(result).toContain("上次缓存");
      expect(result.startsWith(REFUSAL_MARKER)).toBe(true);
      const brief = await service.generateMorningBrief(owner);
      expect(brief.weather).toContain("无法获取");
      expect(brief.weather).not.toContain("22");
      expect(brief.markdown).toContain("上次缓存");
      const response = await request("/check-updates", {});
      expect(((await response.json()) as any).markdown).toContain("读取失败");
      mailFails = false;
    });
    test("stable notification id has one send and typed receipt, including two competing dispatchers", async () => {
      await service.connectNotifyWebhook(owner, {
        url: "https://notify.example.com/token/private",
        label: "Fixture target",
      });
      const before = sends;
      await Promise.all([
        service.notify(owner, { id: "one", message: "once" }),
        service.notify(owner, { id: "one", message: "once" }),
      ]);
      expect(sends - before).toBe(1);
      const receipt = await store.accepted(`personal:${owner}:one`);
      expect(
        parsePersonalDeliveryEvidence(JSON.stringify(receipt))?.state,
      ).toBe("accepted");
      expect((await service.status(owner)).deliveries?.[0]?.state).toBe("sent");
    });
    test("ambiguous notification cannot automatically retry; interrupted sending is fenced", async () => {
      webhookMode = "unknown";
      const before = sends;
      expect(
        (await service.notify(owner, { id: "unknown", message: "uncertain" }))
          .state,
      ).toBe("outcome_unknown");
      await service.notify(owner, { id: "unknown", message: "uncertain" });
      await service.flushNotifications();
      expect(sends - before).toBe(1);
      const status = await service.status(owner);
      const id = await store.stage(
        owner,
        "notify",
        status.notifyWebhook!.connectedAt,
        { target: "Fixture target", title: "Interrupted", body: "maybe" },
        { id: "interrupted" },
      );
      await db.$client.unsafe(
        "UPDATE chisabot_personal_deliveries SET state='sending' WHERE id=$1",
        [id],
      );
      await service.flushNotifications();
      expect((await store.get(id))?.state).toBe("outcome_unknown");
      expect(sends - before).toBe(1);
      webhookMode = "accepted";
    });
    test("changed target cancels queued delivery and SMTP tool returns exact persisted evidence", async () => {
      const status = await service.status(owner);
      const id = await store.stage(
        owner,
        "notify",
        status.notifyWebhook!.connectedAt,
        { target: "Fixture target", title: "Old", body: "old" },
        { id: "old" },
      );
      await service.connectNotifyWebhook(owner, {
        url: "https://notify.example.com/new",
        label: "New target",
      });
      await service.flushNotifications();
      expect((await store.get(id))?.state).toBe("cancelled");
      const tool = service.tools(owner).find((t) => t.name === "email_send")!;
      const send = () =>
        withConfirmTurn(
          { threadId: "thread", runId: "run", stopped: () => false },
          () =>
            withConfirmToolCall("smtp-call", "email_send", () =>
              tool.execute({
                to: "recipient@example.com",
                subject: "Approved",
                body: "Fixture mail",
              }),
            ),
        );
      const first = await send();
      expect(parsePersonalDeliveryEvidence(first)?.channel).toBe("smtp");
      expect(await send()).toBe(first);
      expect(emailSends).toBe(1);
      expect(
        (await store.get(parsePersonalDeliveryEvidence(first)!.id))?.state,
      ).toBe("sent");
    });
    test("existing IM dispatcher retains concurrency and uncertain-send fencing", async () => {
      const im = createImDelivery(db);
      await im.ensure();
      const id = `${owner}-im`;
      let count = 0;
      await im.stage({
        id,
        owner_user_id: owner,
        connection_id: "conn",
        agent_id: "bot",
        thread_id: "thread",
        inbound: {} as any,
        text: "fixture",
        chunks: ["fixture"],
      });
      const target = async () => ({
        send: async () => {
          count++;
          await Bun.sleep(20);
          throw new Error("lost receipt");
        },
      });
      await Promise.all([im.dispatch(id, target), im.dispatch(id, target)]);
      await im.dispatch(id, target);
      expect(count).toBe(1);
      expect((await im.get(id))?.state).toBe("outcome_unknown");
    });
    test("explicit rate limit retries only unattended notifications, with persisted bounded backoff", async () => {
      webhookMode = "limited";
      const before = sends;
      const id = `personal:${owner}:limited`;
      expect(
        (await service.notify(owner, { id: "limited", message: "wait" })).state,
      ).toBe("queued");
      let row = await store.get(id);
      expect(row?.attempts).toBe(1);
      expect(+new Date(row!.next_attempt_at!) - Date.now()).toBeGreaterThan(
        20_000,
      );
      await service.flushNotifications();
      expect(sends - before).toBe(1);
      await db.$client.unsafe(
        "UPDATE chisabot_personal_deliveries SET next_attempt_at=now() WHERE id=$1",
        [id],
      );
      await service.flushNotifications();
      row = await store.get(id);
      expect(row?.attempts).toBe(2);
      expect(+new Date(row!.next_attempt_at!) - Date.now()).toBeGreaterThan(
        100_000,
      );
      await db.$client.unsafe(
        "UPDATE chisabot_personal_deliveries SET next_attempt_at=now() WHERE id=$1",
        [id],
      );
      await service.flushNotifications();
      row = await store.get(id);
      expect(row?.state).toBe("failed");
      expect(row?.attempts).toBe(3);
      await service.flushNotifications();
      expect(sends - before).toBe(3);
      expect(
        (
          await service.notify(owner, {
            id: "turn-limited",
            message: "chat",
            runId: "original-turn",
          })
        ).state,
      ).toBe("failed");
      webhookMode = "accepted";
    });
  },
);
