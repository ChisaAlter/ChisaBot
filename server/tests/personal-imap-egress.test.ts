import { expect, test } from "bun:test";
import { fetchImapInboxSummary } from "../src/personal-sources/service";

const base = { user: "me@example.com", pass: "app-password", limit: 3 };

test("IMAP accepts only ports 993 and 143", async () => {
  for (const port of [25, 80, 443, 6379, 5432])
    await expect(
      fetchImapInboxSummary({
        ...base,
        host: "imap.example.com",
        port,
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).rejects.toThrow("IMAP 端口");
});

test("a public-looking hostname that resolves to a private, loopback or link-local address is refused", async () => {
  for (const address of [
    "10.0.0.5",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.2",
    "::1",
  ])
    await expect(
      fetchImapInboxSummary({
        ...base,
        host: "imap.attacker.example",
        port: 993,
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address, family: address.includes(":") ? 6 : 4 },
        ],
      }),
    ).rejects.toThrow("不能连接内网或本机");
});

test("the demo inbox is no longer a shortcut of the real IMAP reader", async () => {
  await expect(
    fetchImapInboxSummary({
      ...base,
      host: "demo.imap.local",
      pass: "demo-inbox",
      port: 993,
      resolve: async () => [],
    }),
  ).rejects.toThrow("不能连接内网或本机");
  await expect(
    fetchImapInboxSummary({
      ...base,
      host: "localhost",
      pass: "demo-inbox",
      port: 993,
    }),
  ).rejects.toThrow("不能连接内网或本机");
});
