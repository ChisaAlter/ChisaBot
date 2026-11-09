import { dirname, join } from "node:path";

const entry = (id, name, config) => ({
  id,
  name: `@deepseek-ai/${name}`,
  ...(config ? { config } : {}),
});

/** The Host capability graph, deliberately without model-facing native tools or a UI. */
export function hostProfile(home, options, pluginPath) {
  return [
    {
      insert: [
        entry("timer", "cordis-plugin-timer"),
        entry("llm", "dsh-llm"),
        entry("llm-extensions", "dsh-deepseek-llm-api-extensions"),
        entry("session", "dsh-session"),
        entry("session-log", "dsh-session-log-deepseek"),
        entry("session-projection", "dsh-session-projection"),
        entry("agent", "dsh-agent"),
        entry("system-prompt", "dsh-system-prompt", {
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
        }),
        entry("tools", "dsh-tools"),
        entry("tool-executor", "dsh-tool-executor-native"),
        entry("agent-loop", "dsh-agent-loop", { agents: [] }),
        entry("agent-default-model", "dsh-agent-default-model", {
          provider: "chisabot",
          model: "unbound",
        }),
        entry("storage", "dsh-storage"),
        entry("storage-json", "dsh-storage-json", {
          root: join(home, "storages"),
        }),
        entry("storage-domain", "dsh-storage-domain", { backend: "json" }),
        entry("session-persistence", "dsh-session-persistence-jsonl", {
          root: join(home, "sessions"),
        }),
        entry("session-checkpoint", "dsh-session-checkpoint-policy"),
        entry("session-projection-cache", "dsh-session-projection-cache", {
          writeEveryEvents: 200,
          writeIntervalMs: 5000,
        }),
        entry("session-query", "dsh-session-query-sqlite", {
          path: ":memory:",
          openAt: "never",
        }),
        entry("session-title", "dsh-session-title", {
          fallbackMaxWords: 5,
          fallbackMaxBytes: 40,
          maxTitleBytes: 80,
        }),
        entry("commands", "dsh-commands"),
        entry("working-directory", "dsh-working-directory"),
        entry("fs", "dsh-fs-local", { cwd: join(home, "workspace") }),
        entry("attachment-local", "dsh-attachment-local"),
        entry("workspace", "dsh-workspace"),
        entry("credentials", "dsh-credentials-local"),
        entry("authorization", "dsh-authorization"),
        entry("token-meter", "dsh-token-meter"),
        // PiAi reserves 4096 tokens before its output cap. Start compaction before that reserve
        // consumes the summary budget on smaller windows; the summary itself remains capped at 1k.
        {
          id: "compaction",
          name: join(dirname(pluginPath), "compaction.mjs").replaceAll(
            "\\",
            "/",
          ),
          config: { headroomTokens: 4096, maxTokens: 1024 },
        },
        entry("approval", "dsh-user-approval", { policy: "ask" }),
        entry("user-questions", "dsh-user-questions"),
        entry("typert", "dsh-typert-registry"),
        entry("typert-loader", "dsh-typert-loader"),
        entry("remote-access", "dsh-api-remote-access"),
        entry("gateway", "dsh-api-gateway"),
        entry("webserver", "dsh-host-webserver", {
          host: options.host ?? "127.0.0.1",
          port: options.port ?? 3086,
        }),
        entry("connection", "dsh-client-connection", {
          trustedHosts: options.trustedHosts ?? [],
        }),
        entry("file-upload", "dsh-client-file-upload"),
        entry("session-controller", "dsh-api-session-controller", {
          nativeOpen: false,
        }),
        {
          id: "chisabot",
          name: pluginPath,
          config: {
            home,
            ownerUserId: options.ownerUserId,
            gatewayUrl: options.gatewayUrl,
            gatewayTokenEnv: options.gatewayTokenEnv,
            providers: options.providers,
          },
        },
      ],
    },
  ];
}
