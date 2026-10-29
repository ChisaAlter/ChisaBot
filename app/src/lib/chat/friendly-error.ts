/**
 * Turn whatever ended a turn into a short, friendly Chinese headline plus a hint, keeping the raw
 * words available as details. The raw sentence is still the truth; this only decides how loudly
 * and in which words to say it first.
 */
export type FriendlyError = {
  title: string;
  hint?: string;
  detail: string;
  retryable: boolean;
};

/**
 * 「这一轮发出去了，但没有留下任何回答」的标记（2026-10-20，P1）。
 *
 * 这不是一条 RUN_ERROR：刷新之后错误事件早就不在了，只剩人那条消息孤零零挂着。既然从历史里能认得出来
 * （最后一轮是人发的消息、后面什么都没有），就用这个稳定的字符串当原因，让错误卡和「重试」在刷新后
 * 照样重建出来，而不是消失。
 */
export const UNANSWERED_TURN_REASON = "unanswered-turn: no reply was stored for this turn";

const RULES: Array<{ test: RegExp; title: string; hint?: string; retryable?: boolean }> = [
  {
    // CB-100：服务器在流开始前就连不上智能体运行时（Hermes 桥接 / 远程 AG-UI），发来的 RUN_ERROR。
    // 放在最前面：原因里带的 ConnectionRefused / ECONN 不能被当成「网络连接中断」（那是浏览器这边的网络）。
    test: /智能体运行时无法连接|智能体运行时在开始回答前出错|AGENT_RUNTIME_UNREACHABLE/,
    title: "智能体运行时无法连接",
    hint: "服务器连不上智能体运行时（例如 Hermes 桥接没在监听）。请管理员检查运行时服务后点「重试」。",
  },
  {
    test: /实名|real[-_ ]?name|identity verification|realname|未认证|身份认证/i,
    title: "模型服务商要求先完成实名认证",
    hint: "请到该模型服务商的控制台完成实名认证，或在下方切换到其他模型后重试。",
    retryable: false,
  },
  {
    // #416 返修：403 不一定是密钥问题，服务商也用 403 表示「不向这个国家 / 地区提供服务」。Hermes 适配器看错误 body 认出来后发这句。
    test: /unsupported[_ ]?(region|country)|region not supported|不支持.*地区|地区限制/i,
    title: "模型服务商不支持服务器所在地区",
    hint: "该服务商不向服务器所在的国家或地区提供这个模型。请在下方切换到其他模型，或请管理员换用可用的服务商或线路。",
    retryable: false,
  },
  {
    test: /\b401\b|unauthori[sz]ed|invalid[_ ]?api[_ ]?key|incorrect api key|authentication|api key|密钥无效|鉴权/i,
    title: "模型密钥无效或已过期",
    hint: "请检查管理后台中的模型凭据，或切换到其他模型。",
    retryable: false,
  },
  {
    test: /\b402\b|insufficient|balance|quota|余额|额度|欠费|billing|credit/i,
    title: "模型额度不足",
    hint: "账户余额或额度已用完。充值后重试，或切换到其他模型。",
    retryable: false,
  },
  {
    test: /\b429\b|rate[_ ]?limit|too many requests|频率|限流/i,
    title: "请求太频繁，被模型服务商限流",
    hint: "稍等片刻再重试。",
  },
  {
    test: /content[_ ]?filter|safety|moderation|sensitive|违规|敏感|审核/i,
    title: "请求被模型的内容安全策略拦截",
    hint: "换个说法再试，或切换到其他模型。",
  },
  {
    test: /context[_ ]?length|too long|maximum context|token limit|超出.*长度|上下文/i,
    title: "对话太长，超出了模型的上下文上限",
    hint: "换用上下文更长的模型后重试。",
  },
  {
    test: /timeout|timed out|超时|stopped responding|停止响应|停止了输出|no longer streaming/i,
    title: "模型响应超时",
    hint: "可能是网络或服务商繁忙，稍后重试。",
  },
  {
    test: /\b5\d\d\b|bad gateway|service unavailable|overloaded|internal server error|服务不可用|过载/i,
    title: "模型服务暂时不可用",
    hint: "服务商出现故障或过载，稍后重试或切换模型。",
  },
  {
    // 模型服务商回答到一半断开（ClinePass「connection lost mid-reply … GOAWAY」，AI SDK 只剩一句「AI SDK stream error」）。成熟度扫查 F7。
    test: /AI SDK stream error|stream error|connection lost|GOAWAY|server_shutting_down|terminated|premature close|aborted mid/i,
    title: "模型的连接中途断开了",
    hint: "这一轮的回答没写完。点「重试」再来一次；经常这样就换一个模型。",
  },
  {
    test: /连不上 ChisaBot 服务器|这句可能没发出去|和 ChisaBot 服务器的连接断了/i,
    title: "连不上服务器",
    hint: "消息可能还没发出去。检查网络后重新发送。",
  },
  {
    test: /failed to fetch|network|ECONN|ENOTFOUND|socket|fetch failed|网络|ERR_TUNNEL|tunnel_connection/i,
    title: "网络连接中断",
    hint: "请检查网络后重试。",
  },
  {
    test: /not found|model.*(does not exist|unavailable)|模型不存在|404/i,
    title: "找不到所选模型",
    hint: "该模型可能已下线，请在下方切换模型。",
    retryable: false,
  },
  {
    /*
     * 选中的模型被服务商下线（2026-10-20 线上：space-bunny-free 返回 410
     * 「OpenCode Zen: Model space-bunny-free has been deprecated. Use minimax-m3.1-flash-free instead.」）。
     * 以前这条落到兜底，用户只看到「机器人在回答前停止了」，以为应用坏了——真实原因是模型没了。
     */
    test: /deprecat|retired|已下线|不再提供|no longer (available|supported)/i,
    title: "这个模型已经下线了",
    hint: "服务商不再提供这个模型。点输入框右下角的模型名换一个再发。",
    retryable: false,
  },
];

export function friendlyError(raw: string): FriendlyError {
  const detail = raw.trim();
  /*
   * 历史里唯一能看出来的「这一轮没人回答」：最后一条是人发的消息，后面什么都没有（2026-10-20，P1）。
   * 刷新以后 RUN_ERROR 早没了，卡片得靠这个标记重建出来，并给一条能走的下一步。
   */
  if (/^unanswered-turn\b/i.test(detail))
    return {
      title: "这一轮没有收到回答",
      hint: "可能是模型不可用、网络中断，或服务器刚好在重启。点「重试」重发这一条；一直这样就换一个模型。",
      detail: "",
      retryable: true,
    };
  // 做到一半就停了（工具出错 / 续轮到上限 / 空回复，DESIGN.md §100）：原因本身已经是给人看的中文，
  // 放在提示里直接显示；放在规则前面，免得里面带的英文原文（如 timeout）被认成「模型超时」。
  if (/^机器人(在「[^」]*」这一步出错|做完「[^」]*」之后没有接着做|这一轮没有给出任何回复)/.test(detail)) {
    return { title: "这一轮没有做完", hint: detail, detail: "", retryable: true };
  }
  for (const rule of RULES) {
    if (rule.test.test(detail)) {
      return {
        title: rule.title,
        ...(rule.hint ? { hint: rule.hint } : {}),
        detail,
        retryable: rule.retryable ?? true,
      };
    }
  }
  // Already a short Chinese sentence from this app: show it as the headline itself.
  if (/[\u4e00-\u9fff]/.test(detail) && detail.length <= 60) {
    return { title: detail, detail: "", retryable: true };
  }
  // 一句话都没有收到（模型不可用、这一轮被打断）：别只说「回答前停止了」，给一条能走的下一步。
  return {
    title: "这一轮没有收到回答",
    hint: "可能是模型不可用（例如已下线）或这一轮被打断了。换一个模型再试，或点「重试」。",
    detail,
    retryable: true,
  };
}
