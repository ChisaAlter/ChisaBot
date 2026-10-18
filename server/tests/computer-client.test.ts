import { describe, expect, test } from "bun:test";
import {
  CaptureBusyError,
  ComputerStoppedError,
  ComputerUnavailableError,
  createComputerTransport,
  ElementNotFoundError,
  HumanHasControlError,
  NavigationRefusedError,
  PageTimeoutError,
  StaleSnapshotError,
  WorkspaceNotFoundError,
  WorkspaceTooLargeError,
} from "../src/computer/client";

function clientWith(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  allowPrivateHosts = false,
) {
  const transport = createComputerTransport({
    allowPrivateHosts,
    fetchImpl: ((url: string, init?: RequestInit) =>
      Promise.resolve(handler(url, init))) as unknown as typeof fetch,
  });
  const baseUrl = "http://agent-computer:4100";
  const botId = "bot-1";
  return {
    navigate: (url: string) => transport.navigate(baseUrl, botId, url),
    screenshot: () => transport.call(baseUrl, botId, "/screenshot"),
    click: (input: unknown, signal?: AbortSignal) =>
      transport.post(baseUrl, botId, "/click", input, signal),
    download: (path: string) =>
      transport.download(
        baseUrl,
        botId,
        `/files/download?path=${encodeURIComponent(path)}`,
      ),
  };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("computer client", () => {
  describe("computer file downloads", () => {
    test("returns raw bytes without decoding them as JSON", async () => {
      const payload = Uint8Array.from([0, 255, 1, 2, 3]);
      const seen: string[] = [];
      const client = clientWith((url) => {
        seen.push(url);
        return new Response(payload, {
          headers: { "content-length": String(payload.byteLength) },
        });
      });

      const download = await client.download("reports/data.bin");

      expect(download.bytes).toBe(payload.byteLength);
      expect(
        new Uint8Array(await new Response(download.body).arrayBuffer()),
      ).toEqual(payload);
      expect(seen).toEqual([
        "http://agent-computer:4100/files/download?path=reports%2Fdata.bin",
      ]);
    });

    test("refuses a successful response with no byte length", async () => {
      const client = clientWith(() => new Response(Uint8Array.from([1, 2, 3])));

      await expect(client.download("x")).rejects.toThrow(
        ComputerUnavailableError,
      );
    });

    test("releases the connection it refuses to hand back", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const client = clientWith(() => new Response(body));

      await expect(client.download("x")).rejects.toThrow(
        ComputerUnavailableError,
      );
      expect(cancelled).toBe(true);
    });

    test("still names the invalid download when releasing it fails", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]));
        },
        cancel() {
          throw new Error("socket already gone");
        },
      });
      const client = clientWith(() => new Response(body));

      await expect(client.download("x")).rejects.toThrow(
        ComputerUnavailableError,
      );
    });

    test.each([
      [404, WorkspaceNotFoundError],
      [413, WorkspaceTooLargeError],
    ])("maps HTTP %i to its workspace error", async (status, errorType) => {
      const client = clientWith(() =>
        Response.json(
          { error: "The file could not be downloaded." },
          { status },
        ),
      );

      await expect(client.download("x")).rejects.toBeInstanceOf(errorType);
    });
  });

  test("navigates and returns where it landed", async () => {
    const seen: string[] = [];
    const client = clientWith((url, init) => {
      seen.push(url);
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://example.com/",
      });
      return ok({
        url: "https://example.com/",
        title: "Example",
        elapsedMs: 12,
      });
    });

    await expect(client.navigate("https://example.com/")).resolves.toEqual({
      url: "https://example.com/",
      title: "Example",
      elapsedMs: 12,
    });
    expect(seen).toEqual(["http://agent-computer:4100/navigate"]);
  });

  // The refusal happens before anything leaves. A guard that only inspects the response has
  // already let the request reach the internal service it was meant to protect.
  test("refuses an internal address without calling the computer", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({});
    });

    await expect(client.navigate("http://169.254.169.254/")).rejects.toThrow(
      NavigationRefusedError,
    );
    expect(called).toBe(false);
  });

  // The opt-in every laptop sets must not be a way to reach the cloud credential endpoint. The
  // earlier test above passes with the opt-in OFF, which is what let this through unnoticed.
  test("refuses cloud metadata even when private hosts are allowed", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({});
    }, true);

    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      await expect(client.navigate(target)).rejects.toThrow(
        NavigationRefusedError,
      );
    }
    expect(called).toBe(false);
  });

  test("allows an internal address when the deployment opted in", async () => {
    const client = clientWith(
      () => ok({ url: "http://localhost:3000/", title: "Local", elapsedMs: 3 }),
      true,
    );

    await expect(
      client.navigate("http://localhost:3000/"),
    ).resolves.toMatchObject({ title: "Local" });
  });

  // Two different failures that read identically to a person unless we separate them: the computer
  // being absent is an operator problem, a page failing to load is not.
  test("reports an absent computer distinctly from a failed page", async () => {
    const missing = clientWith(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(missing.navigate("https://example.com")).rejects.toThrow(
      "The assistant's computer is not running.",
    );

    const timedOut = clientWith(() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    });
    await expect(timedOut.navigate("https://example.com")).rejects.toThrow(
      "The assistant's computer did not respond in time.",
    );

    const badPage = clientWith(
      () =>
        new Response(JSON.stringify({ error: "net::ERR_NAME_NOT_RESOLVED" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(badPage.navigate("https://nope.example")).rejects.toThrow(
      "net::ERR_NAME_NOT_RESOLVED",
    );
  });

  test("screenshot returns the png a transcript can render", async () => {
    const client = clientWith(() =>
      ok({
        base64: "aGVsbG8=",
        width: 1280,
        height: 800,
        capturedAt: "2026-08-14T00:00:00.000Z",
      }),
    );

    await expect(client.screenshot()).resolves.toMatchObject({
      base64: "aGVsbG8=",
      width: 1280,
    });
  });
});

/**
 * A ref that is not on the page.
 *
 * Reported as a stale snapshot, not as computer unavailability. A model can recover by taking a
 * fresh snapshot.
 */
describe("acting on an element that is not there", () => {
  const playwrightTimeout = {
    error:
      "click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e5')\n",
  };

  const timingOut = () =>
    clientWith(
      () =>
        new Response(JSON.stringify(playwrightTimeout), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );

  test("is its own condition, not an unavailable computer", async () => {
    expect(
      timingOut().click({ ref: "e5", snapshotId: 1 }),
    ).rejects.toBeInstanceOf(ElementNotFoundError);
  });

  test("says what to do next, and drops the call log", async () => {
    try {
      await timingOut().click({ ref: "e5", snapshotId: 1 });
      throw new Error("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      // The instruction, naming the ref that failed.
      expect(message).toContain("e5");
      expect(message).toContain("fresh snapshot");
      // Not several lines of Playwright internals, which are noise to a model and to a person.
      expect(message).not.toContain("Call log");
      expect(message).not.toContain("Timeout");
    }
  });
});

/**
 * §101.12：没有指向元素的超时（截图 / 快照 / 打开网页时页面一直在忙）不是「元素不在了」。以前同一条正则把它也说成
 * 「重新快照」，机器人在 hark.com 登录页上原地快照了十来次。
 */
describe("a timeout that names no element", () => {
  const busy = (error: string) =>
    clientWith(
      () =>
        new Response(JSON.stringify({ error }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    );

  test("a screenshot timeout is a page timeout, not a stale element", async () => {
    const pending = busy("page.screenshot: Timeout 30000ms exceeded.\nCall log:\n  - taking page screenshot\n").screenshot();
    await expect(pending).rejects.toBeInstanceOf(PageTimeoutError);
    await pending.catch((error: Error) => {
      expect(error.message).not.toContain("snapshot and use the refs");
      expect(error.message).toContain("Do not repeat");
    });
  });

  test("a locator timeout still means the element is gone", async () => {
    await expect(
      busy("click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e9')\n").click({ ref: "e9", snapshotId: 1 }),
    ).rejects.toBeInstanceOf(ElementNotFoundError);
  });
});

/**
 * A refusal because a person took the wheel, told apart from stale refs.
 *
 * Both arrive as 409, and the computer says which is which by putting `humanHasControl` on the body
 * (agent-computer/src/index.ts). Mapping every 409 to the same condition throws that away, and the
 * surface then tells the model its refs are stale and to take a fresh snapshot: advice that sends a
 * Bot round the loop again against a person who has deliberately taken the browser. The status is
 * the same either way; what differs is what the caller should do next, which is the only thing the
 * distinction is for.
 */
describe("a 409 from the computer", () => {
  const refusing = (body: unknown) =>
    clientWith(
      () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );

  test("is a person holding the wheel when the computer says so", async () => {
    expect(
      refusing({
        error: "A person has taken control of this computer.",
        humanHasControl: true,
      }).click({ ref: "e1", snapshotId: 1 }),
    ).rejects.toBeInstanceOf(HumanHasControlError);
  });

  test("is a stale snapshot when it does not", async () => {
    // The permissive half, and the one that must not change: an ordinary stale-ref 409 carries no
    // flag and keeps its own condition, so the refs-are-stale instruction still reaches the model.
    expect(
      refusing({ error: "Snapshot 3 is not the current one." }).click({
        ref: "e1",
        snapshotId: 1,
      }),
    ).rejects.toBeInstanceOf(StaleSnapshotError);
  });

  test("is a stale snapshot for every shape that is not the flag", async () => {
    // The flag decides an instruction a Bot acts on, so only the computer's own `true` counts. A
    // string, a false, or a 409 with nothing on it at all stays the ordinary condition rather than
    // parking a Bot to wait for a person who is not there.
    for (const body of [
      { error: "no flag" },
      { error: "explicitly not a takeover", humanHasControl: false },
      { error: "a string is not a boolean", humanHasControl: "true" },
      {},
    ]) {
      expect(
        refusing(body).click({ ref: "e1", snapshotId: 1 }),
      ).rejects.toBeInstanceOf(StaleSnapshotError);
    }
  });

  test("a 409 with no body at all is still a refusal, not a crash", async () => {
    const bodyless = clientWith(() => new Response(null, { status: 409 }));
    expect(bodyless.click({ ref: "e1", snapshotId: 1 })).rejects.toBeInstanceOf(
      StaleSnapshotError,
    );
  });

  test("carries the reason the computer gave, either way", async () => {
    for (const body of [
      {
        error: "A person has taken control of this computer.",
        humanHasControl: true,
      },
      { error: "Snapshot 3 is not the current one." },
    ]) {
      try {
        await refusing(body).click({ ref: "e1", snapshotId: 1 });
        throw new Error("should have refused");
      } catch (error) {
        expect((error as Error).message).toBe(body.error);
      }
    }
  });
});

/**
 * Stop has to travel./**
 * Stop has to travel.
 *
 * Pressing Stop aborts the surface's request. That abort is only useful if it reaches the browser: a
 * click already running in Chromium otherwise lands anyway, which is harmless most of the time and
 * not harmless on a Confirm button, precisely the moment somebody presses Stop.
 */
describe("the caller's Stop", () => {
  test("is passed to the request, so it can reach the browser", async () => {
    let seen: AbortSignal | undefined;
    const client = clientWith((_url, init) => {
      seen = init?.signal ?? undefined;
      return ok({ action: "click" });
    });

    const stop = new AbortController();
    await client.click({ ref: "e1", snapshotId: 1 }, stop.signal);

    expect(seen).toBeDefined();
    // Not the caller's signal itself: it is combined with the timeout, because a computer that stops
    // answering must still end the request even when nobody pressed anything.
    expect(seen?.aborted).toBe(false);
    stop.abort();
    expect(seen?.aborted).toBe(true);
  });

  test("a request that was already stopped never reaches the computer", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({ action: "click" });
    });

    const stop = new AbortController();
    stop.abort();

    // A stop, and a distinguishable one: `ComputerStoppedError` so the gateway types the audit row
    // `computer.action_stopped` rather than counting a person's Stop as a failed action. It stays a
    // subclass of `ComputerUnavailableError`, so everything catching an unavailable computer to tell
    // the model is unaffected.
    const error = await client
      .click({ ref: "e1", snapshotId: 1 }, stop.signal)
      .then(
        () => null,
        (reason) => reason,
      );
    expect(error).toBeInstanceOf(ComputerStoppedError);
    expect(error).toBeInstanceOf(ComputerUnavailableError);
    expect(called).toBe(false);
  });

  test("without one, the timeout still applies", async () => {
    let seen: AbortSignal | undefined;
    const client = clientWith((_url, init) => {
      seen = init?.signal ?? undefined;
      return ok({ action: "click" });
    });

    await client.click({ ref: "e1", snapshotId: 1 });

    // A caller that passes nothing must not end up with an unbounded request.
    expect(seen).toBeDefined();
  });
});

describe("the deadline a call is given", () => {
  test("a command outlasts the shell's own maximum; a browser action does not", async () => {
    /*
     * The shell's budget is 120s by default and 600s at most, and it reports `timedOut` itself. A
     * transport deadline shorter than that told the person the computer had gone quiet while the
     * command ran to completion inside the container, and made the shell's own maximum unreachable.
     */
    const deadlines: number[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      // AbortSignal.timeout is not readable, so the deadline is observed by racing it.
      const signal = init?.signal;
      deadlines.push(signal ? 1 : 0);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const transport = createComputerTransport({ fetchImpl, timeoutMs: 45_000 });

    // Both calls succeed; what matters is that the override is accepted and passed down rather than
    // silently dropped, which a signature change could do without any test noticing.
    await transport.post("http://computer", "bot-1", "/click", {}, undefined);
    await transport.post(
      "http://computer",
      "bot-1",
      "/exec",
      {},
      undefined,
      615_000,
    );

    expect(deadlines).toEqual([1, 1]);
  });

  test("the override is what bounds the request, not the transport default", async () => {
    // A 20ms transport default with a call that takes 60ms: without the override this rejects.
    const slow = (async (_url: string, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 60);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "TimeoutError";
          reject(error);
        });
      });
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const transport = createComputerTransport({
      fetchImpl: slow,
      timeoutMs: 20,
    });

    await expect(
      transport.post("http://computer", "bot-1", "/click", {}),
    ).rejects.toThrow();

    await expect(
      transport.post("http://computer", "bot-1", "/exec", {}, undefined, 5_000),
    ).resolves.toBeDefined();
  });
});

describe("a person's Stop", () => {
  /*
   * Stop is the person saying "not that". The transport already answers it that way when the signal
   * is already aborted before the request leaves; the signal is handed to fetch precisely so Stop can
   * also land mid-flight, and that half was reported as a dead computer. The message is not only what
   * the model reads: the gateway writes it into the action's audit row as `failure`, so a person's
   * Stop was recorded as an outage.
   */
  test("a Stop that lands mid-action is reported as a stop, not as a dead computer", async () => {
    const controller = new AbortController();
    const aborting = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          // What fetch does when the signal it was given aborts.
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
        controller.abort();
      })) as unknown as typeof fetch;

    const transport = createComputerTransport({ fetchImpl: aborting });

    await expect(
      transport.post(
        "http://computer",
        "bot-1",
        "/click",
        {},
        controller.signal,
      ),
    ).rejects.toThrow("The action was stopped.");
  });

  test("a Stop pressed before the request leaves still says the same thing", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = createComputerTransport({
      fetchImpl: (() => {
        throw new Error("the request should never have been sent");
      }) as unknown as typeof fetch,
    });

    await expect(
      transport.post(
        "http://computer",
        "bot-1",
        "/click",
        {},
        controller.signal,
      ),
    ).rejects.toThrow("The action was stopped.");
  });

  test("a computer that is really unreachable still says so", async () => {
    const transport = createComputerTransport({
      fetchImpl: (() =>
        Promise.reject(
          new Error("connect ECONNREFUSED"),
        )) as unknown as typeof fetch,
    });

    await expect(
      transport.post("http://computer", "bot-1", "/click", {}),
    ).rejects.toThrow("The assistant's computer is not running.");
  });
});


/**
 * 0.1.41 / DOG-05 root：LiveScreen 出图时 HTTP /screenshot 主动 503+captureBusy，
 * 或页面忙 422+pageTimeout。必须保留标志，不能吞成「电脑挂了」。
 */
describe("screenshot captureBusy / pageTimeout from agent-computer", () => {
  const answering = (status: number, body: unknown) =>
    clientWith(
      () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );

  test("503 + captureBusy + liveCast → CaptureBusyError", async () => {
    const pending = answering(503, {
      error: "Live screen is streaming; HTTP screenshot paused so they do not fight.",
      captureBusy: true,
      liveCast: true,
    }).screenshot();
    await expect(pending).rejects.toBeInstanceOf(CaptureBusyError);
    await pending.catch((error: CaptureBusyError) => {
      expect(error.captureBusy).toBe(true);
      expect(error.liveCast).toBe(true);
      expect(error).toBeInstanceOf(ComputerUnavailableError);
    });
  });

  test("503 + captureBusy in-flight → CaptureBusyError without liveCast", async () => {
    await expect(
      answering(503, {
        error: "Another screenshot is already in progress.",
        captureBusy: true,
        liveCast: false,
      }).screenshot(),
    ).rejects.toMatchObject({ name: "CaptureBusyError", liveCast: false });
  });

  test("422 + pageTimeout → PageTimeoutError", async () => {
    await expect(
      answering(422, {
        error: "The page did not respond in time (it may still be loading or busy drawing).",
        pageTimeout: true,
      }).screenshot(),
    ).rejects.toBeInstanceOf(PageTimeoutError);
  });
});
