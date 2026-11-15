const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "app/src");
const dictionaryPath = path.join(root, "app/src/locales/zh-CN.json");
const uiFields = new Set([
  "title",
  "label",
  "description",
  "placeholder",
  "summary",
  "message",
  "emptyTitle",
  "emptyDescription",
  "confirmLabel",
  "cancelLabel",
  "text",
  "aria-label",
  "aria-description",
  "alt",
  "tooltip",
  "caption",
  "hint",
  "heading",
  "detail",
  "notice",
  "help",
  "buttonLabel",
  "fallback",
  "successMessage",
  "errorMessage",
  "statusLabel",
]);
const skipTags = new Set(["code", "pre", "script", "style"]);

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "generated" || entry.name === "locales"
        ? []
        : files(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [full]
      : [];
  });
}

function visible(node) {
  if (ts.isJsxText(node)) {
    const tag = node.parent?.openingElement?.tagName?.getText();
    return !skipTags.has(tag);
  }
  if (
    !ts.isStringLiteral(node) &&
    !ts.isNoSubstitutionTemplateLiteral(node) &&
    !ts.isTemplateExpression(node)
  )
    return false;
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) return uiFields.has(parent.name.getText());
  if (ts.isPropertyAssignment(parent))
    return (
      uiFields.has(parent.name.getText().replace(/['"]/g, "")) ||
      (ts.isObjectLiteralExpression(parent.parent) &&
        ts.isVariableDeclaration(parent.parent.parent) &&
        /(?:LABELS|NAMES|TITLES|CAPTIONS|COPY)$/.test(
          parent.parent.parent.name.getText(),
        ))
    );
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText();
    return (
      /^(setError|setNotice|setMessage|alert)$/.test(callee) ||
      /^toast\./.test(callee)
    );
  }
  if (ts.isNewExpression(parent) && parent.expression.getText() === "Error")
    return true;
  if (
    ts.isNewExpression(parent) &&
    parent.expression.getText() === "Notification"
  )
    return true;
  const uiFile = /[\\/]app[\\/]src[\\/](?:components|routes)[\\/]/.test(
    node.getSourceFile().fileName,
  );
  const prose = /\s/.test(textOf(node, node.getSourceFile()));
  if (uiFile && prose && ts.isReturnStatement(parent)) return true;
  if (
    uiFile &&
    prose &&
    ts.isCallExpression(parent) &&
    /\.push$/.test(parent.expression.getText())
  )
    return true;
  // Conditional display strings are safe; comparison operands, keys and routes are not.
  let ancestor = parent;
  while (
    ancestor &&
    (ts.isConditionalExpression(ancestor) ||
      ts.isParenthesizedExpression(ancestor) ||
      (ts.isBinaryExpression(ancestor) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
        ].includes(ancestor.operatorToken.kind)))
  )
    ancestor = ancestor.parent;
  if (ts.isTemplateSpan(ancestor)) {
    const template = ancestor.parent;
    if (visible(template)) return true;
  }
  if (ts.isNewExpression(ancestor) && ancestor.expression.getText() === "Error")
    return true;
  if (
    ts.isCallExpression(ancestor) &&
    /^(setError|setNotice|setMessage|alert)$/.test(
      ancestor.expression.getText(),
    )
  )
    return true;
  if (ts.isVariableDeclaration(ancestor))
    return /(?:Label|Title|Description|Placeholder|Text|Error|Notice)$|^(?:error|notice|message)$/.test(
      ancestor.name.getText(),
    );
  if (ts.isPropertyAssignment(ancestor))
    return uiFields.has(ancestor.name.getText().replace(/['"]/g, ""));
  if (ts.isJsxExpression(ancestor)) {
    return (
      !ts.isJsxAttribute(ancestor.parent) ||
      uiFields.has(ancestor.parent.name.getText())
    );
  }
  return false;
}

function normal(text) {
  return text.replace(/\s+/g, " ").trim();
}

function textOf(node, tree) {
  if (ts.isJsxText(node)) return node.getFullText(tree);
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map((span, index) => `__VAR_${index}__${span.literal.text}`)
        .join("")
    );
  }
  return node.text;
}

const records = new Map();
const fileRecords = [];
for (const filename of files(sourceRoot)) {
  const source = fs.readFileSync(filename, "utf8");
  const tree = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const nodes = [];
  function visit(node) {
    if (visible(node)) {
      const text = normal(textOf(node, tree));
      if (
        /[a-zA-Z]/.test(text) &&
        !/[\u3400-\u9fff]/.test(text) &&
        !/^(https?:|\/|@|[a-z]+[-_:]|[A-Z_]{4,}$)/.test(text)
      ) {
        nodes.push({ node, text });
        if (!records.has(text)) records.set(text, []);
        records
          .get(text)
          .push(path.relative(root, filename).replaceAll("\\", "/"));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  fileRecords.push({ filename, source, tree, nodes });
}

if (process.argv.includes("--extract")) {
  const output = Object.fromEntries(
    [...records].sort(([a], [b]) => a.localeCompare(b)),
  );
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "work/zh-candidates.json"),
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log(`${records.size} visible strings extracted.`);
} else {
  const dictionary = JSON.parse(fs.readFileSync(dictionaryPath, "utf8"));
  let changed = 0;
  let count = 0;
  for (const { filename, source, tree, nodes } of fileRecords) {
    const edits = nodes.flatMap(({ node, text }) => {
      if (!dictionary[text]) return [];
      const translated = dictionary[text];
      let replacement = ts.isJsxText(node)
        ? `{${JSON.stringify(translated)}}`
        : JSON.stringify(translated);
      if (ts.isJsxAttribute(node.parent))
        replacement = `{${JSON.stringify(translated)}}`;
      if (ts.isTemplateExpression(node)) {
        const markers = node.templateSpans.map(
          (_, index) => `__VAR_${index}__`,
        );
        if (markers.some((marker) => translated.split(marker).length !== 2)) {
          throw new Error(`Missing or duplicated interpolation in: ${text}`);
        }
        // Preserve each expression verbatim while allowing Chinese to reorder the surrounding text.
        replacement =
          "`" +
          translated
            .replaceAll("\\", "\\\\")
            .replaceAll("`", "\\`")
            .replaceAll("${", "\\${") +
          "`";
        node.templateSpans.forEach((span, index) => {
          replacement = replacement.replace(
            `__VAR_${index}__`,
            `\${${span.expression.getText(tree)}}`,
          );
        });
      }
      return [{ start: node.getStart(tree), end: node.end, replacement }];
    });
    if (!edits.length) continue;
    let result = source;
    const outerEdits = edits.filter(
      (edit) =>
        !edits.some(
          (other) =>
            other !== edit &&
            other.start <= edit.start &&
            other.end >= edit.end,
        ),
    );
    for (const edit of outerEdits.sort((a, b) => b.start - a.start)) {
      result =
        result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    }
    fs.writeFileSync(filename, result);
    changed++;
    count += outerEdits.length;
  }
  const missing = [...records.keys()].filter((text) => !dictionary[text]);
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "work/zh-untranslated.json"),
    `${JSON.stringify(missing, null, 2)}\n`,
  );
  console.log(
    `${count} strings localized in ${changed} files; ${missing.length} remaining candidates.`,
  );
}
