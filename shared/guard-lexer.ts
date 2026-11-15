function canPrecedeRegex(
  prevSigChar: string,
  prevTwoChars: string,
  prevWord: string,
): boolean {
  if (!prevSigChar) return true;
  if (prevTwoChars === "=>") return true;
  if ("([{:;,=!?&|~+-*%^<".includes(prevSigChar)) return true;
  return /^(return|case|throw|typeof|void|delete|await|yield|else|do|in|of|instanceof)$/.test(
    prevWord,
  );
}

/**
 * 词法级剥离注释与字符串字面量，同时保留模板字符串 `${...}` 插值内部的代码。
 * TSX 中 `>` 多为 JSX 标签闭合并紧接文本（如 `<div>/api/v1</div>`），因此仅在 `=>` 后或赋值/分隔符后识别正则字面量。
 */
export function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  type Mode =
    | "code"
    | "lineComment"
    | "blockComment"
    | "single"
    | "double"
    | "template";
  let mode: Mode = "code";
  const templateBraceStack: number[] = [];
  let inRegexClass = false;
  let inRegex = false;
  let prevSigChar = "";
  let prevTwoChars = "";
  let currentWord = "";
  let prevWord = "";

  const pushSig = (ch: string) => {
    prevTwoChars = `${prevSigChar}${ch}`;
    prevSigChar = ch;
  };

  const flushWord = () => {
    if (currentWord) {
      prevWord = currentWord;
      currentWord = "";
    }
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (inRegex) {
      out.push(" ");
      if (ch === "\\") {
        if (i + 1 < source.length) {
          out.push(" ");
          i++;
        }
        continue;
      }
      if (ch === "[") inRegexClass = true;
      else if (ch === "]" && inRegexClass) inRegexClass = false;
      else if (ch === "/" && !inRegexClass) {
        inRegex = false;
        pushSig("/");
        prevWord = "";
      }
      continue;
    }

    if (mode === "lineComment") {
      if (ch === "\n") {
        mode = "code";
        out.push("\n");
      } else {
        out.push(" ");
      }
      continue;
    }

    if (mode === "blockComment") {
      if (ch === "*" && next === "/") {
        out.push("  ");
        i++;
        mode = "code";
      } else {
        out.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }

    if (mode === "single" || mode === "double") {
      const quote = mode === "single" ? "'" : '"';
      out.push(ch === "\n" ? "\n" : " ");
      if (ch === "\\") {
        if (i + 1 < source.length) {
          out.push(" ");
          i++;
        }
        continue;
      }
      if (ch === quote) {
        mode = "code";
        pushSig(quote);
        prevWord = "";
      }
      continue;
    }

    if (mode === "template") {
      if (ch === "\\") {
        out.push(" ");
        if (i + 1 < source.length) {
          out.push(" ");
          i++;
        }
        continue;
      }
      if (ch === "`") {
        out.push(" ");
        mode = "code";
        pushSig("`");
        prevWord = "";
        continue;
      }
      if (ch === "$" && next === "{") {
        out.push("${");
        i++;
        templateBraceStack.push(0);
        mode = "code";
        pushSig("{");
        prevWord = "";
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      continue;
    }

    if (ch === "/" && next === "/") {
      flushWord();
      out.push("  ");
      i++;
      mode = "lineComment";
      continue;
    }
    if (ch === "/" && next === "*") {
      flushWord();
      out.push("  ");
      i++;
      mode = "blockComment";
      continue;
    }
    if (ch === "'") {
      flushWord();
      out.push(" ");
      mode = "single";
      continue;
    }
    if (ch === '"') {
      flushWord();
      out.push(" ");
      mode = "double";
      continue;
    }
    if (ch === "`") {
      flushWord();
      out.push(" ");
      mode = "template";
      continue;
    }
    if (ch === "/") {
      flushWord();
      if (canPrecedeRegex(prevSigChar, prevTwoChars, prevWord)) {
        out.push(" ");
        inRegex = true;
        inRegexClass = false;
        continue;
      }
    }

    if (templateBraceStack.length > 0) {
      if (ch === "{") {
        const lastIdx = templateBraceStack.length - 1;
        templateBraceStack[lastIdx] = (templateBraceStack[lastIdx] ?? 0) + 1;
      } else if (ch === "}") {
        const top = templateBraceStack[templateBraceStack.length - 1] ?? 0;
        if (top === 0) {
          templateBraceStack.pop();
          flushWord();
          out.push("}");
          pushSig("}");
          prevWord = "";
          mode = "template";
          continue;
        }
        const lastIdx = templateBraceStack.length - 1;
        templateBraceStack[lastIdx] = top - 1;
      }
    }

    out.push(ch);
    if (/[A-Za-z0-9_$]/.test(ch)) {
      currentWord += ch;
      pushSig(ch);
    } else if (!/\s/.test(ch)) {
      flushWord();
      pushSig(ch);
      if (ch !== ")") prevWord = "";
    } else {
      flushWord();
    }
  }

  return out.join("");
}
