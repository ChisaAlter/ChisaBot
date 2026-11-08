// A real process exit after an external effect but before its operation receipt commits.
import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { createDatabase } from "../../src/db/client";
import { createToolOperationStore } from "../../src/conversations/tool-operations";
import { createDshToolGateway } from "../../src/conversations/tool-gateway";

const config = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const database = createDatabase(process.env.CHISABOT_DSH_TEST_DATABASE_URL!, { max: 2 });
const operations = createToolOperationStore(database);
await operations.ensure();
const gateway = createDshToolGateway(operations);
const registration = gateway.register({ ...config.registration, signal: new AbortController().signal,
  continuationMessages: async () => config.messages,
  tools: [{ name: "write_once", ref: "fixture/write", description: "Write the isolated effect marker.", parameters: z.object({ value: z.string() }),
    execute: async () => { await appendFile(config.effectFile, "effect\n"); process.exit(78); },
  }],
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: gateway.routes.fetch });
console.log(JSON.stringify({ ready: true, origin: server.url.origin, capability: registration.capability }));
