import "../../shared/env-compat";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isReusableBuild,
  writeBuildCacheManifest,
  type BuildCachePaths,
} from "./build-cache";

type RunCommand = (command: string[], cwd: string) => Promise<void>;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultAppDir = resolve(scriptDir, "..");
const defaultRootDir = resolve(defaultAppDir, "..");

function pathsFromEnvironment(): BuildCachePaths {
  return {
    rootDir: process.env.CHISABOT_BUILD_CACHE_ROOT_DIR
      ? resolve(process.env.CHISABOT_BUILD_CACHE_ROOT_DIR)
      : defaultRootDir,
    appDir: process.env.CHISABOT_BUILD_CACHE_APP_DIR
      ? resolve(process.env.CHISABOT_BUILD_CACHE_APP_DIR)
      : defaultAppDir,
  };
}

async function run(command: string[], cwd: string) {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${exitCode}`);
  }
}

export async function prepareProductionBuild(
  paths: BuildCachePaths,
  runCommand: RunCommand = run,
): Promise<"reused" | "rebuilt"> {
  await runCommand(
    [process.execPath, "run", "--cwd", paths.rootDir, "generate:app-config"],
    paths.rootDir,
  );

  if (await isReusableBuild(paths, process.env)) {
    console.log("Reusing app/dist from build cache");
    return "reused";
  }

  console.log("Building app/dist because the build cache is stale or missing");
  const localVite = join("node_modules", "vite", "bin", "vite.js");
  const viteBin = existsSync(join(paths.appDir, localVite))
    ? localVite
    : join("..", localVite);
  await runCommand(
    [
      process.execPath,
      "--bun",
      viteBin,
      "build",
    ],
    paths.appDir,
  );
  await writeBuildCacheManifest(paths, process.env);
  return "rebuilt";
}

if (import.meta.main) {
  await prepareProductionBuild(pathsFromEnvironment());
}
