# 开发日志

## 2026-10-29 — 依赖漏洞升级与 dependabot（审查 M4）

**动机**：审查时 `bun audit` 有 3 个 critical、40 个 high（本次在 main `d6cd2ec` 上复测为 2 critical / 39 high；dompurify 已由 #362 升到 3.4.17）。`2210774b` 删掉 dependabot 后没有任何自动依赖更新。

**原则**：只升到修复版本所在的最小补丁 / 小版本；直接依赖改版本范围，间接依赖用根 `overrides` 固定到修复版；需要大版本升级的不升，列在下面交给小爱决定。

**升级清单**

| 包 | 旧 → 新 | 方式 | 漏洞 |
|---|---|---|---|
| better-auth、@better-auth/* | 1.7.1 → 1.7.14 | app、server 范围 ^1.7.7 | critical：OAuth state 当 Magic Link；high：OAuth Proxy 冒充 |
| proxy-addr | 2.0.7 → 2.0.8 | overrides | critical：IPv4 映射 IPv6 信任网段伪造 IP |
| @modelcontextprotocol/sdk | 1.30.0 → 1.32.2 | server ^1.32.0 + overrides（统一嵌套副本） | high ×4 |
| @modelcontextprotocol/server | 2.0.0 → 2.3.1 | overrides（@mastra/core 锁死 2.0.0） | high ×3 |
| zod（v4） | 4.4.3 → 4.6.7 | 根、app、server ^4.6.6 | high：超大集合耗尽内存 |
| vite | 7.3.6 → 7.3.7 | app ^7.3.7 | high：launch-editor Windows 绕过 |
| axios | 1.19.0 → 1.21.0 | overrides | high ×7 |
| body-parser | 2.3.0 → 2.4.0 | overrides | high：压缩体 DoS |
| fast-uri | 3.1.6 → 3.1.9 | overrides | high ×2 |
| follow-redirects | 1.16.0 → 1.16.2 | overrides | high ×2 |
| source-map-js | 1.2.1 → 1.2.2 | overrides | high：DoS |
| undici（嵌套 6.x / 7.x） | 6.28.0 → 6.29.1，7.29.0 → 7.30.1 | 锁文件内同主版本更新 | high ×多项 |
| agent-computer：@grpc/grpc-js | 1.14.4 → 1.14.6 | agent-computer overrides | high：证书授权判定 |
| pc：undici | 6.29.0 → 6.29.1，7.30.0 → 7.30.1 | `npm audit fix --package-lock-only` | high |

better-auth 1.7.2–1.7.14 都是 1.7.x 补丁：没有新表 / 新列，1.7.11 只修 PostgreSQL int8 列重复迁移差异；需要注意的行为变化是 1.7.12 起「没有 clientId 的提供方拒绝 ID token 登录」，本项目的社交登录都配置了 clientId，不受影响。

**未升（需要大版本，小爱定：本轮不升，不强加 overrides）**

- `zod` 3.25.76（@ag-ui/*、@copilotkit/*、shadcn 依赖 zod 3）：修复只在 zod 4.6.6+，需要上游换到 zod 4。
- `undici` 5.29.0（@ai-sdk/google-vertex、@ai-sdk/openai-compatible 里的 provider-utils 3.x）：修复在 6.29.1，需要升级这两个 @ai-sdk 包的大版本。
- `@graphql-tools/utils` 11.2.2 / 12.0.0（graphql-yoga、@graphql-tools/*，经 @copilotkit/runtime）：修复在 12.0.2+，11 → 12 是大版本，且 12.0.2+ 需要 `@whatwg-node/promise-helpers` 2.x，连带范围较大。
- `@fastify/busboy` 2.1.1（undici 5 引入）：修复在 3.2.1，大版本；随 undici 5 一起解决。

**可达性分析（2026-10-29，结论：本轮不升）**

- **zod 3（GHSA-mrhx-c7xc-m3w5：没有长度上限的数组校验失败时，每个元素都累积 issue，可以把内存耗尽）**：会解析外部输入。CopilotKit v2 运行时和 `server/src/approvals/types.ts` 里的 `RunAgentInputSchema.safeParse` 都用 @ag-ui/core 的 zod 3 schema 校验浏览器发来的 RunAgentInput。但这些接口都在登录守卫（网关签名身份 / requireUser）后面，请求体还受 nginx `client_max_body_size 128m` 限制，所以只有已登录用户能发超大数组拖垮自己的实例，匿名公网打不到。`plan-model.ts` 的 `EventSchemas.parse` 解析的是我们自己配置的模型端点返回的事件，不算不可信输入。
- **undici 5.29.0 + @fastify/busboy 2.1.1**：实际不会加载。@ai-sdk/google-vertex（@copilotkit/runtime 的 `agent/index.mjs` 静态 import）和 @ai-sdk/openai-compatible 下的 provider-utils 3.0.32，只在 `getDefaultDownloadFetch()` 里 `isNodeRuntime()` 为真（Node 且不是 Bun）时，才用 `createRequire` 懒加载 undici。服务端跑在 Bun 上，这个分支永远不走，用的是 Bun 自己的 fetch。代码里 `getDefaultDownloadFetch()` 只被 provider-utils 导出的 `fetchWithValidatedRedirects`（下载前逐跳校验 URL 和重定向）调用；哪些提供商代码路径、在什么输入下会调用它，没有逐一核实（不确定），但不影响结论：在 Bun 上它不会加载 undici。busboy 只被 undici 5 的 multipart 解析引用，同样不可达。
- **@graphql-tools/utils 11.2.2 / 12.0.0**：不对外暴露。它只经 graphql-yoga 被 @copilotkit/runtime 的 v1 GraphQL 端点（`dist/graphql/resolvers`）引用；服务端只 import `@copilotkit/runtime/v2`，v2 的代码里没有 graphql，我们也没有挂 GraphQL 路由，所以这段代码不会被加载。
- 上游（@ag-ui / @copilotkit 换 zod 4，@ai-sdk 的 provider-utils 换 undici 6+，graphql-yoga 换 utils 12.0.2+）发版后，dependabot 的每周 PR 会把修复带进来，到时再合。

**dependabot**：`.github/dependabot.yml` 覆盖 bun（`/`，含 app、server 工作区）、bun（`/agent-computer`）、npm（`/pc`）、github-actions（`/`）；每周一 09:00（Asia/Shanghai），每个生态限 3–5 个 PR，小版本 / 补丁合成一个分组 PR。

**注意**：`bun install` 会把 bun.lock 里 app / server 工作区的 version 行改成 0.1.103，已手动改回与 main 一致的 0.0.0；项目版本号未动。
