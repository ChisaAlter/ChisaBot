import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildExtension } from "../scripts/build.mjs";

function parseZipFileNames(zipBuf: Buffer): string[] {
  // 校验标准 ZIP 头部魔数 PK\x03\x04
  expect(zipBuf.readUInt32LE(0)).toBe(0x04034b50);

  // 定位 End of Central Directory (PK\x05\x06)
  let eocdOffset = -1;
  for (
    let i = zipBuf.length - 22;
    i >= Math.max(0, zipBuf.length - 65557);
    i -= 1
  ) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  expect(eocdOffset).toBeGreaterThan(0);

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];
  let cursor = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    expect(zipBuf.readUInt32LE(cursor)).toBe(0x02014b50);
    const nameLen = zipBuf.readUInt16LE(cursor + 28);
    const extraLen = zipBuf.readUInt16LE(cursor + 30);
    const commentLen = zipBuf.readUInt16LE(cursor + 32);
    const name = zipBuf
      .subarray(cursor + 46, cursor + 46 + nameLen)
      .toString("utf8");
    names.push(name);
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return names;
}

describe("Chrome / Edge MV3 扩展构建与打包产物完整性校验", () => {
  test("buildExtension 产出合法 MV3 manifest.json、完整 unpacked 目录与有效 ZIP", async () => {
    const result = await buildExtension();

    expect(existsSync(result.distDir)).toBe(true);
    expect(existsSync(result.zipPath)).toBe(true);
    expect(result.zipBytes).toBeGreaterThan(1024);

    const manifestPath = path.join(result.distDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      manifest_version: number;
      name: string;
      permissions: string[];
      host_permissions: string[];
      background: { service_worker: string; type?: string };
      side_panel: { default_path: string };
      content_security_policy?: { extension_pages?: string };
      icons: Record<string, string>;
    };

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("ChisaBot 浏览器伴侣");
    for (const perm of [
      "sidePanel",
      "tabs",
      "tabGroups",
      "debugger",
      "scripting",
      "storage",
      "activeTab",
    ]) {
      expect(manifest.permissions).toContain(perm);
    }
    expect(manifest.host_permissions).toEqual(["http://*/*", "https://*/*"]);
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.side_panel.default_path).toBe("sidepanel/index.html");
    expect(manifest.content_security_policy?.extension_pages).toContain(
      "script-src 'self'",
    );

    // 校验无远程脚本
    const requiredFiles = [
      "background.js",
      "content/hud.js",
      "sidepanel/index.html",
      "sidepanel/main.js",
      "sidepanel/styles.css",
      "icons/icon-16.png",
      "icons/icon-32.png",
      "icons/icon-48.png",
      "icons/icon-128.png",
    ];
    for (const rel of requiredFiles) {
      const full = path.join(result.distDir, rel);
      expect(existsSync(full)).toBe(true);
      expect(statSync(full).size).toBeGreaterThan(0);
    }

    // 校验 Side Panel CSS（剥离注释后）不含被禁用的 :has() 与 group-has-*
    const css = readFileSync(
      path.join(result.distDir, "sidepanel/styles.css"),
      "utf8",
    );
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(cssWithoutComments).not.toMatch(/group-has-|peer-has-|:has\(/);

    // 校验 ZIP 目录结构与完整性
    const zipBuf = readFileSync(result.zipPath);
    const zipNames = parseZipFileNames(zipBuf);
    expect(zipNames).toContain("manifest.json");
    for (const rel of requiredFiles) {
      expect(zipNames).toContain(rel);
    }
    expect(zipNames).not.toContain("chisabot-chrome-extension.zip");
  });
});
