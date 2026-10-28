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
    expect(logs.map((l) => l.event)).toEqual(["primary-quota", "used", "used"]);
    // after the cooldown the primary is tried again
    t += 20 * 3600_000;
    expect(coolingDown("clinepass/p", t)).toBe(false);
    await wrapped.doStream({ prompt: 3 });
    expect(primary.calls.length).toBe(2);
  });

  test("non-quota errors are thrown unchanged and do not fall back", async () => {
    const boom = apiError(400, "bad request");
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

  test("5xx / overloaded fall back too (short cooldown); 400/401/network do not", async () => {
    expect(fallbackReason(DAILY)).toBe("quota");
    expect(fallbackReason(apiError(503, "service unavailable"))).toBe("unavailable");
    expect(fallbackReason(apiError(529, "overloaded"))).toBe("unavailable");
    expect(fallbackReason(apiError(500, "upstream exploded"))).toBe("unavailable");
    expect(fallbackReason(apiError(400, "invalid tool schema"))).toBe(null);
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
    expect(coolingDown("m/p", 60_000)).toBe(true);
    expect(coolingDown("m/p", 2 * 60_000 + 1)).toBe(false);
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

  test("notice text uses the short model name", () => {
    expect(fallbackNotice({ to: "clinepass/cline-free/step-5-preview", reason: "quota" })).toBe("主模型额度用完，已改用 step-5-preview");
    expect(fallbackNotice({ to: "codex/gpt-5.6-luna", reason: "unavailable" })).toBe("主模型暂时不可用，已改用 gpt-5.6-luna");
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
