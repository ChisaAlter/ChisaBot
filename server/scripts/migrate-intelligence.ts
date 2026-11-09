import { writeFile } from "node:fs/promises";
import { IntelligenceHistoryClient } from "../src/conversations/intelligence-history";
import {
  importIntelligenceInventory,
  inventoryIntelligence,
  legacyInventorySchema,
} from "../src/conversations/legacy-import";
import { createDatabase } from "../src/db/client";

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const required = (value: string | undefined, name: string) => {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value;
};
if (args.includes("--help") || !args[0]) {
  console.log(
    "Inventory: bun server/scripts/migrate-intelligence.ts inventory --user <owner-id> --agent <bot-id> --out <snapshot.json> [--limit 1000]\nImport: bun server/scripts/migrate-intelligence.ts import --snapshot <snapshot.json>\nUse INTELLIGENCE_API_URL/INTELLIGENCE_API_KEY for read-only inventory; DATABASE_URL and CHISABOT_DSH_ROOT/.maintenance for import. Stop old execution before inventory. Snapshots contain private conversation history.",
  );
} else if (args[0] === "inventory") {
  const limit = Number(option("--limit") ?? 1000);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("--limit must be a positive integer.");
  const client = new IntelligenceHistoryClient({
    apiUrl: required(process.env.INTELLIGENCE_API_URL, "INTELLIGENCE_API_URL"),
    apiKey: required(process.env.INTELLIGENCE_API_KEY, "INTELLIGENCE_API_KEY"),
  });
  const snapshot = await inventoryIntelligence(
    client,
    required(option("--user"), "--user"),
    required(option("--agent"), "--agent"),
    limit,
  );
  await writeFile(
    required(option("--out"), "--out"),
    JSON.stringify(snapshot, null, 2),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      inventoried: snapshot.threads.length,
      messages: snapshot.threads.reduce(
        (count, thread) => count + thread.messages.length,
        0,
      ),
    }),
  );
} else if (args[0] === "import") {
  const snapshot = legacyInventorySchema.parse(
    await Bun.file(required(option("--snapshot"), "--snapshot")).json(),
  );
  const database = createDatabase(
    required(process.env.DATABASE_URL, "DATABASE_URL"),
  );
  try {
    console.log(
      JSON.stringify({
        imported: await importIntelligenceInventory(database, snapshot),
      }),
    );
  } finally {
    await database.$client.close();
  }
} else throw new Error("Expected inventory or import; use --help for usage.");
