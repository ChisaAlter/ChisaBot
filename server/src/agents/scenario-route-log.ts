/**
 * 场景路由决策日志存储（PR3）。
 *
 * 运行时幂等建表 `chisabot_scenario_route_events`（30 天自动清理），只存决议元数据——
 * 场景、消费方、有序模型链、命中模型、覆盖来源与脱敏短注记；绝不记录 prompt 或对话内容。
 * 与自适应路由日志（routing-log.ts）互补：那边记「难度怎么分」，这边记「场景怎么选」。
 * 提供 PG 与纯内存双实现，方便无外部数据库运行单元测试。
 */
import { randomUUID } from "node:crypto";
import {
  isModelScenario,
  type ModelScenario,
  SCENARIO_ROUTE_CONSUMERS,
  SCENARIO_ROUTE_OUTCOMES,
  type ScenarioRouteConsumer,
  type ScenarioRouteEvent,
  type ScenarioRouteEventInput,
  type ScenarioRouteOutcome,
} from "../../../shared/model-scenario-routing";
import type { Database } from "../db/client";

export const SCENARIO_ROUTE_LOG_RETENTION_DAYS = 30;
export const SCENARIO_ROUTE_LOG_MAX_LIMIT = 200;
const DEFAULT_LOG_LIMIT = 50;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_DETAIL_LENGTH = 160;

export type ScenarioRouteLogQuery = {
  limit?: number;
  scenario?: ModelScenario;
  consumer?: ScenarioRouteConsumer;
};

export type ScenarioRouteLogStorage = {
  ensure(): Promise<void>;
  append(entry: ScenarioRouteEventInput): Promise<ScenarioRouteEvent>;
  list(query?: ScenarioRouteLogQuery): Promise<{
    items: ScenarioRouteEvent[];
    total: number;
  }>;
  pruneOlderThan(days?: number, nowMs?: number): Promise<number>;
};

export type ScenarioRouteDatabaseClient = {
  $client: Pick<Database["$client"], "unsafe">;
};

type EventRow = {
  id: string;
  created_at: Date | string;
  scenario: string;
  consumer: string;
  configured: boolean;
  chain_json: string;
  chosen_model: string | null;
  outcome: string;
  detail: string | null;
  dry_run: boolean;
};

function normalizeConsumer(value: string): ScenarioRouteConsumer {
  return (SCENARIO_ROUTE_CONSUMERS as readonly string[]).includes(value)
    ? (value as ScenarioRouteConsumer)
    : "chat";
}

function normalizeOutcome(value: string): ScenarioRouteOutcome {
  return (SCENARIO_ROUTE_OUTCOMES as readonly string[]).includes(value)
    ? (value as ScenarioRouteOutcome)
    : "resolved";
}

function mapEventRow(row: EventRow): ScenarioRouteEvent {
  let chain: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.chain_json);
    if (Array.isArray(parsed))
      chain = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    chain = [];
  }
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    scenario: isModelScenario(row.scenario) ? row.scenario : "chat",
    consumer: normalizeConsumer(row.consumer),
    configured: Boolean(row.configured),
    chain,
    chosenModel: row.chosen_model ?? null,
    outcome: normalizeOutcome(row.outcome),
    detail: row.detail ?? null,
    dryRun: Boolean(row.dry_run),
  };
}

function validateInput(
  entry: ScenarioRouteEventInput,
): ScenarioRouteEventInput {
  return {
    ...entry,
    chain: entry.chain
      .filter((id) => typeof id === "string" && id)
      .slice(0, 12),
    detail: entry.detail ? entry.detail.slice(0, MAX_DETAIL_LENGTH) : null,
  };
}

export function createPgScenarioRouteLogStorage(
  database: ScenarioRouteDatabaseClient,
  options?: { now?: () => number },
): ScenarioRouteLogStorage {
  const sql = database.$client;
  const nowFn = options?.now ?? Date.now;
  let lastPruneAt = 0;

  async function ensure(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_scenario_route_events (
        id text PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        scenario text NOT NULL,
        consumer text NOT NULL,
        configured boolean NOT NULL DEFAULT false,
        chain_json text NOT NULL DEFAULT '[]',
        chosen_model text,
        outcome text NOT NULL,
        detail text,
        dry_run boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS idx_chisabot_scenario_route_events_created_at
        ON chisabot_scenario_route_events (created_at DESC);
    `);
  }

  async function pruneOlderThan(
    days = SCENARIO_ROUTE_LOG_RETENTION_DAYS,
    nowMs = nowFn(),
  ): Promise<number> {
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
    const removed = await sql.unsafe<{ id: string }[]>(
      "DELETE FROM chisabot_scenario_route_events WHERE created_at < $1 RETURNING id",
      [cutoff],
    );
    lastPruneAt = nowMs;
    return removed.length;
  }

  return {
    ensure,
    async append(entry) {
      const clean = validateInput(entry);
      const id = randomUUID();
      const createdAt = new Date(nowFn());
      await sql.unsafe(
        `INSERT INTO chisabot_scenario_route_events (
           id, created_at, scenario, consumer, configured, chain_json,
           chosen_model, outcome, detail, dry_run
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          createdAt.toISOString(),
          clean.scenario,
          clean.consumer,
          clean.configured,
          JSON.stringify(clean.chain),
          clean.chosenModel,
          clean.outcome,
          clean.detail,
          clean.dryRun === true,
        ],
      );
      if (nowFn() - lastPruneAt > PRUNE_INTERVAL_MS) {
        lastPruneAt = nowFn();
        await pruneOlderThan().catch(() => 0);
      }
      return {
        id,
        createdAt: createdAt.toISOString(),
        scenario: clean.scenario,
        consumer: clean.consumer,
        configured: clean.configured,
        chain: clean.chain,
        chosenModel: clean.chosenModel,
        outcome: clean.outcome,
        detail: clean.detail ?? null,
        dryRun: clean.dryRun === true,
      };
    },
    async list(query) {
      const limit = Math.max(
        1,
        Math.min(
          query?.limit ?? DEFAULT_LOG_LIMIT,
          SCENARIO_ROUTE_LOG_MAX_LIMIT,
        ),
      );
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (query?.scenario) {
        params.push(query.scenario);
        conditions.push(`scenario = $${params.length}`);
      }
      if (query?.consumer) {
        params.push(query.consumer);
        conditions.push(`consumer = $${params.length}`);
      }
      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";
      const rows = await sql.unsafe<EventRow[]>(
        `SELECT * FROM chisabot_scenario_route_events ${where}
         ORDER BY created_at DESC LIMIT ${limit}`,
        params,
      );
      const counted = await sql.unsafe<{ count: number | string }[]>(
        `SELECT count(*) AS count FROM chisabot_scenario_route_events ${where}`,
        params,
      );
      return {
        items: rows.map(mapEventRow),
        total: Number(counted[0]?.count ?? 0),
      };
    },
    pruneOlderThan,
  };
}

export function createMemoryScenarioRouteLogStorage(options?: {
  now?: () => number;
}): ScenarioRouteLogStorage & { entries: ScenarioRouteEvent[] } {
  const nowFn = options?.now ?? Date.now;
  const entries: ScenarioRouteEvent[] = [];
  return {
    entries,
    async ensure() {},
    async append(entry) {
      const clean = validateInput(entry);
      const event: ScenarioRouteEvent = {
        id: randomUUID(),
        createdAt: new Date(nowFn()).toISOString(),
        scenario: clean.scenario,
        consumer: clean.consumer,
        configured: clean.configured,
        chain: clean.chain,
        chosenModel: clean.chosenModel,
        outcome: clean.outcome,
        detail: clean.detail ?? null,
        dryRun: clean.dryRun === true,
      };
      entries.unshift(event);
      return event;
    },
    async list(query) {
      const limit = Math.max(
        1,
        Math.min(
          query?.limit ?? DEFAULT_LOG_LIMIT,
          SCENARIO_ROUTE_LOG_MAX_LIMIT,
        ),
      );
      const filtered = entries.filter(
        (event) =>
          (!query?.scenario || event.scenario === query.scenario) &&
          (!query?.consumer || event.consumer === query.consumer),
      );
      return { items: filtered.slice(0, limit), total: filtered.length };
    },
    async pruneOlderThan(
      days = SCENARIO_ROUTE_LOG_RETENTION_DAYS,
      nowMs = nowFn(),
    ) {
      const cutoff = nowMs - days * 86_400_000;
      const before = entries.length;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const event = entries[index];
        if (event && Date.parse(event.createdAt) < cutoff)
          entries.splice(index, 1);
      }
      return before - entries.length;
    },
  };
}
