/**
 * 确定性有限状态空间模型检验器（BFS 广度优先穷举 + 最短反例路径生成）。
 *
 * 用于验证锁租约、权限授权/策略/审计、一次性审批门及聊天账本同步等核心状态机，
 * 对从初始状态出发的每个可达状态逐条检验不变式与无死锁活性。
 */

export interface ModelTransition<S> {
  /** 迁移动作名称（会出现在反例路径中）。 */
  name: string;
  /** 前置条件：返回 true 时才会在当前状态触发此动作。 */
  guard: (state: Readonly<S>) => boolean;
  /** 纯状态转移函数：返回新的状态快照，禁止原地修改入参。 */
  apply: (state: Readonly<S>) => S;
}

export interface ModelInvariant<S> {
  /** 不变式名称。 */
  name: string;
  /** 返回 true 表示满足；返回 false 或非空失败说明字符串表示违背不变式。 */
  check: (state: Readonly<S>) => boolean | string;
}

export interface StateModel<S> {
  name: string;
  initial: () => S;
  canonicalize: (state: Readonly<S>) => string;
  transitions: readonly ModelTransition<S>[];
  invariants: readonly ModelInvariant<S>[];
  /** 合法终止状态判定：返回 true 时允许没有任何后继迁移动作而不视作死锁。 */
  isTerminal?: (state: Readonly<S>) => boolean;
  /** 是否允许在非终止状态下出现「零可用动作」而不报死锁（默认 false）。 */
  allowStutterWhenNoEnabledTransition?: boolean;
}

export interface ModelCheckOptions {
  /** 防止状态空间爆炸的安全上限（默认 20_000）。 */
  maxStates?: number;
}

export interface Counterexample<S> {
  kind: "invariant" | "deadlock" | "state_limit";
  failedInvariant?: string;
  detail: string;
  actions: string[];
  states: S[];
}

export interface ModelCheckResult<S> {
  ok: boolean;
  exploredStates: number;
  exploredTransitions: number;
  counterexample?: Counterexample<S>;
}

const DEFAULT_MAX_STATES = 20_000;

interface QueueNode<S> {
  state: S;
  actions: string[];
  states: S[];
}

function checkStateInvariants<S>(
  invariants: readonly ModelInvariant<S>[],
  state: Readonly<S>,
): { failedInvariant: string; detail: string } | null {
  for (const inv of invariants) {
    const verdict = inv.check(state);
    if (verdict !== true) {
      const detail =
        typeof verdict === "string" && verdict.trim().length > 0
          ? verdict
          : `违反不变式 "${inv.name}"`;
      return { failedInvariant: inv.name, detail };
    }
  }
  return null;
}

/** 对给定状态机执行确定性广度优先可达性分析，返回是否全部通过及最短反例。 */
export function exploreModel<S>(
  model: StateModel<S>,
  options: ModelCheckOptions = {},
): ModelCheckResult<S> {
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  const initState = model.initial();
  const visited = new Set<string>([model.canonicalize(initState)]);

  const initFailure = checkStateInvariants(model.invariants, initState);
  if (initFailure) {
    return {
      ok: false,
      exploredStates: 1,
      exploredTransitions: 0,
      counterexample: {
        kind: "invariant",
        failedInvariant: initFailure.failedInvariant,
        detail: initFailure.detail,
        actions: [],
        states: [initState],
      },
    };
  }

  const queue: QueueNode<S>[] = [
    { state: initState, actions: [], states: [initState] },
  ];
  let exploredTransitions = 0;

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (!current) continue;

    let enabledCount = 0;
    for (const transition of model.transitions) {
      if (!transition.guard(current.state)) continue;
      enabledCount++;
      exploredTransitions++;

      const nextState = transition.apply(current.state);
      const nextActions = [...current.actions, transition.name];
      const nextStates = [...current.states, nextState];

      const failure = checkStateInvariants(model.invariants, nextState);
      if (failure) {
        return {
          ok: false,
          exploredStates: visited.size + (visited.has(model.canonicalize(nextState)) ? 0 : 1),
          exploredTransitions,
          counterexample: {
            kind: "invariant",
            failedInvariant: failure.failedInvariant,
            detail: failure.detail,
            actions: nextActions,
            states: nextStates,
          },
        };
      }

      const key = model.canonicalize(nextState);
      if (visited.has(key)) continue;

      if (visited.size >= maxStates) {
        return {
          ok: false,
          exploredStates: visited.size,
          exploredTransitions,
          counterexample: {
            kind: "state_limit",
            detail: `可达状态数超过上限 ${maxStates}`,
            actions: nextActions,
            states: nextStates,
          },
        };
      }

      visited.add(key);
      queue.push({ state: nextState, actions: nextActions, states: nextStates });
    }

    const isTerminal = model.isTerminal?.(current.state) ?? false;
    if (
      enabledCount === 0 &&
      !isTerminal &&
      !model.allowStutterWhenNoEnabledTransition
    ) {
      return {
        ok: false,
        exploredStates: visited.size,
        exploredTransitions,
        counterexample: {
          kind: "deadlock",
          detail: "状态机在非终止状态下没有任何可执行迁移动作（死锁）",
          actions: current.actions,
          states: current.states,
        },
      };
    }
  }

  return {
    ok: true,
    exploredStates: visited.size,
    exploredTransitions,
  };
}

/** 断言模型检验通过；失败时抛出含最短反例动作序列的 Error。 */
export function assertModelHolds<S>(
  model: StateModel<S>,
  options?: ModelCheckOptions,
): ModelCheckResult<S> {
  const result = exploreModel(model, options);
  if (!result.ok) {
    const ce = result.counterexample;
    const pathText =
      ce && ce.actions.length > 0 ? ce.actions.join(" -> ") : "<initial>";
    const tag = ce?.failedInvariant ?? ce?.kind ?? "unknown";
    throw new Error(
      `模型检验失败 [${model.name}] (${tag}): ${ce?.detail ?? ""}；最短反例路径: ${pathText}`,
    );
  }
  return result;
}
