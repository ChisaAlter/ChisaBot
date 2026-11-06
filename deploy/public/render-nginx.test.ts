import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
const gitShell = join(
  process.env.ProgramFiles || "C:/Program Files",
  "Git/bin/sh.exe",
);
const shell =
  process.platform === "win32" && existsSync(gitShell) ? gitShell : "sh";

afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

for (const port of ["8443", "443", "9443"]) {
  test(`gateway render keeps public page and OneBot exceptions on port ${port}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "chisabot-nginx-"));
    directories.push(directory);
    for (const name of ["nginx.conf", "render-nginx.sh"]) {
      copyFileSync(join(import.meta.dir, name), join(directory, name));
    }
    const result = spawnSync(shell, ["render-nginx.sh"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        ENV_FILE: join(directory, "no-env-file"),
        CHISABOT_DOMAIN: "chat.example.test",
        CHISABOT_HTTPS_PORT: port,
        CHISABOT_MAGPIE_PORT: "2053",
        CHISABOT_CERT_NAME: "chat.example.test",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const configuration = readFileSync(
      join(directory, "nginx.generated.conf"),
      "utf8",
    );
    const origin = `https://chat.example.test${port === "443" ? "" : `:${port}`}`;
    expect(configuration).toContain(`listen ${port} ssl;`);
    expect(configuration).toContain(`"${origin}" 1;`);
    expect(configuration).toContain(
      `~^cross-site:(GET|HEAD):[a-z-]*:${port}/p/ 1;`,
    );
    expect(configuration).toContain(`~*^websocket::${port}/api/im/onebot/ 1;`);
    expect(configuration).toContain("~^cross-site: 0;");
    expect(configuration).toContain("~*^websocket:: 0;");
    if (port !== "8443") expect(configuration).not.toContain(":8443/");
  });
}
