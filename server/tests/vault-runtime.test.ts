import { expect, test } from "bun:test";
import { TOOL_STOPPED_ZH, withToolAbort } from "../src/confirmations/context";
import { encryptSecret } from "../src/credentials";
import { createVault } from "../src/vault/service";

const key = Buffer.alloc(32, 9).toString("base64");

async function setup(value = "sample-key-for-vault", fetcher?: typeof fetch) {
  const stored = {
    name: "demo_key",
    label: "Demo",
    domains: ["example.com", "93.184.216.34"],
    value: await encryptSecret(key, value),
  };
  let request: { id: string; status: string } | null = null;
  let inserted!: () => void;
  const created = new Promise<void>((resolve) => {
    inserted = resolve;
  });
  const database = {
    $client: {
      async unsafe(query: string, parameters: unknown[]) {
        if (query.startsWith("INSERT INTO chisabot_vault_requests")) {
          request = { id: String(parameters[0]), status: "pending" };
          inserted();
          return [];
        }
        if (query.includes("SET status = 'cancelled'")) {
          if (request?.status === "pending") request.status = "cancelled";
          return [];
        }
        if (query.includes("SELECT * FROM chisabot_vault_requests"))
          return request ? [request] : [];
        if (query.includes("SELECT * FROM chisabot_vault_secrets"))
          return [stored];
        return [];
      },
    },
  };
  const vault = createVault(database as never, {
    encryptionKey: key,
    ...(fetcher ? { fetch: fetcher } : {}),
  });
  return { vault, created, status: () => request?.status };
}

test("vault rejects an already stopped tool without reading credentials or sending HTTP", async () => {
  const vault = createVault(
    {
      $client: {
        unsafe() {
          throw new Error("must not read");
        },
      },
    } as never,
    { encryptionKey: key },
  );
  const signal = AbortSignal.abort();
  const tool = vault
    .tools("owner", "bot")
    .find((tool) => tool.name === "api_request")!;
  expect(
    await tool.execute({ url: "https://example.com" }, { signal }),
  ).toContain(TOOL_STOPPED_ZH);
});

test("vault passes the ambient Stop signal to an in-flight API request", async () => {
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let requestSignal: AbortSignal | null | undefined;
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    requestSignal = init?.signal;
    reached();
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener(
        "abort",
        () => reject(requestSignal?.reason),
        { once: true },
      );
    });
  }) as typeof fetch;
  const { vault } = await setup(undefined, fetcher);
  const controller = new AbortController();
  const tool = vault
    .tools("owner", "bot")
    .find((tool) => tool.name === "api_request")!;
  const pending = withToolAbort(controller.signal, () =>
    tool.execute({ url: "https://93.184.216.34/" }),
  );
  await started;
  controller.abort();
  expect(await pending).toContain(TOOL_STOPPED_ZH);
  expect(requestSignal?.aborted).toBe(true);
});

test("stopping a secret request closes its card instead of polling for ten minutes", async () => {
  const { vault, created, status } = await setup();
  const controller = new AbortController();
  const tool = vault
    .tools("owner", "bot")
    .find((tool) => tool.name === "vault_request_secret")!;
  const pending = tool.execute(
    { name: "demo_key", label: "Demo", domains: ["example.com"] },
    { signal: controller.signal },
  );
  await created;
  controller.abort();
  expect(await pending).toContain(TOOL_STOPPED_ZH);
  expect(status()).toBe("cancelled");
});

test("credential substitution cannot change the approved destination", async () => {
  let called = false;
  const { vault } = await setup(
    "name@elsewhere.example/path?key=",
    (async () => {
      called = true;
      return new Response("unexpected");
    }) as typeof fetch,
  );
  await expect(
    vault.request("owner", {
      method: "GET",
      url: "https://{{secret:demo_key}}@example.com",
    }),
  ).rejects.toThrow("允许的域名");
  expect(called).toBe(false);
});

test("network failures cannot echo raw or URL-encoded vault values", async () => {
  const value = "sample key/with?punctuation";
  const { vault } = await setup(value, (async () => {
    throw new Error(`HTTP failed: ${value}; url=${encodeURIComponent(value)}`);
  }) as typeof fetch);
  const tool = vault
    .tools("owner", "bot")
    .find((tool) => tool.name === "api_request")!;
  const result = await tool.execute({
    url: "https://93.184.216.34/?key={{secret:demo_key}}",
  });
  expect(result).toContain("HTTP failed");
  expect(result).not.toContain(value);
  expect(result).not.toContain(encodeURIComponent(value));
});

test("response metadata and short credential echoes are scrubbed", async () => {
  const { vault } = await setup(
    "abc",
    (async () =>
      new Response("echo abc", {
        headers: {
          "content-type": "text/abc",
          location: "https://example.com/?key=abc",
        },
      })) as typeof fetch,
  );
  const result = await vault.request("owner", {
    method: "GET",
    url: "https://93.184.216.34/?key={{secret:demo_key}}",
  });
  expect(JSON.stringify(result)).not.toContain("abc");
  expect(result.body).toBe("echo ••••");
});
