import { describe, expect, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createGuardedFetchLike,
  guardedFetch,
} from "../../shared/net/guarded-fetch";

const address = { address: "127.0.0.1", family: 4 };
const options = {
  timeoutMs: 1_000,
  maxBytes: 1_024,
  resolve: async () => [address],
  isBlocked: (ip: string) => ip !== address.address,
};

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (url: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://public.example:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("guarded fetch request lifecycle", () => {
  test("an already cancelled request never resolves DNS or sends HTTP", async () => {
    let lookups = 0;
    let requests = 0;
    await withServer(
      (_req, res) => {
        requests++;
        res.end("unexpected");
      },
      async (url) => {
        const fetch = createGuardedFetchLike({
          ...options,
          resolve: async () => {
            lookups++;
            return [address];
          },
        });
        await expect(
          fetch(url, { signal: AbortSignal.abort() }),
        ).rejects.toHaveProperty("name", "AbortError");
        expect(lookups).toBe(0);
        expect(requests).toBe(0);
      },
    );
  });

  test("DNS resolution consumes the total timeout and a late answer sends nothing", async () => {
    let release!: (value: (typeof address)[]) => void;
    const pending = new Promise<(typeof address)[]>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await withServer(
      (_req, res) => {
        requests++;
        res.end("unexpected");
      },
      async (url) => {
        await expect(
          guardedFetch(url, {
            ...options,
            timeoutMs: 30,
            resolve: () => pending,
          }),
        ).rejects.toThrow("请求超时");
        release([address]);
        await Bun.sleep(20);
        expect(requests).toBe(0);
      },
    );
  });

  test("cancelling during DNS rejects immediately and discards the late answer", async () => {
    let release!: (value: (typeof address)[]) => void;
    const pending = new Promise<(typeof address)[]>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    let entered!: () => void;
    const resolving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let requests = 0;
    await withServer(
      (_req, res) => {
        requests++;
        res.end("unexpected");
      },
      async (url) => {
        const fetch = createGuardedFetchLike({
          ...options,
          resolve: () => {
            entered();
            return pending;
          },
        });
        const result = fetch(url, { signal: controller.signal });
        const outcome = result.then(
          () => null,
          (error: Error) => error,
        );
        await resolving;
        controller.abort();
        expect(await outcome).toHaveProperty("name", "AbortError");
        release([address]);
        await Bun.sleep(20);
        expect(requests).toBe(0);
      },
    );
  });

  test("HEAD stays HEAD across 303 and returns a null body", async () => {
    const methods: string[] = [];
    await withServer(
      (req, res) => {
        methods.push(req.method ?? "");
        if (req.url === "/start") res.writeHead(303, { location: "/final" });
        else res.writeHead(200, { "content-length": "12" });
        res.end();
      },
      async (url) => {
        const response = await createGuardedFetchLike(options)(`${url}/start`, {
          method: "HEAD",
        });
        expect(response.status).toBe(200);
        expect(response.body).toBeNull();
        expect(methods).toEqual(["HEAD", "HEAD"]);
      },
    );
  });

  test.each([204, 205, 304])(
    "status %i is represented without a response body",
    async (status) => {
      await withServer(
        (_req, res) => {
          res.writeHead(status);
          res.end();
        },
        async (url) => {
          const response = await createGuardedFetchLike(options)(url);
          expect(response.status).toBe(status);
          expect(response.body).toBeNull();
          expect(await response.text()).toBe("");
        },
      );
    },
  );

  test("a redirect with an unfinished body releases the previous connection", async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    await withServer(
      (req, res) => {
        if (req.url === "/start") {
          res.writeHead(302, { location: "/final" });
          res.flushHeaders();
          req.socket.on("close", closed);
        } else res.end("done");
      },
      async (url) => {
        const response = await guardedFetch(`${url}/start`, options);
        expect(response.body.toString()).toBe("done");
        await disconnected;
      },
    );
  });
});
