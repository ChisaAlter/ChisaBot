import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveBrowserExecutable } from "../../scripts/verify-ui.mjs";

interface VerifyUiReport {
  ok: boolean;
  reason?: string;
  mode?: string;
  browserExecutable?: string;
  desktopScreenshotBytes?: number;
  mobileScreenshotBytes?: number;
  selfTestRenderedText?: string;
  consoleErrors?: string[];
  pageErrors?: string[];
  server5xx?: string[];
  tempDir?: string;
  tempDirCleaned?: boolean;
  desktopOverflow?: boolean;
  mobileOverflow?: boolean;
}

const repoRoot = path.resolve(import.meta.dir, "../..");

test(
  "实机浏览器 UI 自验收驱动可走通端到端交互、截图采集与零临时目录残留",
  async () => {
    const installedBrowser = resolveBrowserExecutable();
    const proc = Bun.spawn(["node", "scripts/verify-ui.mjs", "--self-test"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    let report: VerifyUiReport | null = null;
    try {
      report = JSON.parse(stdout) as VerifyUiReport;
    } catch {
      throw new Error(
        `verify-ui 输出非合法 JSON (exit=${exitCode}): stdout=${stdout} stderr=${stderr}`,
      );
    }

    if (!installedBrowser) {
      expect(exitCode).toBe(2);
      expect(report.ok).toBe(false);
      expect(report.reason).toBe("browser_not_found");
      return;
    }

    expect(stderr.trim()).toBe("");
    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe("self-test");
    expect(report.browserExecutable).toBe(installedBrowser);
    expect(report.selfTestRenderedText).toContain("自验收实机回路正常");
    expect(report.desktopOverflow).toBe(false);
    expect(report.mobileOverflow).toBe(false);
    expect(report.desktopScreenshotBytes).toBeGreaterThan(1000);
    expect(report.mobileScreenshotBytes).toBeGreaterThan(1000);
    expect(report.consoleErrors).toEqual([]);
    expect(report.pageErrors).toEqual([]);
    expect(report.server5xx).toEqual([]);
    expect(report.tempDirCleaned).toBe(true);
    if (report.tempDir) {
      expect(existsSync(report.tempDir)).toBe(false);
    }
  },
  30_000,
);
