import { describe, expect, test } from "bun:test";
import { classifyOpenTarget } from "../../pc/src/agent/open-target.js";
import { checkOpenTarget } from "../../shared/devices";

/** CB-030：「打开」只做安全的打开——网址或文件 / 文件夹路径，不启动程序、不带参数。服务器和 PC 同一套规则。 */
const ok = [
  "https://example.com/a?b=1",
  "http://127.0.0.1:3000/",
  "D:\\报告\\周报.pdf",
  "C:/Users/a/Desktop/",
  "D:\\报告\\",
  "/home/a/notes.md",
  "~/Downloads/",
  "sub/a.txt",
  "周报.docx",
  ".",
];
const refused = [
  "",
  "notepad",
  "calc",
  "C:\\Windows\\System32\\calc",
  "~/Downloads",
  "cmd /c calc",
  "calc.exe",
  "C:\\Windows\\System32\\cmd.exe",
  "D:\\x\\run.BAT",
  "a.ps1",
  "evil.lnk",
  "x.vbs",
  "x.js",
  "Setup.msi",
  "/tmp/x.sh",
  "/Applications/Calculator.app",
  "~/.local/share/applications/x.desktop",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "ms-settings:privacy",
  "mailto:a@b.c",
  "\\\\evil\\share\\a.pdf",
  "//evil/share/a.pdf",
  "-e",
  "a.txt:evil.exe",
  "evil.exe. ",
  "a.txt\nb",
];

describe("checkOpenTarget (server) / classifyOpenTarget (PC)", () => {
  for (const target of ok)
    test(`allows ${JSON.stringify(target)}`, () => {
      expect(checkOpenTarget(target)).toBeNull();
      expect(classifyOpenTarget(target).error).toBeUndefined();
    });
  for (const target of refused)
    test(`refuses ${JSON.stringify(target)}`, () => {
      expect(checkOpenTarget(target)).toBeString();
      expect(classifyOpenTarget(target).error).toBeString();
    });
});
