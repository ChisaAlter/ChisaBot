import assert from "node:assert/strict";
import { test } from "node:test";
import { actionPromise } from "../src/action-promise.mjs";

// QA #508 regression set (qa_r2 22 cases + extras), kept verbatim.
const QA_CASES = [
  ["我下载好了", false],
  ["我马上处理", true],
  ["我先去查一下 ima 的接入方式，稍后告诉你。", true],
  ["我找到了三个结果", false],
  ["我确认过了，没问题", false],
  ["I'll search for that now.", true],
  ["Let me check the docs.", true],
  ["I've already checked it.", false],
  ["I found three results.", false],
  ["我不会去查这个", false],
  ["我没法打开这个链接", false],
  ["要我帮你查一下吗？", false],
  ["Should I look into it?", false],
  ["我马上去查，查完了告诉你", true],
  ["我先看看，完成后回复你", true],
  ["我去查查。我去查查。我去查查。", true],
  ["ima 是腾讯的知识库产品，你可以在设置里绑定。", false],
  ["我看看不出问题在哪", false],
  ["I will not open that file.", false],
  ["I'm going to connect ima for you.", true],
  ["让我想想", false],
  ["我来帮你接入 ima", true],
  ["好的，我这就去搜索 ima 的接入文档。", true],
  ["我先查一下，稍等。", true],
  ["收到，我马上去下载。", true],
  ["我去看看，等会儿把结果发你", true],
  ["I'm gonna look into it.", true],
  ["I am going to search the web for ima.", true],
  ["我会帮你查一下的", true],
  ["我先去查一下，然后把方案发给你。", true],
  ["请稍等，我来处理一下。", true],
  ["下载好了，文件在附件里。", false],
  ["要不要我去查？", false],
  ["我现在不去查了", false],
  ["I won't search for that.", false],
  ["Do you want me to check?", false],
];

test("QA #508 promise / report / question / refusal cases", () => {
  for (const [text, expected] of QA_CASES)
    assert.equal(actionPromise(text), expected, text);
});

test("a finish promised for later is not a report; a permission question is not a promise", () => {
  assert.equal(actionPromise("我先查一下，可以吗？"), false);
  assert.equal(
    actionPromise("I'll check it and tell you once it's done."),
    true,
  );
  assert.equal(actionPromise("查好了。我再去看看别的。"), false);
  // QA509 P3: a finished part, then a fresh promise with its own report-back.
  assert.equal(
    actionPromise("第一部分我查完了，第二部分我马上去查，查完告诉你"),
    true,
  );
  assert.equal(actionPromise("第一部分我查完了，第二部分没有问题"), false);
  // QA510 P3: a promise that waits on the user is an offer, not a skipped step.
  for (const offer of [
    "已完成。下次需要我再去查，查完告诉你。",
    "下次需要我再去查",
    "如果你需要，我可以再去查一下。",
    "有需要的话我再去看看。",
    "你想的话我去搜一下。",
    "随时叫我，我去查。",
    "If you want, I'll check the other repo too.",
    "Next time I'll look into it first.",
  ])
    assert.equal(actionPromise(offer), false, offer);
  // …while plain promises, including ones mentioning a result or a need, still nudge.
  for (const promise of [
    "我先去查一下，需要一点时间。",
    "我先去查，如果有结果告诉你",
    "我马上去查，查完了告诉你",
    "I'll check it and tell you once it's done.",
  ])
    assert.equal(actionPromise(promise), true, promise);
  assert.equal(
    actionPromise("第一部分查完了，第二部分要我查完告诉你吗？"),
    false,
  );
  assert.equal(actionPromise(""), false);
  assert.equal(actionPromise(undefined), false);
});
