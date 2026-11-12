// QA508 F1: a runtime failure quoting a key, URL credentials, an internal host:port and SQL must not
// reach the RUN_ERROR stream, any stored row of the thread, or a log line — before or after RUN_STARTED.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { createDatabase } from "../src/db/client";
import { createLocalConversations } from "../src/local-conversations";
import { publicErrorMessage, redactPublicText } from "../src/public-error";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const SECRETS = [
  "sk-qa508FAKEKEY1234567890abcdef",
  "hunter2pw",
  "10.20.30.40",
  "3096",
  "secret_col",
  "qa_secret_table",
  "s3cr3tPG",
];
const MSG =
  "upstream https://qa:hunter2pw@10.20.30.40:3096/v1 failed: Authorization: Bearer sk-qa508FAKEKEY1234567890abcdef; db postgres://app:s3cr3tPG@pg.svc.cluster.local:5432/x; Failed query: select secret_col from qa_secret_table";

const leaks = (text: string) =>
  SECRETS.filter((secret) => text.includes(secret));

describe("shared public error redaction", () => {
  test("strips keys, URL credentials, internal hosts and SQL", () => {
    const text = publicErrorMessage(new Error(MSG));
    expect(leaks(text)).toEqual([]);
    expect(text).toContain("upstream");
    for (const sample of [
      "connect ECONNREFUSED 192.168.1.20:5432",
      "fetch http://localhost:8080/x failed",
      "dial tcp 172.20.0.3: refused",
      "host db.internal:5432 unreachable",
      "proxy admin:pa55word@gateway failed",
      "relay 38.14.250.130:443 timed out",
      "insert into users values ('x')",
      "update accounts set balance = 0",
      "delete from sessions where id = 1",
    ]) {
      const out = redactPublicText(sample);
      for (const bad of [
        "192.168.1.20",
        "localhost",
        "172.20.0.3",
        "db.internal",
        "pa55word",
        "38.14.250.130:443",
        "users values",
        "balance",
        "sessions where",
      ])
        expect(out).not.toContain(bad);
    }
    // QA509: URL credentials under any scheme, not only http(s).
    for (const [url, secret] of [
      ["postgres://app:s3cr3tPG@db.example.com:5432/app", "s3cr3tPG"],
      ["postgresql://app:s3cr3tPQ@db.example.com/app", "s3cr3tPQ"],
      ["redis://:s3cr3tRD@cache.example.com:6379/0", "s3cr3tRD"],
      ["rediss://default:s3cr3tRS@cache.example.com", "s3cr3tRS"],
      ["mongodb+srv://u:s3cr3tMG@cluster0.example.net/db", "s3cr3tMG"],
      ["wss://u:s3cr3tWS@ws.example.com/socket", "s3cr3tWS"],
      ["ftp://u:s3cr3tFTP@files.example.com/pub", "s3cr3tFTP"],
      ["amqp://guest:s3cr3tMQ@mq.example.com:5672/vhost", "s3cr3tMQ"],
      ["mysql://root:p@ss3cr3tMY@db.example.com/app", "ss3cr3tMY"],
      ["smtp://mailer:s3cr3tSM@smtp.example.com:587", "s3cr3tSM"],
    ]) {
      const out = publicErrorMessage(new Error(`connect ${url} failed`));
      expect(out).not.toContain(secret);
      expect(out).toContain("••••");
      expect(out).toContain("connect");
    }
    // QA510 P3: unencoded / # ? (and @) inside a password are masked whole.
    for (const [url, secret] of [
      ["postgres://app:sl/ash22@db.example.com/x", "ash22"],
      ["postgres://app:ha#sh23@db.example.com/x", "sh23"],
      ["postgres://app:qu?es24@db.example.com/x", "es24"],
      ["https://u:p/q#r?s@api.example.com/v1", "q#r"],
      ["redis://:a@b/c#d@cache.example.com:6379", "c#d"],
    ]) {
      const out = publicErrorMessage(new Error(`connect ${url} failed`));
      expect(out).not.toContain(secret);
      expect(out).toContain("••••:••••@");
    }
    // QA510 P3: Docker service:port and bare private IPv6 are internal addresses.
    for (const [sample, bad] of [
      ["connect ECONNREFUSED chisabot-postgres:5432", "chisabot-postgres"],
      ["redis:6379 refused the connection", "redis:6379"],
      ["upstream magpie_sidecar:3425 timed out", "magpie_sidecar"],
      ["postgres://app@db:5432/x unreachable", "db:5432"],
      ["dial fd00::12 failed", "fd00::12"],
      ["bind fe80::1%eth0 failed", "fe80::1"],
      ["listen ::1 refused", "::1"],
      ["route fdab:cd::3:4 down", "fdab:cd"],
    ]) {
      const out = redactPublicText(sample);
      expect(out).not.toContain(bad);
      expect(out).toContain("[内网地址]");
    }
    // …without eating ordinary text that looks a little like them.
    for (const keep of [
      "会议在 12:30:45 开始",
      "HTTP error:500 from upstream",
      "see https://medium.com/@author and https://registry.npmjs.org/@scope/pkg",
      "https://example.com:8443/@scope/pkg",
      "ssh://git@github.com/owner/repo",
      "postgres://app@db.example.com/x",
      "git@github.com:owner/repo.git",
      "mail ops@example.com bounced",
      "deadbeef: not an address",
      // QA511 P3: parameter / header / locale / model names are not Docker hosts.
      "max_tokens:4096 exceeds limit",
      "x-ratelimit-remaining:59",
      "deepseek-chat:128",
      "en-US:80",
      "context_length:65536",
      "rate_limit:60 per minute",
      "retry_after:30",
      "utf-8:12",
      "gpt-4o:2024",
      "localhost.example.com/a",
      "Basic authentication required",
      "web-1:80",
    ])
      expect(redactPublicText(keep)).toBe(keep);
    expect(redactPublicText("模型服务暂时不可用，请稍后再试。")).toBe(
      "模型服务暂时不可用，请稍后再试。",
    );
    expect(publicErrorMessage("raw")).toBe("会话执行失败。");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "local conversation run failures",
  () => {
    const logs: string[] = [];
    const originals = {} as Record<string, (...args: unknown[]) => void>;
    const db = createDatabase(testDatabaseUrl(), TEST_POOL);
    beforeAll(() => {
      for (const level of ["log", "warn", "error", "info", "debug"] as const) {
        originals[level] = console[level];
        console[level] = (...args: unknown[]) => {
          logs.push(
            args
              .map((value) =>
                value instanceof Error
                  ? `${value.message}\n${value.stack}`
                  : typeof value === "string"
                    ? value
                    : JSON.stringify(value),
              )
              .join(" "),
          );
        };
      }
    });
    afterAll(async () => {
      for (const [level, original] of Object.entries(originals))
        (console as unknown as Record<string, unknown>)[level] = original;
      await db.$client.close();
    });

    for (const mode of ["after-start", "before-start"] as const)
      test(`agent failure ${mode}: stream, rows and logs stay clean`, async () => {
        logs.length = 0;
        const backend = await createLocalConversations(db);
        const owner = `redact-${randomUUID()}`;
        const bot = `${owner}-bot`;
        const threadId = `${owner}-t`;
        await backend.client.getOrCreateThread({
          threadId,
          userId: owner,
          agentId: bot,
        });
        class Boom extends AbstractAgent {
          run(input: RunAgentInput) {
            return new Observable<BaseEvent>((subscriber) => {
              if (mode === "after-start")
                subscriber.next({
                  type: EventType.RUN_STARTED,
                  threadId,
                  runId: input.runId,
                } as BaseEvent);
              setTimeout(() => subscriber.error(new Error(MSG)), 20);
            });
          }
        }
        const events: BaseEvent[] = [];
        let streamError: unknown;
        await new Promise<void>((resolve) =>
          backend.runner
            .run({
              threadId,
              agent: new Boom({ agentId: bot, threadId }),
              input: {
                threadId,
                runId: randomUUID(),
                messages: [{ id: "u1", role: "user", content: "hi" }],
                tools: [],
                context: [],
                state: {},
                forwardedProps: {},
              } as RunAgentInput,
            })
            .subscribe({
              next: (event) => events.push(event),
              error: (error) => {
                streamError = error;
                resolve();
              },
              complete: () => resolve(),
            }),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        let stored = JSON.stringify(
          await db.$client.unsafe(
            "select * from chisabot_local_threads where owner_user_id = $1",
            [owner],
          ),
        );
        const tables = (await db.$client.unsafe(
          "select distinct table_name from information_schema.columns where column_name='thread_id' and table_schema='public'",
        )) as { table_name: string }[];
        for (const { table_name } of tables)
          stored += JSON.stringify(
            await db.$client.unsafe(
              `select * from "${table_name}" where thread_id = $1`,
              [threadId],
            ),
          );
        const streamed =
          JSON.stringify(events) +
          String((streamError as Error | undefined)?.message ?? "") +
          String((streamError as Error | undefined)?.stack ?? "");
        await db.$client.unsafe(
          "delete from chisabot_local_threads where owner_user_id = $1",
          [owner],
        );
        // The failure is still reported, only redacted.
        expect(
          events.some((event) => event.type === EventType.RUN_ERROR) ||
            streamError !== undefined,
        ).toBe(true);
        expect(leaks(streamed)).toEqual([]);
        expect(leaks(stored)).toEqual([]);
        expect(leaks(logs.join("\n"))).toEqual([]);
        expect(logs.join("\n")).not.toContain("Agent execution failed");
      });
  },
);
