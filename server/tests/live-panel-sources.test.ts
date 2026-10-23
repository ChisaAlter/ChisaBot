import { describe, expect, test } from "bun:test";
import {
  createSourceRunner,
  normalizeSources,
  readSource,
  sourceLabel,
  type LivePanelSourceDeps,
  type LivePanelSourceRunnerStore,
  type ReadSourceContext,
} from "../src/live-panels/sources";
import { createLivePanelService, toDto } from "../src/live-panels/service";
import type { LivePanelStore } from "../src/live-panels/store";
import type { LivePanelDataSource, LivePanelSourceState } from "../src/live-panels/source-types";

/**
 * 直连数据源（docs/live-panel-sources.md）纯单元测试：不连数据库、不真发请求。
 * HTTP 走注入的 requestHttp，命令走注入的 commandRunner，所以能精确控制成功 / 失败 / 并发。
 */

/** 一个默认合法的 http 源（name / url / intervalSec 可按需覆盖）。 */
function httpSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "http",
    name: "CoinGecko",
    url: "https://api.example.com/simple/price?ids=bitcoin&vs_currencies=usd",
    intervalSec: 60,
    parse: "json",
    ...overrides,
  };
}

/** 校验时的默认开关：命令可用、非管理员（各用例再覆盖）。 */
function normalize(raw: unknown, options: { isAdmin?: boolean; existing?: LivePanelDataSource[]; env?: Record<string, string | undefined> } = {}) {
  return normalizeSources(raw, {
    isAdmin: options.isAdmin ?? false,
    ...(options.existing ? { existing: options.existing } : {}),
    env: options.env ?? { CHISABOT_PANEL_COMMANDS: "1" },
  });
}

/** 执行一次取数的默认上下文：管理员、命令开关打开、固定的时钟。 */
function context(extra: Partial<ReadSourceContext> = {}): ReadSourceContext {
  return {
    owner: "u1",
    isAdmin: true,
    env: { CHISABOT_PANEL_COMMANDS: "1" },
    now: () => new Date("2026-10-22T00:00:00.000Z"),
    ...extra,
  };
}

const commandSource = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "command",
  name: "本机负载",
  command: "uptime",
  intervalSec: 10,
  parse: "text",
  ...overrides,
});

describe("数据源校验", () => {
  test("intervalSec 夹到 2–3600，不填默认 60", () => {
    const out = normalize([
      httpSource({ intervalSec: 0 }),
      httpSource({ name: "第二个", url: "https://two.example.com/x", intervalSec: 999_999 }),
      httpSource({ name: "第三个", url: "https://three.example.com/x", intervalSec: undefined }),
    ]);
    expect(out.map((source) => source.intervalSec)).toEqual([2, 3600, 60]);
  });

  test("一张面板最多 3 个数据源", () => {
    const many = Array.from({ length: 4 }, (_, index) => httpSource({ name: `源 ${index}`, url: `https://s${index}.example.com/x` }));
    expect(() => normalize(many)).toThrow(/最多 3 个数据源/);
  });

  test("http 只允许 https，拒绝内网与带账号密码的网址", () => {
    expect(() => normalize([httpSource({ url: "http://api.example.com/x" })])).toThrow(/只支持 https/);
    expect(() => normalize([httpSource({ url: "https://127.0.0.1/x" })])).toThrow(/内网/);
    expect(() => normalize([httpSource({ url: "https://10.1.2.3/x" })])).toThrow(/内网/);
    expect(() => normalize([httpSource({ url: "https://user:pass@api.example.com/x" })])).toThrow(/账号密码/);
    expect(() => normalize([httpSource({ url: "file:///etc/passwd" })])).toThrow(/https/);
  });

  test("请求头里的明文密钥被拒，{{secret:名}} 放行", () => {
    expect(() => normalize([httpSource({ headers: { Authorization: "Bearer sk-live-abcdefghijklmnopqrstuvwxyz012345" } })])).toThrow(/secret/);
    expect(() => normalize([httpSource({ headers: { "X-Api-Key": "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } })])).toThrow(/secret/);
    const allowed = normalize([httpSource({ headers: { Authorization: "Bearer {{secret:coingecko_token}}" } })]);
    expect(allowed[0]?.headers).toEqual({ Authorization: "Bearer {{secret:coingecko_token}}" });
    // 路径里的占位符不能被 new URL() 编码成 %7B%7B…%7D%7D，否则保险箱替换不到。
    const pathSecret = normalize([httpSource({ url: "https://api.example.com/data/{{secret:path_token}}?q=1" })])[0]!;
    expect(pathSecret.url).toContain("{{secret:path_token}}");
    // 写成大写名字不会被当成占位符，应该直接拒绝（密钥名只认小写）。
    expect(() => normalize([httpSource({ headers: { Authorization: "Bearer {{secret:API_KEY}}" } })])).toThrow(/写法不对/);
  });

  test("id 是 src_ 前缀，按 name 复用；改名就换新 id", () => {
    const first = normalize([httpSource()]);
    expect(first[0]!.id).toMatch(/^src_[a-z0-9]{12}$/);
    const sameName = normalize([httpSource({ intervalSec: 10 })], { existing: first });
    expect(sameName[0]!.id).toBe(first[0]!.id);
    const renamed = normalize([httpSource({ name: "另一个来源" })], { existing: first });
    expect(renamed[0]!.id).not.toBe(first[0]!.id);
    expect(() => normalize([httpSource(), httpSource({ url: "https://two.example.com/x" })])).toThrow(/名字重复/);
  });

  test("命令源要管理员 + CHISABOT_PANEL_COMMANDS=1", () => {
    expect(() => normalize([commandSource()], { isAdmin: true, env: {} })).toThrow(/CHISABOT_PANEL_COMMANDS/);
    expect(() => normalize([commandSource()], { isAdmin: false, env: { CHISABOT_PANEL_COMMANDS: "1" } })).toThrow(/管理员/);
    const out = normalize([commandSource()], { isAdmin: true, env: { CHISABOT_PANEL_COMMANDS: "1" } });
    expect(out[0]).toMatchObject({ kind: "command", name: "本机负载", command: "uptime", parse: "text" });
    expect(() => normalize([commandSource({ command: "" })], { isAdmin: true, env: { CHISABOT_PANEL_COMMANDS: "1" } })).toThrow(/command/);
  });

  test("展示串：http 只写 host + path，命令写原文（截断 200 字）", () => {
    const [http] = normalize([httpSource({ url: "https://api.example.com/v3/price?secret=abc" })]);
    expect(sourceLabel(http!)).toBe("api.example.com/v3/price");
    const longCommand = `echo ${"x".repeat(300)}`;
    const [command] = normalize([commandSource({ command: longCommand })], { isAdmin: true, env: { CHISABOT_PANEL_COMMANDS: "1" } });
    expect(sourceLabel(command!).length).toBe(200);
  });
});

describe("取一次数：解析", () => {
  const definition = (parse: "json" | "text" | "number"): LivePanelDataSource => normalize([httpSource({ parse })])[0]!;

  test("json 解析整段对象", async () => {
    const seen: { method?: string; headers?: Record<string, string> }[] = [];
    const deps: LivePanelSourceDeps = {
      requestHttp: async (_owner, input) => {
        seen.push(input);
        return { status: 200, contentType: "application/json", body: '{"bitcoin":{"usd":81272}}' };
      },
    };
    const reading = await readSource(definition("json"), deps, context());
    expect(reading.ok).toBe(true);
    expect(reading.value).toEqual({ bitcoin: { usd: 81272 } });
    expect(reading.error).toBeUndefined();
    expect(seen[0]!.method).toBe("GET");
  });

  test("text 解析原文（超过 20000 字截断）", async () => {
    const deps: LivePanelSourceDeps = { requestHttp: async () => ({ status: 200, body: `hello ${"x".repeat(25_000)}` }) };
    const reading = await readSource(definition("text"), deps, context());
    expect(reading.ok).toBe(true);
    expect(typeof reading.value).toBe("string");
    expect((reading.value as string).length).toBe(20_000);
  });

  test("number 从原文里取一个数", async () => {
    const deps: LivePanelSourceDeps = { requestHttp: async () => ({ status: 200, body: "price: 42.5 USD" }) };
    const reading = await readSource(definition("number"), deps, context());
    expect(reading.ok).toBe(true);
    expect(reading.value).toBe(42.5);
  });

  test("不是 JSON / HTTP 失败 → 中文原因（不抛错）", async () => {
    const badJson = await readSource(definition("json"), { requestHttp: async () => ({ status: 200, body: "<html>nope</html>" }) }, context());
    expect(badJson.ok).toBe(false);
    expect(badJson.value).toBeNull();
    expect(badJson.error).toContain("JSON");

    const http500 = await readSource(definition("json"), { requestHttp: async () => ({ status: 500, body: "oops" }) }, context());
    expect(http500.ok).toBe(false);
    expect(http500.error).toContain("500");
  });
});

describe("取一次数：命令", () => {
  const definition = normalize([commandSource()], { isAdmin: true, env: { CHISABOT_PANEL_COMMANDS: "1" } })[0]!;

  test("走注入的命令执行器，剥掉 ANSI 颜色", async () => {
    const deps: LivePanelSourceDeps = {
      commandRunner: async () => ({ stdout: "\u001b[32mup 3 days\u001b[0m\r\n", stderr: "", exitCode: 0 }),
    };
    const reading = await readSource(definition, deps, context());
    expect(reading.ok).toBe(true);
    expect(reading.value).toBe("up 3 days\n");
  });

  test("退出码非 0 → 失败；读取时重新检查开关与管理员", async () => {
    const deps: LivePanelSourceDeps = { commandRunner: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }) };
    const failed = await readSource(definition, deps, context());
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("退出码 1");
    expect(failed.error).toContain("boom");

    const disabled = await readSource(definition, deps, context({ env: {} }));
    expect(disabled.ok).toBe(false);
    expect(disabled.error).toContain("CHISABOT_PANEL_COMMANDS");

    const notAdmin = await readSource(definition, deps, context({ isAdmin: false }));
    expect(notAdmin.ok).toBe(false);
    expect(notAdmin.error).toContain("管理员");
  });
});

describe("错误信息不带密钥", () => {
  test("上游错误里混进的 token 被抹掉，长度 ≤ 300", async () => {
    const definition = normalize([httpSource()])[0]!;
    const deps: LivePanelSourceDeps = {
      requestHttp: async () => {
        throw new Error("接口返回错误：sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 无效");
      },
    };
    const reading = await readSource(definition, deps, context());
    expect(reading.ok).toBe(false);
    expect(reading.error).toContain("接口返回错误");
    expect(reading.error).not.toContain("sk-live-");
    expect(reading.error).not.toContain("ABCDEFGH");
    expect(reading.error!.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// 缓存 / 单飞 / 失败保留旧值
// ---------------------------------------------------------------------------

function fakeStore(dataSources: LivePanelDataSource[], sourceState: LivePanelSourceState = {}) {
  const row = { id: "lp_1", dataSources, sourceState };
  const writes: LivePanelSourceState[] = [];
  const store: LivePanelSourceRunnerStore = {
    async get() {
      return row;
    },
    async setSourceState(_owner, _id, state) {
      row.sourceState = state;
      writes.push(state);
    },
  };
  return { row, store, writes };
}

const goodReading = (value: unknown, at: string): { ok: true; value: unknown; at: string; ms: number } => ({ ok: true, value, at, ms: 5 });

describe("新鲜度 / force / 失败保留旧值", () => {
  test("间隔内用缓存，过期才取；force 一定重取", async () => {
    const definition = normalize([httpSource({ intervalSec: 60 })])[0]!;
    const at = new Date("2026-10-22T00:00:00.000Z").toISOString();
    const { row, store, writes } = fakeStore([definition], { [definition.id]: goodReading({ price: 1 }, at) });
    let clock = new Date("2026-10-22T00:00:30.000Z");
    let calls = 0;
    const runner = createSourceRunner({
      store,
      now: () => clock,
      deps: {
        requestHttp: async () => {
          calls += 1;
          return { status: 200, body: '{"price":2}' };
        },
      },
      log: () => {},
    });

    const fresh = await runner.readings("u1", row);
    expect(calls).toBe(0);
    expect(fresh.refreshed).toEqual([]);
    expect(fresh.sources[definition.id]!.value).toEqual({ price: 1 });

    clock = new Date("2026-10-22T00:02:00.000Z"); // 120 秒 > 60 秒
    const stale = await runner.readings("u1", row);
    expect(calls).toBe(1);
    expect(stale.refreshed).toEqual([definition.id]);
    expect(stale.sources[definition.id]!.value).toEqual({ price: 2 });
    expect(writes.length).toBe(1);

    const forced = await runner.readings("u1", row, { force: true });
    expect(calls).toBe(2);
    expect(forced.refreshed).toEqual([definition.id]);
  });

  test("失败也写回，但不覆盖上一次的好值", async () => {
    const definition = normalize([httpSource()])[0]!;
    const at = new Date("2026-10-22T00:00:00.000Z").toISOString();
    const { row, store } = fakeStore([definition], { [definition.id]: goodReading({ price: 7 }, at) });
    const runner = createSourceRunner({
      store,
      now: () => new Date("2026-10-22T02:00:00.000Z"),
      deps: {
        requestHttp: async () => {
          throw new Error("network down");
        },
      },
      log: () => {},
    });

    const result = await runner.readings("u1", row, { force: true });
    const reading = result.sources[definition.id]!;
    expect(reading.ok).toBe(false);
    expect(reading.value).toEqual({ price: 7 }); // 旧值留着，卡片上数字不变
    expect(reading.error).toContain("失败");
    expect(row.sourceState[definition.id]!.ok).toBe(false);
    expect(row.sourceState[definition.id]!.value).toEqual({ price: 7 });
  });

  test("同一个源同时只跑一次（浏览器轮询 + 点立即取数不叠加）", async () => {
    const definition = normalize([httpSource()])[0]!;
    const { row, store } = fakeStore([definition]);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = createSourceRunner({
      store,
      now: () => new Date("2026-10-22T00:00:00.000Z"),
      deps: {
        requestHttp: async () => {
          calls += 1;
          await gate;
          return { status: 200, body: '{"price":3}' };
        },
      },
      log: () => {},
    });

    const one = runner.readings("u1", row, { force: true });
    const two = runner.readings("u1", row, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    release();
    const [first, second] = await Promise.all([one, two]);
    expect(first.sources[definition.id]!.value).toEqual({ price: 3 });
    expect(second.sources[definition.id]!.value).toEqual({ price: 3 });
  });

  test("不同面板的源一起取时最多 3 个并发", async () => {
    const make = (prefix: string) =>
      normalize([
        httpSource({ name: `${prefix}1`, url: `https://${prefix}1.example.com/x` }),
        httpSource({ name: `${prefix}2`, url: `https://${prefix}2.example.com/x` }),
        httpSource({ name: `${prefix}3`, url: `https://${prefix}3.example.com/x` }),
      ]);
    const rowA = { id: "lp_a", dataSources: make("a"), sourceState: {} as LivePanelSourceState };
    const rowB = { id: "lp_b", dataSources: make("b"), sourceState: {} as LivePanelSourceState };
    const rows = new Map([
      [rowA.id, rowA],
      [rowB.id, rowB],
    ]);
    // 正式部署里一张面板共用一个 runner（sourceRunner），并发上限是全局的 3，不是每张面板 3。
    const store: LivePanelSourceRunnerStore = {
      async get(_owner, id) {
        return rows.get(id);
      },
      async setSourceState(_owner, id, state) {
        const row = rows.get(id);
        if (row) row.sourceState = state;
      },
    };
    let active = 0;
    let max = 0;
    const deps: LivePanelSourceDeps = {
      requestHttp: async () => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { status: 200, body: "1" };
      },
    };
    const runner = createSourceRunner({ store, deps, log: () => {} });
    await Promise.all([runner.readings("u1", rowA, { force: true }), runner.readings("u1", rowB, { force: true })]);
    expect(max).toBeLessThanOrEqual(3);
    expect(max).toBeGreaterThan(1);
  });
});

describe("面板工具：dataSources 传入与 /live 绑定", () => {
  function panelRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "lp_1",
      ownerUserId: "u1",
      botId: "b1",
      title: "比特币价格",
      status: "building",
      spec: null,
      sources: [],
      dataSources: [],
      sourceState: {},
      instruction: "看 BTC",
      refreshMinutes: 60,
      refreshAt: null,
      error: null,
      refreshedAt: null,
      nextRefreshAt: null,
      leaseUntil: null,
      failures: 0,
      position: 0,
      removed: false,
      removedAt: null,
      createdAt: new Date("2026-10-22T00:00:00.000Z"),
      updatedAt: new Date("2026-10-22T00:00:00.000Z"),
      previous: null,
      ...overrides,
    };
  }

  function fakeService(initial = panelRow()) {
    let row = initial;
    let lastUpdate: Record<string, unknown> | undefined;
    const store = {
      async get() {
        return row;
      },
      async list() {
        return [];
      },
      async create(_owner: string, _botId: string, input: Record<string, unknown>) {
        row = panelRow({ ...input, id: "lp_new", dataSources: (input.dataSources as LivePanelDataSource[]) ?? [] });
        return row;
      },
      async update(_owner: string, _id: string, input: Record<string, unknown>) {
        lastUpdate = input;
        row = { ...row, ...input, dataSources: (input.dataSources as LivePanelDataSource[]) ?? row.dataSources };
        return row;
      },
      async setSourceState() {},
    } as unknown as LivePanelStore;
    const service = createLivePanelService({ store, runHeadless: async () => {}, log: () => {}, requestHttp: async () => ({ status: 200, body: "{}" }) });
    return { service, getRow: () => row, getLastUpdate: () => lastUpdate };
  }

  const liveSpec = JSON.stringify({
    root: "r",
    elements: {
      r: { type: "Stack", props: { gap: "md" }, children: ["m"] },
      m: { type: "Metric", props: { label: "现价", value: { $state: "/live/src_placeholder" } }, children: [] },
    },
  });

  test("panel_update 挂了数据源时允许 Metric 绑 /live，并把规范化后的 dataSources 存下来", async () => {
    const { service, getLastUpdate } = fakeService(panelRow({ status: "ready", spec: JSON.stringify({ root: "r", elements: { r: { type: "Stack", props: {}, children: [] } } }) }));
    const update = service.tools("u1", "b1", { isAdmin: true }).find((tool) => tool.name === "panel_update")!;
    const result = String(
      await update.execute({
        id: "lp_1",
        sources: [{ name: "CoinGecko", url: "https://api.example.com/simple/price" }],
        dataSources: [{ kind: "http", name: "CoinGecko", url: "https://api.example.com/simple/price", intervalSec: 10, parse: "json" }],
        spec: liveSpec,
      }),
    );
    expect(result).not.toContain("面板没有保存");
    expect(result).toContain("数据源 id");
    const saved = getLastUpdate()!;
    const savedSources = saved.dataSources as LivePanelDataSource[];
    expect(savedSources).toHaveLength(1);
    expect(savedSources[0]!.id).toMatch(/^src_[a-z0-9]{12}$/);
    expect(savedSources[0]!.intervalSec).toBe(10);
  });

  test("panel_create 的 dataSources 存初值，返回 id 让机器人去绑 /live", async () => {
    const { service, getRow } = fakeService();
    const create = service.tools("u1", "b1", { isAdmin: true }).find((tool) => tool.name === "panel_create")!;
    const result = JSON.parse(
      String(
        await create.execute({
          title: "比特币价格",
          instruction: "看 BTC",
          // 不填 intervalSec：服务端给默认 60。
          dataSources: [{ kind: "http", name: "CoinGecko", url: "https://api.example.com/simple/price", parse: "json" }],
        }),
      ),
    ) as { id: string; dataSources: { id: string; name: string; intervalSec: number }[] };
    expect(result.id).toBe("lp_new");
    expect(result.dataSources[0]!.name).toBe("CoinGecko");
    expect(result.dataSources[0]!.intervalSec).toBe(60);
    expect(getRow().dataSources).toHaveLength(1);
  });

  test("panel_create / panel_update 默认对管理员开启 command 数据源，非管理员自动降级不报错", async () => {
    const { service, getRow } = fakeService();
    const adminCreate = service.tools("u1", "b1", { isAdmin: true }).find((tool) => tool.name === "panel_create")!;
    const createdAdmin = JSON.parse(
      String(
        await adminCreate.execute({
          title: "云服务器性能监控",
          instruction: "采集 CPU 与内存",
          dataSources: [{ kind: "command", name: "本机负载", command: "uptime", intervalSec: 15, parse: "text" }],
        }),
      ),
    ) as { id: string; dataSources: { id: string; kind: string }[] };
    expect(createdAdmin.id).toBe("lp_new");
    expect(createdAdmin.dataSources).toHaveLength(1);
    expect(createdAdmin.dataSources[0]!.kind).toBe("command");

    const userCreate = service.tools("u1", "b1", { isAdmin: false }).find((tool) => tool.name === "panel_create")!;
    const createdUser = JSON.parse(
      String(
        await userCreate.execute({
          title: "服务器状态",
          instruction: "采集负载",
          duplicate: true,
          dataSources: [{ kind: "command", name: "本机负载", command: "uptime", intervalSec: 15, parse: "text" }],
        }),
      ),
    ) as { id: string; dataSources: unknown[]; next: string };
    expect(createdUser.id).toBe("lp_new");
    expect(createdUser.dataSources).toHaveLength(0);
    expect(createdUser.next).toContain("已自动忽略 command 数据源");
    expect(getRow().dataSources).toHaveLength(0);
  });
});

describe("DTO 与路由形状", () => {
  test("dataSources 只回 id / kind / name / intervalSec / label，不回 headers", async () => {
    const definition = normalize([
      httpSource({
        parse: "json",
        headers: {
          Authorization: "Bearer {{secret:coingecko_token}}",
        },
      }),
    ])[0]!;
    const row = {
      id: "lp_1",
      ownerUserId: "u1",
      botId: "b1",
      title: "比特币价格",
      status: "ready",
      spec: null,
      sources: [],
      dataSources: [definition],
      sourceState: {},
      instruction: "看 BTC",
      refreshMinutes: 60,
      refreshAt: null,
      error: null,
      refreshedAt: null,
      nextRefreshAt: null,
      leaseUntil: null,
      failures: 0,
      position: 0,
      removed: false,
      removedAt: null,
      createdAt: new Date("2026-10-22T00:00:00.000Z"),
      updatedAt: new Date("2026-10-22T00:00:00.000Z"),
      previous: null,
    };
    const dto = toDto(row as never);
    expect(dto.dataSources).toEqual([{ id: definition.id, kind: "http", name: "CoinGecko", intervalSec: 60, label: "api.example.com/simple/price" }]);
    expect(JSON.stringify(dto)).not.toContain("coingecko_token");
    expect(JSON.stringify(dto)).not.toContain("Authorization");
  });

  test("DTO 会把最近一次的好值塞进 spec.state.live；失败的读数不塞，库里的 spec 不变", () => {
    const definition = normalize([httpSource()])[0]!;
    const spec = JSON.stringify({
      root: "price",
      elements: { price: { type: "Metric", props: { label: "现价", value: { $state: `/live/${definition.id}` } } } },
      state: {},
    });
    const row = (sourceState: LivePanelSourceState) => ({
      id: "lp_1",
      ownerUserId: "u1",
      botId: "b1",
      title: "比特币价格",
      status: "ready",
      spec,
      sources: [],
      dataSources: [definition],
      sourceState,
      instruction: "看 BTC",
      refreshMinutes: 60,
      refreshAt: null,
      error: null,
      refreshedAt: null,
      nextRefreshAt: null,
      leaseUntil: null,
      failures: 0,
      position: 0,
      removed: false,
      removedAt: null,
      createdAt: new Date("2026-10-22T00:00:00.000Z"),
      updatedAt: new Date("2026-10-22T00:00:00.000Z"),
      previous: null,
    });
    const ok = toDto(row({ [definition.id]: { ok: true, value: "$81,272", at: "2026-10-22T01:00:00.000Z", ms: 12 } }) as never);
    expect((JSON.parse(ok.spec!) as { state: { live: Record<string, unknown> } }).state.live[definition.id]).toBe("$81,272");
    // 手机 / 第一帧：没有浏览器轮询也能看到数。
    const failed = toDto(row({ [definition.id]: { ok: false, error: "取数失败。", value: null, at: "2026-10-22T01:00:00.000Z", ms: 9 } }) as never);
    expect((JSON.parse(failed.spec!) as { state: { live?: unknown } }).state.live ?? {}).toEqual({});
    // 只读注入：库里那份规范一个字没动。
    expect(spec).toContain('"state":{}');
  });

  test("GET /:id/live 返回 { sources, refreshed }；取数失败也是 200", async () => {
    let fail = false;
    const definition = normalize([httpSource()])[0]!;
    const row = {
      id: "lp_1",
      ownerUserId: "u1",
      botId: "b1",
      title: "比特币价格",
      status: "ready",
      spec: null,
      sources: [],
      dataSources: [definition],
      sourceState: {} as LivePanelSourceState,
      instruction: "看 BTC",
      refreshMinutes: 60,
      refreshAt: null,
      error: null,
      refreshedAt: null,
      nextRefreshAt: null,
      leaseUntil: null,
      failures: 0,
      position: 0,
      removed: false,
      removedAt: null,
      createdAt: new Date("2026-10-22T00:00:00.000Z"),
      updatedAt: new Date("2026-10-22T00:00:00.000Z"),
      previous: null,
    };
    const store = {
      async get() {
        return row;
      },
      async setSourceState(_owner: string, _id: string, state: LivePanelSourceState) {
        row.sourceState = state;
      },
    } as unknown as LivePanelStore;
    const service = createLivePanelService({
      store,
      runHeadless: async () => {},
      requestHttp: async () => {
        if (fail) throw new Error("network down");
        return { status: 200, body: '{"price":1}' };
      },
      log: () => {},
    });
    const requireUser = (async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set("actor", { id: "u1", email: "u1@example.com", role: "user" });
      await next();
    }) as never;

    const ok = await service.routes(requireUser).request("/lp_1/live");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { sources: Record<string, { ok: boolean; value: unknown }>; refreshed: string[] };
    expect(body.sources[definition.id]!.value).toEqual({ price: 1 });
    expect(body.refreshed).toEqual([definition.id]);

    fail = true;
    const forced = await service.routes(requireUser).request("/lp_1/live/refresh", { method: "POST" });
    expect(forced.status).toBe(200);
    const failed = (await forced.json()) as { sources: Record<string, { ok: boolean; value: unknown; error?: string }> };
    expect(failed.sources[definition.id]!.ok).toBe(false);
    expect(failed.sources[definition.id]!.value).toEqual({ price: 1 }); // 失败保留上一次的好值
    expect(failed.sources[definition.id]!.error).toContain("失败");
  });
});
