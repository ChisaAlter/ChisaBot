/**
 * Promise-without-action guard, ported from the Hermes adapter (examples/hermes-agent
 * chisabot_protocol.py `action_promise` / `_ACTION_NUDGE`). A reply that only says "I'll check
 * now" with tools on offer and no tool call in its turn gets one nudge to actually act.
 */
export const ACTION_NUDGE =
  "你刚才说要先查/先做——现在就调用工具执行，不要只回复文字说明。";

const PROMISE = new RegExp(
  [
    "我先(?:去|来|就|马上|现在|帮你)?(?:查|搜|看|找|试|确认|处理|接入|连接|问|弄|下载|打开)",
    "我来(?:查|搜|看|找|确认|处理|接入|连接|搜索|帮你)",
    "让我(?:先|来)?(?:查|搜|看|找|搜索|确认|试|问)",
    "我(?:这就|马上|现在|就|再|会|帮你)?(?:去|帮你)?(?:查|搜|搜索|看看|看|确认|找|处理|试|弄|问|下载|打开|接入|连接)",
    "\\b(?:i(?:'ll|’ll| will)|let me|i(?:'|’)?m (?:going\\s+to|gonna)|i am (?:going\\s+to|gonna))\\b[^.!?。！？\\n]{0,120}?\\b(?:search|look(?:ing)?\\s*(?:for|into|up|at)|check|find|fetch|dig|inspect|investigate|open|download|connect|try)\\b",
  ].join("|"),
  "i",
);
// Done / past tense anywhere in the reply: it reports work, it does not promise it.
const DONE =
  /了|好了|已经|已完成|完成|找到[了得]?|查到|办妥|搞定|处理好|下好|\b(?:i'?ve|i have|already|done|finished|completed|downloaded|found|checked|searched|handled|got it)\b/i;
// "查完了告诉你" / "完成后回复你" / "once it's done I'll…": a finish that is still ahead of us.
const LATER =
  /(?:完了?|好了?|完成|结束)(?:之?后|以后)?[^，,。.!?！？]{0,6}(?:告诉|回复|发给?|通知|给|跟)你|(?:完成|结束|查完|看完|弄完|做完)(?:之?后|以后)|\b(?:once|after|when)\b/i;
// A question asks permission ("要我先查一下吗？"); a negation declines ("我不会去查").
const QUESTION =
  /[?？]|吗|呢|\b(?:shall i|should i|do you want me|want me to|would you like me)\b/i;
const NEGATION =
  /不|没|别|无法|\b(?:won'?t|can'?t|cannot|will not|not going to|don'?t|do not|unable)\b/i;

/** True when the reply is a future-tense promise to act, not a report, question or refusal. */
export function actionPromise(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  // Clauses keep their closing mark so "我先查一下？" is read as the question it is.
  const clauses = text.match(/[^,，;；.!?。！？\n]+[,，;；.!?。！？]*/g) ?? [];
  // A reported finish vetoes what precedes it; a finish only promised for later does not. After
  // the last reported finish, a fresh promise counts only with its own report-back ("第一部分我
  // 查完了，第二部分我马上去查，查完告诉你"); "查好了。我再去看看别的。" stays a report.
  let rest = text;
  const lastDone = clauses.findLastIndex(
    (clause) => DONE.test(clause) && !LATER.test(clause),
  );
  if (lastDone >= 0) {
    rest = clauses.slice(lastDone + 1).join("");
    if (!LATER.test(rest)) return false;
  }
  // Questions and refusals are read per sentence: "我先查一下，可以吗？" asks before acting.
  const sentences = rest.match(/[^.!?。！？\n]+[.!?。！？]*/g) ?? [];
  return sentences.some(
    (sentence) =>
      PROMISE.test(sentence) &&
      !QUESTION.test(sentence) &&
      !NEGATION.test(sentence),
  );
}
