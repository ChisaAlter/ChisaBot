/**
 * The catalogue of MCP servers this deployment will talk to, and the rule that decides admissibility.
 *
 * First-party only, and the list is frozen in code. A remote MCP server is a piece of somebody
 * else's software that our Bots hand credentials to and take instructions from, so "which servers"
 * is a decision to make once, in review, rather than one to leave to whoever is typing a URL into an
 * admin page at the time. Only servers the vendor themselves maintains are here. A community server
 * that wraps the same API is not equivalent: it is an extra party in the trust path with none of the
 * accountability, and the answer for a vendor without an official server is to wait for one.
 *
 * Every host and path here comes from the vendor's published documentation. They are pinned rather
 * than discovered, because a URL this deployment will hand a credential to is a reviewed source
 * contract.
 *
 * Admissibility is fail-closed and checked against the pinned host, never against what a caller
 * supplied. A URL that does not exactly match a pinned host, or match one anchored per-instance
 * pattern, is refused. This is the control that stops "add an MCP server" from being a request
 * forgery primitive pointed at the deployment's own network.
 */

/**
 * How a server is authenticated, and whose credential does it.
 *
 * The OAuth addresses are pinned here beside the MCP host, for the same reason and with the same
 * rule: they come from the vendor's published documentation and are never taken from a caller.
 * These are where this deployment sends a person's authorization code and receives the refresh
 * token that stands in for their access, so they are a reviewed source contract too.
 */
// The one place browsing and this check agree on: the addresses that hold the deployment's own
// cloud credentials. `target.ts` imports nothing itself, so asking it here adds no dependency.
import { isNeverAllowedHostname } from "../computer/target";
// Type-only, so naming the transport here creates no import cycle with the registry that resolves it.
import type { CuratedTransportKind } from "./transport";

export type CatalogueAuth =
  /** Answers without any credential at all. */
  | { kind: "none" }
  /** One token, held by the deployment, used for everybody. */
  | { kind: "deployment-bearer" }
  /**
   * First-party and in-process. There is no credential, because there is nothing to authenticate
   * to: the call runs against this deployment's own tables, as the person whose turn it is.
   */
  | { kind: "builtin" }
  /**
   * The asker's own grant. The deployment registers an OAuth client; each person consents once and
   * the call runs on their token, so the vendor decides what comes back.
   */
  | {
      kind: "user-oauth";
      authorizationUrl: string;
      tokenUrl: string;
      /** Where a disconnect is sent, so revocation happens at the vendor and not just here. */
      revokeUrl: string;
      /**
       * What to ask a person to consent to. Narrow on purpose: a scope granted by everybody who
       * connects and used by nothing is a permission nobody remembers agreeing to. Empty for a
       * vendor whose consent screen itself is the scoping (Notion), where scope strings would
       * assert a control that does not exist.
       */
      scopes: readonly string[];
      /**
       * How the deployment gets its OAuth client. Absent means an administrator registers one at
       * the vendor and pastes it in. `dynamic` means the deployment registers ITSELF (RFC 7591)
       * on first connect — no admin step, no client secret; PKCE carries the proof instead.
       */
      clientRegistration?: "dynamic";
      /** The RFC 7591 endpoint. Pinned https, required when `clientRegistration` is `dynamic`. */
      registrationUrl?: string;
      /**
       * Vendor-specific consent-URL parameters. Google's offline/consent pair lives HERE rather
       * than in `authorizationUrlFor`, so one vendor's requirements are never sent to another —
       * an unknown parameter is a thing a strict vendor may refuse the whole request over.
       */
      authorizationParams?: Readonly<Record<string, string>>;
    };

export type CatalogueEntry = {
  /** Stable slug. Prefixes every tool name, so tools from two servers can never collide. */
  key: string;
  title: string;
  vendor: string;
  summary: string;
  /**
   * The one host this server lives on. Null for a vendor that gives every customer their own
   * hostname, where {@link CatalogueEntry.hostPattern} decides instead.
   */
  host: string | null;
  /**
   * Anchored pattern for a per-instance vendor. Only consulted when `host` is null, and written
   * anchored at both ends so it cannot match a host that merely ends in the vendor's domain.
   */
  hostPattern?: string;
  /** The path the MCP endpoint is served at. Frozen here, never taken from a caller. */
  path: string;
  /**
   * Whose credential this server is reached with.
   *
   * This used to be `needsCredential: boolean`, which said that a credential was required and not
   * whose it was. That is the one thing about a connector worth being unambiguous about: a reader
   * who has to guess guesses the deployment's, and a deployment-wide credential pointed at a
   * per-person system means everybody's question is answered from what one account can see. So the
   * shape names it, and every entry states it.
   *
   * `deployment-bearer` is a token an administrator holds on behalf of everybody. `user-oauth` is
   * the person's own grant, where the deployment holds only the OAuth client and each person
   * consents for themselves. `builtin` is neither: there is nothing to authenticate to, because the
   * call runs in this process against this deployment's own tables as the person whose turn it is.
   */
  auth: CatalogueAuth;
  /**
   * Where a `deployment-bearer` credential is presented when it is not an `Authorization` header.
   *
   * `keyParam` appends `?name=<token>` to the pinned URL at call time — the form 高德 (`key`),
   * 腾讯地图 (`key`), 滴滴 (`key`) and 百度地图 (`ak`) publish for their MCP endpoints.
   * `keyHeader` sends it as a named request header instead (途牛 `apiKey`). The token itself stays
   * in the vault either way, so the stored `mcp_servers.url` and the audit row carry no credential —
   * the same property `customUrlRefusal` enforces on hand-typed endpoints. Placement is a reviewed
   * property of the entry: a caller never supplies it, which is why `resolveServerUrl` still
   * returns the bare URL.
   */
  keyParam?: string;
  keyHeader?: string;
  /**
   * The tools this vendor's server exposes that change something.
   *
   * Kept so the policy can be written about effect rather than about tool names a rule author would
   * have to look up. Known-incomplete for some vendors, which is why {@link classifyTool} treats an
   * unknown tool as a write rather than as a read: a tool the server never advertised, so nothing
   * here could have named it, is safe to over-scrutinize as a write. The opposite direction is the
   * one that matters for this list: a tool the server DOES advertise but that is missing from here
   * classifies as a read unless the vendor itself recorded an effect for it, so for a vendor that
   * records nothing — which is every one here today — an incomplete list is the failure mode rather
   * than a safe default, and this list has to lean over-inclusive.
   *
   * Nothing outside review can shorten it, either. A name this list holds is a write no matter what
   * a vendor recorded for that action, because this list is what a person read and the recorded
   * effect is whatever was last written into an unconstrained column.
   */
  writeTools: readonly string[];
  /**
   * Which protocol reaches this vendor. Absent means MCP, which is what every entry was.
   *
   * A field rather than an inference, because the answer is not derivable from the host: Google
   * serves Drive over both an MCP endpoint and an ordinary REST API, and which one this deployment
   * uses is a decision about availability and risk rather than a property of the vendor. Naming it
   * here keeps that decision beside the host it applies to, and makes reversing it a one-line diff.
   *
   * NOT EVERY KIND, and the narrowing is the point: see {@link CuratedTransportKind}. The broker's
   * transport is reached from a row's provenance and its url, never from an entry, and an entry
   * naming it resolves to a Composio dial with no app and no brokered gate.
   */
  transport?: CuratedTransportKind;
  docsUrl: string;
};

/**
 * A short list, deliberately.
 *
 * Atlassian, Box, Slack, Salesforce and ServiceNow were here and were removed: each was a reviewed
 * source contract for a vendor nobody had connected, and a screen offering five untried connectors
 * asserts more than this deployment can stand behind. They are in the history if they are wanted
 * back, and re-adding one is a review of that vendor rather than a revert.
 *
 * The China-app block below (高德 through 选股宝) is the portion of the much larger
 * awesome-china-mcp index that meets this file's bar today: an OFFICIAL remote MCP endpoint the
 * vendor itself publishes, reached over Streamable HTTP, with a credential model this deployment
 * can honour without putting secrets in stored URLs. The rest of that index lives in
 * `directory.ts` — browsable with its own connect pathway, deliberately NOT admissible here:
 * community servers, account-session logins, per-person tokens, SSE-only endpoints and API-only
 * entries each fail at least one of those checks. Promoting one is a review of that vendor.
 *
 * Routines is the first entry here that is not a remote vendor at all — no host to dial, nothing
 * outside this process to trust. It is in the catalogue anyway, on purpose rather than by oversight:
 * the catalogue is where a deployment decides which Bots may do what, and a Bot that can schedule its
 * own future runs is a capability worth that same deliberate grant, even though there is no vendor on
 * the other end of it.
 */
export const CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  {
    key: "parallel",
    title: "Parallel Search",
    vendor: "Parallel",
    summary:
      "Public-web search and source extraction. Free anonymous access for light use.",
    host: "https://search.parallel.ai",
    path: "/mcp",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://docs.parallel.ai/integrations/mcp/search-mcp",
  },
  {
    key: "parallel-authenticated",
    title: "Parallel Search (API key)",
    vendor: "Parallel",
    summary:
      "Public-web search and extraction using this deployment's Parallel API key.",
    host: "https://search.parallel.ai",
    path: "/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://docs.parallel.ai/integrations/mcp/search-mcp",
  },

  {
    key: "google-drive",
    title: "Google Drive",
    vendor: "Google",
    summary: "Files in the Drive of whoever is asking.",
    /*
     * Google publishes one MCP server per Workspace product, each on its own host: Gmail, Docs,
     * Sheets, Slides, Calendar, Chat and People have their own. Drive is here because it is the one
     * a question about a document needs. Each of the others is a further entry, not a flag on this
     * one, so adding Gmail stays a reviewed decision about Gmail.
     */
    /*
     * The GA REST API, not `drivemcp.googleapis.com`.
     *
     * The MCP server was the original choice and is the better one on paper: vendor-maintained, no
     * Drive-specific code here at all. It is gated behind the Google Workspace Developer Preview
     * Program, and an unenrolled project is refused with `The caller does not have permission` —
     * which describes the project, not the credential, so every check available locally reports a
     * correct setup. Enrolment is a Workspace-account application with a stated turnaround of days.
     *
     * This host has been generally available since 2015. The MCP entry is one line away: set
     * `transport` back to `mcp` and restore the host and path above. Tool names match Google's MCP
     * server exactly, so grants survive the swap in either direction.
     */
    host: "https://www.googleapis.com",
    path: "/drive/v3",
    transport: "google-drive-rest",
    /*
     * The first vendor here that cannot be reached with a token an administrator pastes. Google
     * issues no such token: access is an authorization-code grant belonging to a person. That is
     * not a limitation to work around, it is the property this connector exists for — two people
     * asking the same question should get the answers their own accounts can see.
     */
    auth: {
      kind: "user-oauth",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      // Read-only, because nothing in this slice writes to anybody's Drive.
      scopes: Object.freeze(["https://www.googleapis.com/auth/drive.readonly"]),
      /*
       * `offline` and `consent` are both load bearing FOR GOOGLE. Without `access_type=offline`
       * Google returns no refresh token; without `prompt=consent` a reconnect returns none either.
       * They are Google parameters, so they live on Google's entry.
       */
      authorizationParams: Object.freeze({
        access_type: "offline",
        prompt: "consent",
      }),
    },
    /*
     * Named writes even though the scope above makes Google refuse them.
     *
     * Belt and braces on purpose. The scope is what stops them; this list is what keeps a boundary
     * written about writes covering them, so widening the scope later cannot quietly turn a write
     * into something the policy engine has never heard of.
     */
    writeTools: Object.freeze(["create_file", "copy_file"]),
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
  },
  {
    key: "notion",
    title: "Notion",
    vendor: "Notion",
    summary: "Pages and databases of whoever is asking.",
    /*
     * The hosted MCP server Notion runs, on the default MCP transport — the first entry to use
     * it. Drive's REST adapter is a workaround for a preview-gated vendor; Notion's server is
     * generally available, so this entry is the shape the catalogue was designed for.
     */
    host: "https://mcp.notion.com",
    path: "/mcp",
    auth: {
      kind: "user-oauth",
      // From https://mcp.notion.com/.well-known/oauth-authorization-server, verified live.
      authorizationUrl: "https://mcp.notion.com/authorize",
      tokenUrl: "https://mcp.notion.com/token",
      // Notion's published revocation_endpoint IS its token endpoint — not a copy-paste mistake.
      revokeUrl: "https://mcp.notion.com/token",
      /*
       * Notion has no scope strings and no read-only scope: access is per-page, chosen on the
       * consent screen. `writeTools` below plus the action policy are the ENTIRE write barrier —
       * there is no vendor-side scope backing them up.
       */
      scopes: Object.freeze([]),
      clientRegistration: "dynamic",
      registrationUrl: "https://mcp.notion.com/register",
    },
    /*
     * The writing tools as the hosted server advertises them today. The hosted server advertises
     * its tools, so a name here that does not match an advertised tool is not the risk — an
     * advertised tool that is missing from this list is: {@link classifyTool} reads an unlisted
     * but advertised name as a read, never as a write. Notion's MCP listing carries no per-action
     * effect, so this list is the only thing that can say otherwise and nothing backstops it. That
     * makes under-inclusion the failure mode, so this list has to lean over-inclusive rather than
     * minimal, and reconciling it against the live tool list on the first Refresh tools is
     * required, not cosmetic.
     */
    writeTools: Object.freeze([
      "notion-convert-page-to-skill",
      "notion-create-attachment",
      "notion-create-comment",
      "notion-create-database",
      "notion-create-file-upload",
      "notion-create-folder",
      "notion-create-pages",
      "notion-create-view",
      "notion-duplicate-page",
      "notion-move-pages",
      "notion-update-data-source",
      "notion-update-folder",
      "notion-update-page",
      "notion-update-view",
    ]),
    docsUrl: "https://developers.notion.com/guides/mcp/build-mcp-client",
  },
  /*
   * Official remote China-app MCP endpoints. The common properties: the vendor publishes the
   * endpoint itself (all pinned below from the vendor's own docs), the transport is Streamable
   * HTTP, and the credential is either absent or a deployment-held key interpolated by
   * `keyParam`/`keyHeader` at call time — never stored in the URL. Read-only where writeTools
   * is empty; the one exception names its order-placing tools explicitly.
   */
  {
    key: "amap",
    title: "高德地图 Amap",
    vendor: "高德地图",
    summary:
      "地理/逆地理编码、POI 检索、路径规划（驾车/公交/步行/骑行）、天气、IP 定位。只读查询。",
    host: "https://mcp.amap.com",
    path: "/mcp",
    keyParam: "key",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://developer.amap.com/api/mcp-server/gettingstarted",
  },
  {
    key: "baidu-map",
    title: "百度地图 Baidu Maps",
    vendor: "百度地图",
    summary:
      "地点检索、路线规划、天气、路况等 10 大 API。只读查询；AK 走地址参数，由部署保管。",
    host: "https://mcp.map.baidu.com",
    path: "/mcp",
    keyParam: "ak",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://lbsyun.baidu.com/faq/api?title=mcpserver/quickstart",
  },
  {
    key: "tencent-map",
    title: "腾讯地图 Tencent Maps",
    vendor: "腾讯位置服务",
    summary: "地理编码、POI、路径规划、天气等腾讯位置服务。只读查询。",
    host: "https://mcp.map.qq.com",
    path: "/mcp",
    keyParam: "key",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://lbs.qq.com/service/MCPServer/MCPServerGuide/overview",
  },
  {
    key: "didi",
    title: "滴滴出行 DiDi（生产）",
    vendor: "滴滴出行",
    summary:
      "打车全流程：预估车型与价格、下单、订单查询、取消、司机位置，以及地图检索与路线规划。管理员持有的开发者 MCP Key 全部署共用——真实叫车会落在该账号并产生费用，写操作需审批。",
    host: "https://mcp.didichuxing.com",
    path: "/mcp-servers",
    keyParam: "key",
    auth: { kind: "deployment-bearer" },
    /*
     * Order placement and cancellation change the real world and spend real money; the app-link
     * generators create a call the person finishes in the DiDi app. Both spellings of the link
     * tool are listed because the docs have published both.
     */
    writeTools: Object.freeze([
      "taxi_create_order",
      "taxi_cancel_order",
      "taxi_new_order",
      "taxi_generate_ride_app_link",
    ]),
    docsUrl: "https://mcp.didichuxing.com/api",
  },
  {
    key: "didi-sandbox",
    title: "滴滴出行 DiDi（沙箱）",
    vendor: "滴滴出行",
    summary:
      "与生产端点相同的工具面，返回模拟数据、不产生真实订单与费用——接入与联调走这里。同一开发者 MCP Key。",
    host: "https://mcp.didichuxing.com",
    path: "/mcp-servers-sandbox",
    keyParam: "key",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([
      "taxi_create_order",
      "taxi_cancel_order",
      "taxi_new_order",
      "taxi_generate_ride_app_link",
    ]),
    docsUrl: "https://mcp.didichuxing.com/api",
  },
  {
    key: "aihot",
    title: "AIHOT 中文 AI 资讯",
    vendor: "AIHOT",
    summary:
      "AI 资讯话题搜索、热点事件、日/周/月简报。官方托管，匿名只读，无需凭证。",
    host: "https://aihot.news",
    path: "/api/mcp",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://aihot.news/agent?tab=mcp",
  },
  {
    key: "metaso",
    title: "秘塔 AI 搜索 Metaso",
    vendor: "秘塔科技",
    summary:
      "多源中文网页搜索、网页阅读与 RAG 问答。只读；API Key 按量计费，由部署保管。",
    host: "https://metaso.cn",
    path: "/api/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://metaso.cn/search-api/playground",
  },
  {
    key: "lava",
    title: "熔岩 Lava（A股消息面热度）",
    vendor: "AI Dolphin",
    summary:
      "A股个股与概念板块的消息流热度：热榜、首发、小时窗口、日面板、机构/KOL 覆盖。只读；`lvk_` Key 按次计费，由部署保管。",
    host: "https://lava.ai-dolphin.com",
    path: "/subscribe/v1/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://lava.ai-dolphin.com/subscribe/docs",
  },
  {
    key: "xgb",
    title: "选股宝 / 华尔街见闻",
    vendor: "华尔街见闻",
    summary:
      "大涨股板块与异动原因、全球财经资讯全文（近两个月）。只读查询，无实时行情；token 在控制台生成，由部署保管。",
    host: "https://xgb-mcp-api.xuangubao.cn",
    path: "/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://wallstreetcn.com/org-mcp/token",
  },
  {
    key: "routines",
    // Key, host and transport kind keep the upstream "routines" names: they are stored identifiers.
    // The upstream routine tools were merged into ChisaBot schedules (slimming P4c, `schedule_*`
    // tools, DESIGN.md §55); only the responsibility trigger tools are served here now.
    title: "Triggers",
    vendor: "ChisaBot",
    summary:
      "Event triggers that wake a Bot for one of its person's responsibilities.",
    /*
     * First-party and in-process: no host to dial, no credential to hold. In the catalogue anyway,
     * because the catalogue is where a deployment decides WHICH Bots may do WHAT.
     */
    host: "builtin://routines",
    path: "/",
    transport: "builtin-routines",
    auth: Object.freeze({ kind: "builtin" }),
    writeTools: Object.freeze([
      "create_trigger",
      "pause_trigger",
      "resume_trigger",
      "delete_trigger",
    ]),
    docsUrl: "https://github.com/ChisaAlter/ChisaBot/blob/main/docs/schedules.md",
  },
]);

const BY_KEY = new Map(CATALOGUE.map((entry) => [entry.key, entry]));

/** Compiled once from the frozen source strings above. Never from anything a caller supplied. */
const PATTERNS = new Map(
  CATALOGUE.filter((entry) => entry.hostPattern !== undefined).map((entry) => [
    entry.key,
    new RegExp(entry.hostPattern as string),
  ]),
);

/**
 * Which kind of credential this entry's server record may be pointed at, or null when it takes none
 * from the caller.
 *
 * Beside the entry rather than at the call site, because it is a property of the vendor's auth and
 * not of the request. `deployment-bearer` is the only kind that means "one token this deployment
 * holds for this server", which is what `mcp` names in the vault. A `user-oauth` server is answered
 * with the asker's own grant and its OAuth client is registered through its own call, which mints
 * the credential itself, so an id offered when the server is added is never the right one whatever
 * kind it names. A server needing no credential takes none.
 */
export function serverCredentialKind(entry: CatalogueEntry): "mcp" | null {
  return entry.auth.kind === "deployment-bearer" ? "mcp" : null;
}

export function catalogueEntry(key: string): CatalogueEntry | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Is this host one this entry is allowed to be pointed at?
 *
 * Compares the RAW host string, case-sensitively, and returns false for anything it does not
 * positively recognise. Every branch that cannot prove admissibility returns false rather than
 * falling through, because the failure mode of the opposite arrangement is a deployment reaching an
 * address nobody chose.
 */
export function hostAdmissible(entry: CatalogueEntry, host: string): boolean {
  if (entry.host !== null) return entry.host === host;
  const pattern = PATTERNS.get(entry.key);
  if (!pattern) return false;
  return pattern.test(host);
}

/**
 * The URL this server is reached at, or null if the request is not admissible.
 *
 * `instanceHost` is only consulted for a per-instance vendor, and only after the pattern accepts it.
 * The path is always the catalogue's, never the caller's, so an admissible host cannot reach some
 * other endpoint on the same machine.
 */
export function resolveServerUrl(
  key: string,
  instanceHost?: string,
): { url: string; entry: CatalogueEntry } | null {
  const entry = catalogueEntry(key);
  if (!entry) return null;

  const host = entry.host ?? instanceHost ?? null;
  if (host === null) return null;
  if (!hostAdmissible(entry, host)) return null;

  // The path is joined rather than concatenated blindly so a root path does not produce a double
  // slash, which some servers treat as a different route.
  const path = entry.path === "/" ? "" : entry.path;
  return { url: `${host}${path}`, entry };
}

/**
 * What this tool does, in the only two categories a policy author cares about.
 *
 * A RECORDED EFFECT MAY NARROW WHAT A BOT MAY DO AND MAY NEVER WIDEN IT. That is the criterion the
 * order below is built from, and it is why the reviewed write list is consulted FIRST. Both sources
 * are trusted to make an action a write; only the reviewed one is trusted to make an action a read
 * where the other says write. `writeTools` was read by a person before it shipped. A recorded effect
 * arrives from a vendor listing into a plain `text` column with no check constraint, so it is
 * whatever was last written there, by a refresh or by a hand on a psql prompt. A value in that column
 * therefore cannot take an action off the reviewed list.
 *
 * THREE SOURCES, CONSULTED IN THIS ORDER. Whether the server advertised the name at all: it did not,
 * the name came from a model and the answer is write, and nothing later overrides that. Then the
 * reviewed write list, which settles a name it holds as a write. Then what the vendor recorded, where
 * exactly `read` is a read and every other value it holds — a recorded write, an unrecognised label,
 * a different case, the empty string — is a write. Where the column holds nothing at all the reviewed
 * list finishes the job: an advertised name it declines to call a write is a read.
 *
 * Unknown counts as a write throughout. A server with no catalogue entry behind it is a write unless
 * the vendor recorded a read for that action — there is no reviewed list to consult, so an unlabelled
 * action of theirs has nothing saying it is safe.
 *
 * So there are two ways to earn a read, and both require somebody to have said so. Either the vendor
 * labelled the action a read and no reviewed list contradicts them, or the server advertised it and a
 * reviewed list declined to call it a write. Guessing permissively is recoverable only in those two
 * cases; everywhere else the answer is a write.
 */
export function classifyTool(
  entry: CatalogueEntry | null,
  toolName: string,
  advertised: boolean,
  /**
   * What the vendor said about this action when it was listed, or null when nothing did.
   *
   * Consulted AFTER the entry's write list, so it can only agree with review or add to it. It is the
   * only source that can exist for a broker's catalogue — Composio labels every one of Gmail's
   * sixty-three actions, and no reviewed list here could keep pace with several hundred apps that
   * change weekly — so where review said nothing it is the whole answer.
   *
   * PRESENCE, NOT TRUTHINESS, is what makes it consulted, and only the exact string `read` produces a
   * read. A recorded write, an unrecognised value, a different case and the EMPTY STRING are all
   * writes: the empty string is a value the column holds rather than a silence, and reading it as
   * "nothing was recorded" would send an advertised action no reviewed list names down the read
   * branch. Null and undefined are the column saying nothing, and fall through to the reviewed list.
   * So a column somebody typed into by hand, or a label a vendor adds later that this code has never
   * heard of, cannot widen what a Bot may do unasked.
   */
  recorded?: string | null,
): "read" | "write" {
  // A name the server never listed came from a model, and nothing reviewed says it only reads —
  // checked first, so neither later source can rescue a name that was never advertised.
  if (!advertised) return "write";
  // The reviewed list outranks the column, and only in this direction: a name a person reviewed as a
  // write stays a write whatever the listing recorded about it.
  if (entry?.writeTools.includes(toolName)) return "write";
  // Anything the column holds settles the rest. `typeof` rather than truthiness so the empty string
  // is treated as the value it is instead of as an absence of one.
  if (typeof recorded === "string")
    return recorded === "read" ? "read" : "write";
  // A server an administrator added by URL has no reviewed tool catalogue behind it, so nothing here
  // can say a tool of theirs only reads. Everything it offers is a write.
  if (!entry) return "write";
  // Advertised, not on the reviewed write list, and nothing recorded. Two sources had the chance to
  // call it a write and neither did.
  return "read";
}

/**
 * Words that make a parameter name a credential, wherever they appear in it.
 *
 * A containment test rather than a list of exact names, because the exact-name version of this rule
 * refused `?token=` and accepted `?auth_token=`, `?api_token=`, `?session_token=` and every other
 * spelling one word away. An operator has no way to know which of those the check happens to hold,
 * so a rule that only refuses the names somebody thought of reads as a guard while behaving like a
 * gap.
 *
 * Not shared with `sensitiveKeys` in `audit.ts`: that module reaches the database and this function
 * deliberately imports nothing that does. The two also want different contents, since audit redacts
 * `content`, `prompt` and `result`, which are payload field names and mean nothing here.
 */
const CREDENTIAL_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "signature",
  "bearer",
];

/**
 * Names that are a credential on their own but are too short to contain safely.
 *
 * `sig` is the reason this list is separate from the one above: "design" contains it. These are
 * compared whole, so an ordinary word carrying the same three letters is left alone.
 */
const CREDENTIAL_NAMES = new Set([
  "auth",
  "authorization",
  "pass",
  "pwd",
  "sig",
]);

/**
 * Does this parameter name say it holds a credential?
 *
 * Names are compared with their separators dropped, so `api_key`, `apiKey` and `x-api-key` are one
 * question rather than three. A name ending in "key" is a credential and a name merely containing it
 * is not, which is what keeps `keyword` and `monkey` apart; "author" is likewise not "auth".
 *
 * It over-refuses in one direction on purpose. A parameter this rule misreads costs an operator a
 * rename, and one it misses is written to an append-only audit row that cannot be deleted.
 */
function readsAsCredential(name: string): boolean {
  const normalized = name.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (CREDENTIAL_NAMES.has(normalized) || normalized.endsWith("key")) {
    return true;
  }
  return CREDENTIAL_WORDS.some((word) => normalized.includes(word));
}

/**
 * Is this a URL an administrator may point the deployment at?
 *
 * A curated entry is reviewed in code; this is the other path, and it needs its own floor because
 * "add an MCP server" is otherwise a request-forgery primitive aimed at whatever the server can
 * reach: cloud metadata endpoints, databases on the same network, admin panels bound to localhost.
 * The rules are deliberately blunt.
 *
 * HTTPS only, because the credential is a bearer token and plaintext is not negotiable.
 * No address literals, localhost or internal suffixes, because those point at the deployment rather
 * than a vendor service.
 *
 * This is static URL validation: it checks the literal host string and scheme before storage. DNS
 * resolution and per-request network policy are separate deployment controls.
 */
export function customUrlRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a URL.";
  }

  if (url.protocol !== "https:") {
    return "An MCP server must be reached over https.";
  }

  // Userinfo is not part of the host, so none of the host rules below would look at it, and what is
  // typed here is stored verbatim: addCustomServer writes the string into mcp_servers.url and into
  // the configuration.changed audit payload, whose redaction keys on the field name rather than the
  // value. A secret written this way would sit in the trail in clear text. The refusal deliberately
  // does not echo the URL back.
  if (url.username || url.password) {
    return "Put the credential in the token field rather than in the address.";
  }

  /*
   * The query is the other half of the same hole, and the fragment is the half after that.
   *
   * No host rule below reads either one, and both are stored and audited with the rest of the
   * string, so a token written here is as durable and as readable as one written into the userinfo.
   * The fragment never reaches the server at all, which is why it is not a request-forgery concern
   * and is still a disclosure one: what this rule is about is where the string ends up, not where
   * the request goes.
   *
   * The test is on the parameter name rather than on the presence of a query, because vendors
   * legitimately route and version with parameters. A floor that refused every one of them would be
   * one an operator works around rather than with, and an ordinary `#section` is left alone for the
   * same reason.
   */
  const hash = url.hash.replace(/^#/, "");
  const marker = hash.indexOf("?");
  const fragment =
    marker === -1 ? [hash] : [hash.slice(0, marker), hash.slice(marker + 1)];
  const named = [
    ...url.searchParams.keys(),
    ...fragment.flatMap((part) => [...new URLSearchParams(part).keys()]),
  ];
  if (named.some(readsAsCredential)) {
    return "Put the credential in the token field rather than in the address.";
  }

  // A trailing dot is the root-anchored spelling of the same name and resolves to the same place, so
  // they are stripped here rather than added to each comparison below. Without it "localhost."
  // misses the equality test, "vault.internal." misses the suffix tests, and "database." picks up
  // the dot that the single-label test keys on, so the fully qualified form of every name this
  // function refuses walks straight through it.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");

  // Bracketed IPv6 arrives with the brackets already stripped by URL, so the colon test catches it.
  if (host.includes(":") || /^[0-9.]+$/.test(host)) {
    return "Give a hostname rather than an IP address.";
  }
  /*
   * The cloud metadata endpoint, by name rather than by luck.
   *
   * `metadata.goog` is Google's own short alias for it, published beside `metadata.google.internal`,
   * and it carries a dot and none of the suffixes below, so it read as an ordinary vendor name. The
   * long spelling was refused only incidentally, by the `.internal` test.
   *
   * Asked of the list browsing already uses rather than a second copy here. That list holds the
   * aliases somebody has already had to think about, including the ones Alibaba and ECS answer on,
   * and a new alias added there should not have to be remembered here as well.
   */
  if (isNeverAllowedHostname(host)) {
    return "That address holds this deployment's own cloud credentials.";
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "That address is local to the deployment.";
  }
  if (
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain") ||
    // How a Kubernetes service is addressed from inside the cluster. It carries dots and none of
    // the suffixes above, so without this it reads as an ordinary vendor name.
    host.endsWith(".svc") ||
    !host.includes(".")
  ) {
    return "That address is not reachable from outside this network.";
  }

  return null;
}
