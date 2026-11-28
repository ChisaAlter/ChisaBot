/**
 * 场景化连接解析包装：把「按场景配置的主模型」套用到现有的运行时连接解析上。
 *
 * 用于 titler / review / 连通性自检这类「单次模型调用」的消费方：它们每次调用前都通过
 * RuntimeModelResolver 取一份连接快照，因此只要在快照返回前按场景配置覆盖
 * `model.defaultModel`，场景主模型就生效了；其余字段（provider / baseUrl / apiKey /
 * keyPool）逐字节保留，空配置时返回值与原解析器完全一致。
 *
 * 不做的事：
 * - 不注入 fallback 链——这些消费方本身没有备用链概念（失败重试由各自队列负责）；
 * - 不改 effort / timeout——需要 per-call 动态机制的消费方各自接入（chat 已在 dsh-runtime）。
 */
import {
  type ModelScenario,
  resolveScenarioRoute,
  type ScenarioRouteEventInput,
  scenarioRouteOverrides,
} from "../../../shared/model-scenario-routing";
import type { RuntimeModelResolver } from "../conversation-runtime";
import type { ScenarioRoutingService } from "./model-scenario-routing";

/** 决策日志回调：由 composition root 注入落库策略；缺省不记。 */
export type ScenarioEventLogger = (
  event: ScenarioRouteEventInput,
) => Promise<void> | void;

export function scenarioConnectionResolver(
  scenario: ModelScenario,
  base: RuntimeModelResolver,
  routing: Pick<ScenarioRoutingService, "config">,
  log?: ScenarioEventLogger,
): RuntimeModelResolver {
  return async () => {
    const [connection, config] = await Promise.all([
      base(),
      routing.config().catch(() => null),
    ]);
    const route = config ? resolveScenarioRoute(config, scenario) : null;
    if (!route?.model) return connection;
    void log?.({
      scenario,
      consumer: scenario === "title" ? "title" : "chat",
      configured: scenarioRouteOverrides(route).length > 0,
      chain: [route.model],
      chosenModel: route.model,
      outcome: "resolved",
    })?.catch?.(() => {});
    return {
      ...connection,
      model: { ...connection.model, defaultModel: route.model },
    };
  };
}

/**
 * 场景化 completer 链：单次文本调用（审批审查这类）在场景配置了主模型时按
 * `primary → fallbacks` 顺序尝试，任一成功即返回；全部失败抛最后一次错误，
 * 由消费方自己的重试 / 降级逻辑处理。场景未配置时逐字节沿用基础 completer——
 * 也就是升级前「部署默认模型一次调用」的行为。
 *
 * 每一次尝试都独立取连接快照（与现状一致：轮换的凭据下一次调用即生效），
 * 只覆盖 `model.defaultModel` 为链上对应模型。
 */
export function createScenarioCompleter(options: {
  scenario: ModelScenario;
  routing: Pick<ScenarioRoutingService, "config">;
  baseConnection: RuntimeModelResolver;
  /** 给定连接解析器构造一个单模型 completer（通常是 createModelCompleter 的偏应用）。 */
  completerFor: (
    resolveConnection: RuntimeModelResolver,
  ) => (prompt: string, signal?: AbortSignal) => Promise<string>;
  log?: ScenarioEventLogger;
}): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt, signal) => {
    const config = await options.routing.config().catch(() => null);
    const route = config
      ? resolveScenarioRoute(config, options.scenario)
      : null;
    const chain = route
      ? [route.model, ...route.fallbacks].filter(Boolean)
      : [];
    if (!chain.length) {
      return options.completerFor(options.baseConnection)(prompt, signal);
    }
    let lastError: unknown = new Error("没有可用的模型。");
    for (const [index, modelId] of chain.entries()) {
      const resolveConnection: RuntimeModelResolver = async () => {
        const connection = await options.baseConnection();
        return {
          ...connection,
          model: { ...connection.model, defaultModel: modelId },
        };
      };
      try {
        const text = await options.completerFor(resolveConnection)(
          prompt,
          signal,
        );
        void options
          .log?.({
            scenario: options.scenario,
            consumer: "review",
            configured: true,
            chain,
            chosenModel: modelId,
            outcome: index === 0 ? "resolved" : "fallback",
            detail:
              index === 0
                ? null
                : `主模型 ${chain[0]} 失败，由链上第 ${index + 1} 位接管。`,
          })
          ?.catch?.(() => {});
        return text;
      } catch (error) {
        lastError = error;
      }
    }
    void options
      .log?.({
        scenario: options.scenario,
        consumer: "review",
        configured: true,
        chain,
        chosenModel: null,
        outcome: "failed",
        detail: "链上全部模型调用失败。",
      })
      ?.catch?.(() => {});
    throw lastError;
  };
}
