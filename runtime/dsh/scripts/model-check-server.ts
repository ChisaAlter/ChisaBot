/** Run inside the existing ChisaBot container: credentials stay in its model resolver. */
import { loadConfig } from "/app/server/src/config.ts";
import { createDatabase } from "/app/server/src/db/client.ts";
import { createModelSettingsService, createModelSettingsStore } from "/app/server/src/model-settings.ts";
import { currentDateContext } from "/app/server/src/agents/current-date.ts";
import { createModelCatalogService } from "/app/server/src/model-catalog.ts";

const config = loadConfig();
const database = createDatabase(config.databaseUrl, { max: 1 });
try {
  const store = createModelSettingsStore(database);
  if (!(await store.read())) throw new Error("A saved application model connection is required.");
  const service = createModelSettingsService({
    store, encryptionKey: config.keyEncryptionKey,
    fallback: { provider: "openai", model: "unused", baseUrl: "http://127.0.0.1", useApiKey: false },
    fallbackApiKey: async () => null,
  });
  const connection = await service.resolve();
  const input = JSON.parse(await Bun.stdin.text());
  if (input.operation === "describe") {
    console.log(JSON.stringify({ provider: connection.provider, model: connection.model }));
  } else if (input.operation === "catalog") {
    const catalog = await createModelCatalogService({ resolveConnection: () => service.resolve() }).list();
    console.log(JSON.stringify(catalog.models.filter(model => model.id === input.model)));
  } else if (input.operation === "current-date") {
    console.log(JSON.stringify({ content: currentDateContext() }));
  } else {
    const path = connection.provider === "anthropic" ? "messages" : "chat/completions";
    const response = await fetch(`${connection.baseUrl.replace(/\/+$/, "")}/${path}`, {
      method: "POST", signal: AbortSignal.timeout(90_000),
      headers: { "content-type": "application/json", ...(connection.provider === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}), ...(connection.apiKey ? connection.provider === "anthropic" ? { "x-api-key": connection.apiKey } : { authorization: `Bearer ${connection.apiKey}` } : {}) },
      body: JSON.stringify(input.body),
    });
    if (!response.ok) throw new Error(`Configured model returned HTTP ${response.status}.`);
    if (!response.body) throw new Error("Model response has no stream.");
    for await (const chunk of response.body) await Bun.write(Bun.stdout, chunk);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Model verification failed.");
  process.exitCode = 1;
} finally {
  await database.$client.close();
}
