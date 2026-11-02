import { beforeEach, describe, expect, test } from "bun:test";
import {
  cooldownMs,
  coolingDown,
  type FallbackUse,
  fallbackCandidates,
  fallbackLanguageModel,
  fallbackNotice,
  fallbackReason,
  isQuotaError,
  resetModelCooldowns,
  withFallbackListener,
} from "../src/agents/model-fallback";

function apiError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { name: "AI_APICallError", statusCode, responseBody: message });
}
const DAILY = apiError(429, "ClinePass: Error 429: Daily free limit reached on model xiaomi/mimo-v2.6-flash. Try again in 19h 51m");

function fakeModel(id: string, behaviour: () => Promise<unknown>) {
  const calls: unknown[] = [];
  return {
    calls,
    model: {
      modelId: id,
      provider: "test",
      async doStream(options: unknown) {
        calls.push(options);
        return behaviour();
      },
      async doGenerate(options: unknown) {
        calls.push(options);
        return behaviour();
      },
    },
  };
}

describe("model fallback on quota errors", () => {
  beforeEach(() => resetModelCooldowns());

  test("recognises quota errors, not others", () => {
    expect(isQuotaError(DAILY)).toBe(true);
    expect(isQuotaError(apiError(402, "payment required"))).toBe(true);
    expect(isQuotaError({ name: "AI_RetryError", message: "Failed after 3 attempts", lastError: DAILY })).toBe(true);
    expect(isQuotaError(apiError(400, "invalid tool schema"))).toBe(false);
    expect(isQuotaError(apiError(500, "upstream exploded"))).toBe(false);
    expect(isQuotaError(new Error("network down"))).toBe(false);
  });

  test("reads the retry hint", () => {
    expect(cooldownMs(DAILY)).toBe((19 * 3600 + 51 * 60) * 1000);
    expect(cooldownMs(apiError(429, "rate limited, retry after 30s"))).toBe(30_000);
    // 没写原因的 429 是一时限流：1 分钟；写着额度 / 每日限额的 10 分钟（§101）。
    expect(cooldownMs(apiError(429, "slow down"))).toBe(60_000);
    expect(cooldownMs(apiError(429, "quota exceeded"))).toBe(10 * 60_000);
  });

  test("switches to the next candidate, then skips the cooled model on later turns", async () => {
    const primary = fakeModel("p", async () => {
      throw DAILY;
    });
    const backup = fakeModel("b", async () => ({ stream: "ok-from-b" }));
    const logs: Record<string, unknown>[] = [];
    let t = 1_000;
    const wrapped = fallbackLanguageModel(primary.model, "clinepass/p", {
      candidates: async () => ["clinepass/b"],
      build: (id) => (id === "clinepass/b" ? backup.model : null),
      now: () => t,
      log: (line) => logs.push(line),
    });
    expect(await wrapped.doStream({ prompt: 1 })).toEqual({ stream: "ok-from-b" });
    expect(primary.calls.length).toBe(1);
    expect(coolingDown("clinepass/p", t)).toBe(true);
    // next turn: primary not called at all
    expect(await wrapped.doGenerate({ prompt: 2 })).toEqual({ stream: "ok-from-b" });
    expect(primary.calls.length).toBe(1);
    expect(backup.calls).toEqual([{ prompt: 1 }, { prompt: 2 }]);
    expect(logs.map((l) => l.event)).toEqual(["primary-quota", "used", "skip-primary", "used"]);
    // after the cooldown the primary is tried again
    t += 20 * 3600_000;
    expect(coolingDown("clinepass/p", t)).toBe(false);
    await wrapped.doStream({ prompt: 3 });
    expect(primary.calls.length).toBe(2);
  });

  test("a fallback model gets the request rewritten for it (images it cannot see → descriptions); the primary never does", async () => {
    // 审查 #417：备用模型看不了图时，那一次请求里的图片要换成描述，不能原样发过去。
    const primary = fakeModel("p", async () => {
      throw DAILY;
    });
    const backup = fakeModel("b", async () => ({ stream: "ok-from-b" }));
    const adapted: string[] = [];
    const wrapped = fallbackLanguageModel(primary.model, "clinepass/p", {
      candidates: async () => ["clinepass/b"],
      build: (id) => (id === "clinepass/b" ? backup.model : null),
      log: () => {},
      firstOutputMs: 0,
      adapt: async (id, options) => {
        adapted.push(id);
        return { ...(options as object), described: true };
      },
    });
    expect(await wrapped.doStream({ prompt: "image" })).toEqual({ stream: "ok-from-b" });
    expect(primary.calls).toEqual([{ prompt: "image" }]);
    expect(backup.calls).toEqual([{ prompt: "image", described: true }]);
    expect(adapted).toEqual(["clinepass/b"]);

    // 改写失败不挡住回答：照原请求发。
    resetModelCooldowns();
    const failing = fakeModel("b2", async () => ({ stream: "ok-from-b2" }));
    const wrapped2 = fallbackLanguageModel(fakeModel("p", async () => {
      throw DAILY;
    }).model, "clinepass/p", {
      candidates: async () => ["clinepass/b2"],
      build: () => failing.model,
      log: () => {},
      firstOutputMs: 0,
      adapt: async () => {
        throw new Error("vision down");
      },
    });
    expect(await wrapped2.doStream({ prompt: "image" })).toEqual({ stream: "ok-from-b2" });
    expect(failing.calls).toEqual([{ prompt: "image" }]);
  });

  test("non-quota errors are thrown unchanged and do not fall back", async () => {
    const boom = apiError(401, "invalid api key");
    const primary = fakeModel("p", async () => {
      throw boom;
    });
    let built = 0;
    const wrapped = fallbackLanguageModel(primary.model, "x/p", {
      candidates: async () => ["x/b"],
      build: () => {
        built++;
        return null;
      },
      log: () => {},
    });
    await expect(wrapped.doStream({})).rejects.toBe(boom);
    expect(built).toBe(0);
  });

  test("all candidates exhausted rethrows the first quota error", async () => {
    const primary = fakeModel("p", async () => {
      throw DAILY;
    });
    const other = fakeModel("b", async () => {
      throw apiError(429, "Daily free limit reached");
    });
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/b"],
      build: () => other.model,
      log: () => {},
    });
    await expect(wrapped.doStream({})).rejects.toBe(DAILY);
  });

  test("a broken candidate (404 model not found) does not stop the next one (§101)", async () => {
    const primary = fakeModel("p", async () => {
      throw apiError(429, "rate limited");
    });
    const gone = fakeModel("gone", async () => {
      throw apiError(404, "ClinePass: model not found");
    });
    const ok = fakeModel("ok", async () => ({ stream: "ok" }));
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/gone", "c/ok"],
      build: (id) => (id === "c/gone" ? gone.model : ok.model),
      log: () => {},
    });
    expect(await wrapped.doStream({})).toEqual({ stream: "ok" });
    expect(gone.calls.length).toBe(1);
    // 坏掉的候选冷却 30 分钟，下一轮直接跳过
    expect(await wrapped.doStream({})).toEqual({ stream: "ok" });
    expect(gone.calls.length).toBe(1);
  });

  test("primary skipped by cooldown is tried again when every candidate fails (§101)", async () => {
    let primaryFails = true;
    const primary = fakeModel("p", async () => {
      if (primaryFails) throw apiError(429, "rate limited");
      return { stream: "primary-back" };
    });
    const gone = fakeModel("gone", async () => {
      throw apiError(404, "ClinePass: model not found");
    });
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/gone"],
      build: () => gone.model,
      log: () => {},
    });
    await expect(wrapped.doStream({})).rejects.toMatchObject({ statusCode: 429 });
    primaryFails = false;
    // 主模型还在冷却里，候选也冷却了：直接再试主模型
    expect(await wrapped.doStream({})).toEqual({ stream: "primary-back" });
  });

  test("keeps other properties of the wrapped model", () => {
    const primary = fakeModel("p", async () => ({}));
    const wrapped = fallbackLanguageModel(primary.model, "c/p", { candidates: async () => [], build: () => null });
    expect(wrapped.modelId).toBe("p");
    expect(wrapped.provider).toBe("test");
  });

  test("candidates: env list, off, or same platform prefix from the catalog", async () => {
    const catalog = async () => ["clinepass/a", "clinepass/p", "opencode-zen/x-free", "clinepass/b", "clinepass/c", "clinepass/d"];
    expect(await fallbackCandidates(catalog, {})("clinepass/p")).toEqual(["clinepass/a", "clinepass/b", "clinepass/c"]);
    expect(await fallbackCandidates(catalog, { CHISABOT_MODEL_FALLBACKS: "codex/g, clinepass/p ,clinepass/b" })("clinepass/p")).toEqual(["codex/g", "clinepass/b"]);
    expect(await fallbackCandidates(catalog, { CHISABOT_MODEL_FALLBACKS: "off" })("clinepass/p")).toEqual([]);
    expect(await fallbackCandidates(catalog, {})("gpt-4o")).toEqual([]);
  });

  test("5xx / overloaded fall back too (cooldown backs off); 401/network do not", async () => {
    expect(fallbackReason(DAILY)).toBe("quota");
    expect(fallbackReason(apiError(503, "service unavailable"))).toBe("unavailable");
    expect(fallbackReason(apiError(529, "overloaded"))).toBe("unavailable");
    expect(fallbackReason(apiError(500, "upstream exploded"))).toBe("unavailable");
    expect(fallbackReason(apiError(400, "invalid tool schema"))).toBe("rejected");
    expect(fallbackReason(apiError(413, "payload too large"))).toBe("rejected");
    expect(fallbackReason(apiError(422, "unprocessable entity"))).toBe("rejected");
    expect(fallbackReason(apiError(401, "invalid api key"))).toBe(null);
    expect(fallbackReason(new Error("network down"))).toBe(null);
    let t = 0;
    const primary = fakeModel("p", async () => {
      throw apiError(503, "service unavailable");
    });
    const backup = fakeModel("b", async () => ({ ok: "b" }));
    const wrapped = fallbackLanguageModel(primary.model, "m/p", {
      candidates: async () => ["m/b"],
      build: () => backup.model,
      now: () => t,
      log: () => {},
    });
    const seen: FallbackUse[] = [];
    expect(await withFallbackListener((use) => seen.push(use), () => wrapped.doStream({}))).toEqual({ ok: "b" });
    expect(seen).toEqual([{ from: "m/p", to: "m/b", reason: "unavailable" }]);
    // 服务不可用的首次冷却默认 60 秒（指数退避的基数）。
    expect(coolingDown("m/p", 59_999)).toBe(true);
    expect(coolingDown("m/p", 60_001)).toBe(false);
  });

  test("breaker: skip is logged, probe failures back off exponentially, recovery closes it (QA1102-06)", async () => {
    let down = true;
    const primary = fakeModel("p", async () => {
      if (down) throw apiError(503, "service unavailable");
      return { stream: "primary-back" };
    });
    const backup = fakeModel("b", async () => ({ stream: "ok-from-b" }));
    const logs: Record<string, unknown>[] = [];
    let t = 1_000;
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/b"],
      build: () => backup.model,
      now: () => t,
      log: (line) => logs.push(line),
    });
    // 第一轮：主模型 503 → 冷却 60s，备用答上。
    expect(await wrapped.doStream({})).toEqual({ stream: "ok-from-b" });
    expect(primary.calls.length).toBe(1);
    expect(logs[0]).toMatchObject({ event: "primary-unavailable", cooldownSeconds: 60, consecutiveFailures: 1 });
    // 第二轮起（冷却内）：主模型一次都没被调用，每轮一条 skip-primary 带 reason 和剩余冷却。
    for (const at of [t + 1_000, t + 30_000]) {
      t = at;
      expect(await wrapped.doStream({})).toEqual({ stream: "ok-from-b" });
      expect(primary.calls.length).toBe(1);
    }
    const skips = logs.filter((l) => l.event === "skip-primary");
    expect(skips.length).toBe(2);
    expect(skips[0]).toMatchObject({ model: "c/p", reason: "unavailable" });
    expect((skips[0].cooldownRemainingSeconds as number) > 0).toBe(true);
    // 冷却过后半开探测一次：又失败 → 重新打开，冷却翻倍（120s）。
    t += 61_000;
    expect(await wrapped.doStream({})).toEqual({ stream: "ok-from-b" });
    expect(primary.calls.length).toBe(2);
    const reopened = logs.filter((l) => l.event === "primary-unavailable").at(-1);
    expect(reopened).toMatchObject({ cooldownSeconds: 120, consecutiveFailures: 2 });
    // 60s 后仍在冷却（翻倍后的 120s 没过）：继续跳过。
    t += 61_000;
    expect(await wrapped.doStream({})).toEqual({ stream: "ok-from-b" });
    expect(primary.calls.length).toBe(2);
    // 120s 过后探测：主模型恢复了 → 这一轮直接用它，失败计数清零。
    t += 60_000;
    down = false;
    expect(await wrapped.doStream({})).toEqual({ stream: "primary-back" });
    expect(primary.calls.length).toBe(3);
    expect(await wrapped.doStream({})).toEqual({ stream: "primary-back" });
    expect(primary.calls.length).toBe(4);
    expect(logs.filter((l) => l.event === "skip-primary").length).toBe(3);
    expect(coolingDown("c/p", t)).toBe(false);
  });


  test("QA1102-14: a 400 is rejected — cleaned retry once on the primary, no cooldown, no 3x", async () => {
    const boom = apiError(400, "Invalid input, param messages.370.content");
    const primary = fakeModel("p", async () => {
      throw boom;
    });
    const backup = fakeModel("b", async () => ({ stream: "ok-from-b" }));
    const logs: Record<string, unknown>[] = [];
    const cleaned: unknown[] = [];
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/b"],
      build: () => backup.model,
      log: (line) => logs.push(line),
      sanitize: (options) => {
        cleaned.push(options);
        return { ...(options as object), cleaned: true };
      },
    });
    const seen: FallbackUse[] = [];
    expect(await withFallbackListener((use) => seen.push(use), () => wrapped.doStream({ prompt: 1 }))).toEqual({ stream: "ok-from-b" });
    // 主模型恰好两次（原始 + 清洗后一次重试），不是三次；备用模型拿到的是原请求。
    expect(primary.calls).toEqual([{ prompt: 1 }, { prompt: 1, cleaned: true }]);
    expect(backup.calls).toEqual([{ prompt: 1 }]);
    expect(cleaned).toEqual([{ prompt: 1 }]);
    // 不进冷却：下一轮照样先试主模型。
    expect(coolingDown("c/p")).toBe(false);
    expect(seen).toEqual([{ from: "c/p", to: "c/b", reason: "rejected" }]);
    expect(logs.some((l) => l.event === "primary-rejected")).toBe(true);
    expect(logs.some((l) => l.event === "skip-primary")).toBe(false);
    await wrapped.doStream({ prompt: 2 });
    expect(primary.calls.length).toBe(4);
    expect(backup.calls.length).toBe(2);
  });

  test("QA1102-14: a cleaned retry that answers keeps the primary and announces nothing", async () => {
    let first = true;
    const primary = fakeModel("p", async () => {
      if (first) {
        first = false;
        throw apiError(400, "context too long");
      }
      return { stream: "primary-ok" };
    });
    const built: string[] = [];
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/b"],
      build: (id) => {
        built.push(id);
        return null;
      },
      log: () => {},
    });
    expect(await wrapped.doStream({ prompt: 1 })).toEqual({ stream: "primary-ok" });
    expect(primary.calls.length).toBe(2);
    expect(built).toEqual([]);
    expect(coolingDown("c/p")).toBe(false);
  });

  test("announces the switch to the listener of this run only, with the cooled reason on later turns", async () => {
    const primary = fakeModel("p", async () => {
      throw DAILY;
    });
    const backup = fakeModel("b", async () => ({ ok: true }));
    const wrapped = fallbackLanguageModel(primary.model, "c/p", { candidates: async () => ["c/b"], build: () => backup.model, log: () => {} });
    const a: FallbackUse[] = [];
    const b: FallbackUse[] = [];
    await withFallbackListener((use) => a.push(use), () => wrapped.doStream({}));
    // 下一轮主模型在冷却，直接用备用模型，提示仍然说「额度用完」。
    await withFallbackListener((use) => b.push(use), () => wrapped.doGenerate({}));
    expect(a).toEqual([{ from: "c/p", to: "c/b", reason: "quota" }]);
    expect(b).toEqual([{ from: "c/p", to: "c/b", reason: "quota" }]);
    // 没有监听者也照常工作。
    expect(await wrapped.doStream({})).toEqual({ ok: true });
  });

  test("a primary that answers announces nothing", async () => {
    const primary = fakeModel("p", async () => ({ ok: "p" }));
    const wrapped = fallbackLanguageModel(primary.model, "c/p", { candidates: async () => ["c/b"], build: () => null, log: () => {} });
    const seen: FallbackUse[] = [];
    expect(await withFallbackListener((use) => seen.push(use), () => wrapped.doStream({}))).toEqual({ ok: "p" });
    expect(seen).toEqual([]);
  });

  test("candidates: the admin list wins over env and catalog, keeps its order, drops the primary", async () => {
    const catalog = async () => ["clinepass/a", "clinepass/p", "clinepass/b"];
    const admin = async () => ["codex/x", "clinepass/p", "clinepass/b"];
    expect(await fallbackCandidates(catalog, { CHISABOT_MODEL_FALLBACKS: "off" }, admin)("clinepass/p")).toEqual(["codex/x", "clinepass/b"]);
    // 空的管理员列表 = 不指定，退回环境变量 / 目录。
    expect(await fallbackCandidates(catalog, {}, async () => [])("clinepass/p")).toEqual(["clinepass/a", "clinepass/b"]);
    // 读管理员列表失败也不影响回答。
    expect(await fallbackCandidates(catalog, {}, async () => { throw new Error("db down"); })("clinepass/p")).toEqual(["clinepass/a", "clinepass/b"]);
  });


  test("candidates: catalog entries the directory says cannot call tools are skipped (QA1102-13)", async () => {
    const catalog = async () => [
      "clinepass/a",
      { id: "clinepass/no-tools", supportsTools: false },
      { id: "clinepass/unknown" },
      { id: "clinepass/can", supportsTools: true },
      "clinepass/b",
    ];
    // 目录明说不能调工具的跳过；没说的（unknown / 纯字符串）照常用。
    expect(await fallbackCandidates(catalog, {})("clinepass/p")).toEqual([
      "clinepass/a",
      "clinepass/unknown",
      "clinepass/can",
    ]);
  });

  test("a fallback call carries the same tools the primary got (QA1102-13)", async () => {
    const tools = [{ name: "web_search" }, { name: "connect_service" }];
    const boom = apiError(503, "service unavailable");
    const primary = fakeModel("p", async () => {
      throw boom;
    });
    const backup = fakeModel("b", async () => ({ stream: "ok" }));
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/b"],
      build: () => backup.model,
      log: () => {},
    });
    await wrapped.doStream({ prompt: 1, tools });
    expect(backup.calls[0]?.tools).toBe(tools);
  });

  test("notice text uses the short model name", () => {
    expect(fallbackNotice({ to: "clinepass/cline-free/step-5-preview", reason: "quota" })).toBe("主模型额度用完，已改用 step-5-preview");
    expect(fallbackNotice({ to: "codex/gpt-5.6-luna", reason: "unavailable" })).toBe("主模型暂时不可用，已改用 gpt-5.6-luna");
    expect(fallbackNotice({ to: "clinepass/solar-mini4", reason: "rejected" })).toBe("请求被主模型拒绝，已改用 solar-mini4");
  });

  // §101.10：主模型一直不回（不报错）时也换备用模型。
  describe("primary that never answers", () => {
    const parts = (stream: ReadableStream<{ type?: string }>) =>
      (async () => {
        const out: unknown[] = [];
        const reader = stream.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) return out;
          out.push(next.value);
        }
      })();
    const hangs = () =>
      fakeModel("p", () => new Promise(() => {})).model;

    test("doGenerate that hangs past the deadline goes to the backup and cools the primary 1 min", async () => {
      const backup = fakeModel("b", async () => ({ ok: "b" }));
      const logs: Record<string, unknown>[] = [];
      const wrapped = fallbackLanguageModel(hangs(), "c/p", { candidates: async () => ["c/b"], build: () => backup.model, log: (l) => logs.push(l), firstOutputMs: 30 });
      const seen: FallbackUse[] = [];
      expect(await withFallbackListener((use) => seen.push(use), () => wrapped.doGenerate({}))).toEqual({ ok: "b" });
      expect(seen).toEqual([{ from: "c/p", to: "c/b", reason: "unavailable" }]);
      expect(logs.some((l) => l.event === "primary-timeout")).toBe(true);
      expect(coolingDown("c/p", Date.now() + 30_000)).toBe(true);
      expect(coolingDown("c/p", Date.now() + 61_000)).toBe(false);
    });

    test("doStream whose stream only says stream-start counts as no output; the hung request is aborted", async () => {
      let signal: AbortSignal | undefined;
      const primary = {
        modelId: "p",
        async doStream(options: { abortSignal?: AbortSignal }) {
          signal = options.abortSignal;
          return { stream: new ReadableStream({ start: (c) => c.enqueue({ type: "stream-start" }) }) };
        },
      };
      const backup = fakeModel("b", async () => ({ ok: "b" }));
      const wrapped = fallbackLanguageModel(primary, "c/p", { candidates: async () => ["c/b"], build: () => backup.model, log: () => {}, firstOutputMs: 30 });
      expect(await wrapped.doStream({})).toEqual({ ok: "b" });
      expect(signal?.aborted).toBe(true);
    });

    test("a primary that streams in time is untouched: same parts in order, nothing announced", async () => {
      const primary = {
        modelId: "p",
        async doStream() {
          return {
            request: { id: 1 },
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: "stream-start" });
                c.enqueue({ type: "text-delta", delta: "你" });
                setTimeout(() => {
                  c.enqueue({ type: "text-delta", delta: "好" });
                  c.close();
                }, 60);
              },
            }),
          };
        },
      };
      const wrapped = fallbackLanguageModel(primary, "c/p", { candidates: async () => ["c/b"], build: () => null, log: () => {}, firstOutputMs: 30 });
      const seen: FallbackUse[] = [];
      const result = (await withFallbackListener((use) => seen.push(use), () => wrapped.doStream({}))) as { request: unknown; stream: ReadableStream<{ type?: string }> };
      expect(result.request).toEqual({ id: 1 });
      expect(await parts(result.stream)).toEqual([{ type: "stream-start" }, { type: "text-delta", delta: "你" }, { type: "text-delta", delta: "好" }]);
      expect(seen).toEqual([]);
      expect(coolingDown("c/p")).toBe(false);
    });

    test("the person pressing stop is not a timeout: no backup", async () => {
      const backup = fakeModel("b", async () => ({ ok: "b" }));
      const primary = {
        modelId: "p",
        doGenerate: (options: { abortSignal?: AbortSignal }) =>
          new Promise((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
      };
      const wrapped = fallbackLanguageModel(primary, "c/p", { candidates: async () => ["c/b"], build: () => backup.model, log: () => {}, firstOutputMs: 5_000 });
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 20);
      await expect(wrapped.doGenerate({ abortSignal: stop.signal })).rejects.toThrow("aborted");
      expect(backup.calls.length).toBe(0);
    });

    test("no backup configured: no deadline, the primary is waited for", async () => {
      const primary = fakeModel("p", () => new Promise((resolve) => setTimeout(() => resolve({ ok: "slow" }), 80)));
      const wrapped = fallbackLanguageModel(primary.model, "c/p", { candidates: async () => [], build: () => null, log: () => {}, firstOutputMs: 20 });
      expect(await wrapped.doGenerate({})).toEqual({ ok: "slow" });
    });

    test("a backup candidate that hangs past the deadline is aborted and falls through to the next candidate", async () => {
      const hungBackup = fakeModel("b1", () => new Promise(() => {})).model;
      const goodBackup = fakeModel("b2", async () => ({ ok: "b2" }));
      const wrapped = fallbackLanguageModel(hangs(), "c/p", {
        candidates: async () => ["c/b1", "c/b2"],
        build: (id) => (id === "c/b1" ? hungBackup : goodBackup.model),
        log: () => {},
        firstOutputMs: 25,
      });
      expect(await wrapped.doGenerate({})).toEqual({ ok: "b2" });
      expect(coolingDown("c/b1")).toBe(true);
    });
  });
});
