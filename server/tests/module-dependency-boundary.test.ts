import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".cts",
]);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
]);

type LayerName = "app" | "server" | "shared";

type BoundaryViolation = {
  file: string;
  specifier: string;
  targetLayer: LayerName;
};

function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.includes("/tests/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (IGNORED_DIRS.has(name) || name === "tests") continue;
    const full = resolve(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(full, out);
      continue;
    }
    const dot = name.lastIndexOf(".");
    if (
      dot !== -1 &&
      CODE_EXTENSIONS.has(name.slice(dot)) &&
      !isTestFile(full)
    ) {
      out.push(full);
    }
  }
  return out;
}

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
};

function extractModuleSpecifiers(filePath: string, source: string): string[] {
  const transpiler = filePath.endsWith(".tsx")
    ? transpilers.tsx
    : filePath.endsWith(".jsx")
      ? transpilers.jsx
      : filePath.endsWith(".js") ||
          filePath.endsWith(".mjs") ||
          filePath.endsWith(".cjs")
        ? transpilers.js
        : transpilers.ts;
  return transpiler.scanImports(source).map((entry) => entry.path);
}

function resolveTargetLayer(
  sourceFile: string,
  specifier: string,
): LayerName | null {
  if (specifier.startsWith(".")) {
    const resolved = resolve(dirname(sourceFile), specifier);
    const rel = relative(REPO_ROOT, resolved).replace(/\\/g, "/");
    if (rel === "app" || rel.startsWith("app/")) return "app";
    if (rel === "server" || rel.startsWith("server/")) return "server";
    if (rel === "shared" || rel.startsWith("shared/")) return "shared";
    return null;
  }
  const normalized = specifier.replace(/\\/g, "/").replace(/^@\//, "");
  if (normalized === "app" || normalized.startsWith("app/")) return "app";
  if (normalized === "server" || normalized.startsWith("server/")) {
    return "server";
  }
  if (normalized === "shared" || normalized.startsWith("shared/")) {
    return "shared";
  }
  return null;
}

function findCrossLayerViolations(
  sourceSubdir: string,
  forbiddenTargets: readonly LayerName[],
): BoundaryViolation[] {
  const rootDir = resolve(REPO_ROOT, sourceSubdir);
  const files = walkFiles(rootDir);
  const violations: BoundaryViolation[] = [];
  const forbidden = new Set(forbiddenTargets);

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const specifier of extractModuleSpecifiers(file, content)) {
      const targetLayer = resolveTargetLayer(file, specifier);
      if (targetLayer && forbidden.has(targetLayer)) {
        violations.push({
          file: relative(REPO_ROOT, file).replace(/\\/g, "/"),
          specifier,
          targetLayer,
        });
      }
    }
  }

  return violations;
}

describe("module dependency boundary (app -> shared <- server)", () => {
  test("app/ 不得 import server/", () => {
    const violations = findCrossLayerViolations("app/src", ["server"]);
    expect(violations).toEqual([]);
  });

  test("server/ 不得 import app/", () => {
    const violations = findCrossLayerViolations("server/src", ["app"]);
    expect(violations).toEqual([]);
  });

  test("shared/ 不得 import app/ 或 server/", () => {
    const violations = findCrossLayerViolations("shared", ["app", "server"]);
    expect(violations).toEqual([]);
  });
});
