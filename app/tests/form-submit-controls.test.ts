import { expect, test } from "bun:test";
import { Glob } from "bun";
import ts from "typescript";

/**
 * Every `<form onSubmit>` has something that submits it.
 *
 * Base UI's `Button` renders `type="button"` unless told otherwise, so a `<Button>` that looks like
 * a form's submit does nothing when pressed, and the form's own tests still pass because they fire
 * `submit` on the form directly. That shipped four dead forms at once (Remember, Add and sync
 * source, Confirm phone, Turn on background research) and the recorder before them. A plain
 * `<button>` defaults to submit, so it counts; a `<Button>` counts only with `type="submit"`.
 *
 * A form submitted some other way (the composer's Enter key and send action) names itself here with
 * a reason, rather than every form losing the check.
 */
const SUBMITTED_ELSEWHERE = new Set([
  // Enter submits through the editor, and the send action is its own typed control.
  "src/components/channels/composer/composer.tsx",
  // 地址栏只有一个网址输入框：回车走 HTML 的隐式提交（正好一个字段的那种），工具条上的按钮是
  // 前进 / 后退 / 刷新这样的导航动作（type="button"），不是提交。
  "src/components/computer/live-screen.tsx",
  // Alt+Space 随手问浮窗：只有一个输入框，回车走 HTML 的隐式提交；唯一的按钮是关闭（type="button"）。
  "src/components/chat/quick-spotlight.tsx",
]);

/** `Bun.Glob` 在 Windows 上给的是 `src\components\…`；上面那张表写的是 `/`。 */
const normalize = (path: string) => path.replace(/\\/g, "/");

function attribute(node: ts.JsxOpeningLikeElement, name: string) {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

/** A `form` / `id` attribute whose value is a string literal, which is the only kind read here. */
function stringAttribute(node: ts.JsxOpeningLikeElement, name: string) {
  const initializer = attribute(node, name)?.initializer;
  return initializer && ts.isStringLiteral(initializer)
    ? initializer.text
    : undefined;
}

function submits(node: ts.JsxOpeningLikeElement): boolean {
  const tag = node.tagName.getText();
  const type = attribute(node, "type")?.initializer;
  if (type && ts.isJsxExpression(type) && type.expression) {
    /*
     * `type={stopping ? "button" : "submit"}` 是一个在某个状态里确实提交表单的控件（Claude Code 的发送键：
     * 正在回答时是停止，别的时侯是提交）。表达式里出现 `"submit"` 就算它能提交；认不出来的表达式照旧当
     * 不能提交 —— 宁可多报一个，也不放过一个真死掉的按钮。
     */
    if (/["'`]submit["'`]/.test(type.expression.getText())) return true;
  }
  const typeText =
    type && ts.isStringLiteral(type)
      ? type.text
      : type && ts.isJsxExpression(type) && type.expression
        ? type.expression.getText().replace(/["'`]/g, "")
        : undefined;
  if (tag === "button") return typeText === undefined || typeText === "submit";
  if (tag === "input") return typeText === "submit";
  return typeText === "submit";
}

test("every form with an onSubmit has a control that submits it", async () => {
  const dead: string[] = [];
  for await (const scanned of new Glob("src/**/*.tsx").scan(
    `${import.meta.dir}/..`,
  )) {
    const file = normalize(scanned);
    if (SUBMITTED_ELSEWHERE.has(file)) continue;
    const text = await Bun.file(`${import.meta.dir}/../${scanned}`).text();
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    /*
     * 提交控件不一定要长在 `<form>` 里面：`<Button form="wf-run-form" type="submit">` 用 `form` 属性把
     * 自己交给那张表单（工作流运行对话框：按钮在弹窗页脚，表单在正文里）。先把这类跨元素的归属收起来。
     */
    const outsideSubmit = new Set<string>();
    const collectOutside = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const owner = stringAttribute(node, "form");
        if (owner && submits(node)) outsideSubmit.add(owner);
      }
      ts.forEachChild(node, collectOutside);
    };
    collectOutside(source);
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText() === "form" &&
        attribute(node.openingElement, "onSubmit")
      ) {
        let found = false;
        const inside = (child: ts.Node) => {
          if (found) return;
          if (
            (ts.isJsxOpeningElement(child) ||
              ts.isJsxSelfClosingElement(child)) &&
            submits(child)
          )
            found = true;
          ts.forEachChild(child, inside);
        };
        ts.forEachChild(node, inside);
        if (!found) {
          const id = stringAttribute(node.openingElement, "id");
          if (id !== undefined && outsideSubmit.has(id)) found = true;
        }
        if (!found) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          dead.push(`${file}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(dead).toEqual([]);
});
