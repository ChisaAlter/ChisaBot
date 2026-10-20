import { markEventStreamUnbuffered } from "./event-stream-headers";
import type { Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { compress } from "hono/compress";
import { MAX_IMAGE_BYTES } from "../../shared/attachments";
import type { PanelServices } from "./panels/service";
import {
  authoriseAgentCall,
  parseAgentToolCallInput,
  type RunAssertion,
} from "./agents/callback-token";
import { computerAccessCheck } from "./agents/computer-access";
import { runtimeRun } from "./agents/runtime-path";
import {
  type BotLifecycleServices,
  createBotLifecycleRoutes,
} from "./agents/lifecycle-routes";
import type { BotAccessCheck } from "./agents/profile-policy";
import type { AgentProfileStore } from "./agents/profile-store";
import {
  type AgentModelService,
  ModelSelectionError,
} from "./agents/model-selection";
import { createAgentRoutes } from "./agents/routes";
import { createApprovalRoutes } from "./approvals/routes";
import { parseProfileInput, profileNeedsSetup } from "./people/onboarding";
import type { ApprovalService } from "./approvals/service";
import {
  type AuditEventType,
  type AuditInitiator,
  AuditQueryError,
  type AuditReader,
  type AuditStore,
  auditQueryFromUrl,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "./audit";
import { createDevRequireUser } from "./auth/dev-actor";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  type RoleRepository,
  requireAdmin,
} from "./auth/guards";
import {
  createAttachmentRoutes,
  createChannelAttachmentRoutes,
} from "./channels/attachments";
import type { ChannelEventHub } from "./channels/events";
import { type ChannelStore, createChannelRoutes } from "./channels/routes";
import type { ThreadIdentity } from "./channels/thread-identity";
import { createThreadRoutes } from "./channels/thread-routes";
import { createThreadReader } from "./channels/thread-status";
import { createComponentRoutes } from "./components/routes";
import type { SandboxedStore } from "./components/sandboxed";
import { createSandboxedRoutes } from "./components/sandboxed-routes";
import type { ComponentStore } from "./components/store";
import type { ComputerGateway } from "./computer/gateway";
import type { PageFrameStore } from "./computer/page-frames";
import type { PolicyStore } from "./computer/policy-store";
import { createComputerRoutes } from "./computer/routes";
import { configuredAuthProviders, type DeploymentConfig } from "./config";
import {
  type CredentialAdminService,
  type CredentialInput,
  CredentialRefusedError,
} from "./credentials";
import type { Database } from "./db/client";
import { withModelConnectionScope } from "./model-connection-context";
import { type ModelCatalogService, ModelCatalogError } from "./model-catalog";
import { MAGPIE_MOUNT, type MagpieService } from "./magpie";
import { readRunningBuild, versionPayload } from "./build-info";
import type { MagpieOverview } from "../../shared/model-selection";
import {
  type ModelSettingsService,
  ModelSettingsValidationError,
} from "./model-settings";
import { withoutStatement } from "./db/query-failure";
import { mountDesktopConnectionFailure } from "./desktop-connection-failure";
import { createTranscriptionProvider } from "./dictation/provider";
import { createDictationRoutes } from "./dictation/routes";
import { createIntelligenceClient } from "./intelligence-client";
import type { LocalConversationBackend } from "./local-conversations";
import { createPasswordRoutes, createSignInRoutes } from "./passwords/routes";
import type { SignInService } from "./passwords/service";
import type { OnboardingStore } from "./people/onboarding";
import type { PeopleStore } from "./people/store";
import type { ComposioBroker } from "./plugins/broker";
import { createPluginRoutes } from "./plugins/routes";
import {
  isDeploymentFault,
  PluginRefusedError,
  type PluginStore,
} from "./plugins/store";
import { REFUSAL_MARKER, vendorAnswer } from "./plugins/tools";
import {
  type ModelProviderProxy,
  mountProviderOAuthProxy,
} from "./provider-oauth";
import type { ResponsibilityBindingStore } from "./responsibilities/bindings";
import type { ResponsibilityEngine } from "./responsibilities/engine";
import { createGithubResponsibilityRoutes } from "./responsibilities/github";
import { createResponsibilityRoutes } from "./responsibilities/routes";
import type { TriggerStore } from "./responsibilities/triggers";
import type { ResponsibilityStore } from "./responsibilities/types";
import type { SelfHostBanner } from "./self-host-banner";
import type { PackageStatusReader } from "./tenant-package";
import {
  INSTRUCTIONS_LIMIT,
  InstructionsTooLongError,
  type UserInstructionsStore,
} from "./user-instructions";
import type { UserPreferencesStore } from "./user-preferences";
import { userPreferencesRoutes } from "./user-preferences-routes";

/**
 * How much of a multipart body is boundary, headers and other fields rather than file.
 *
 * Generous on purpose. Measured against what the composer actually sends — one `file` part and one
 * `uploadGroup` field — the framing is 360 bytes for a short filename and 614 for a 255-character
 * one; a filename full of non-ASCII percent-encodes to a few times that and is still nowhere near
 * this. 64 KiB is therefore an allowance no honest request can exhaust, and it raises the amount of
 * memory a hostile request can pin by 0.8%, which was never the number that mattered.
 */
const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;

/**
 * The ceiling on the whole POST body of a channel attachment upload.
 *
 * THIS IS NOT `MAX_IMAGE_BYTES`, AND THE DIFFERENCE IS THE POINT. Every other gate on this path —
 * the composer's pre-check, `attachmentsConfigFor`'s `maxSize`, the handler's own 413 — measures
 * THE FILE. This one measures THE ENVELOPE: `bodyLimit` runs before anything has parsed the
 * multipart body, so all it can count is bytes on the wire, file and framing together.
 *
 * Set to `MAX_IMAGE_BYTES` exactly, those two units were silently treated as one, and the ~360
 * bytes of boundary and headers wrapped around a file at the documented ceiling were enough to push
 * the body over it: an 8,388,608-byte image — the exact number the composer publishes as the limit —
 * was refused 413, while 8,388,308 bytes went through. A limit nobody can reach is a limit that is
 * wrong, so the envelope's ceiling is the file's ceiling plus room for the envelope.
 *
 * The slack costs nothing it was protecting against. A body between the two numbers is still read
 * into memory, and then still refused by the handler once `file.size` is a thing anybody can look
 * at — which is where a text upload, whose real limit is `MAX_FILE_BYTES`, is refused too. What the
 * door exists to stop is the 2GB body, and it still does.
 */
export const UPLOAD_BODY_LIMIT_BYTES =
  MAX_IMAGE_BYTES + MULTIPART_FRAMING_ALLOWANCE;

/**
 * One row for something an administrator did to somebody's access.
 *
 * The address is on the row rather than only the user id, because the id means nothing to a person
 * reading the trail a year later and the user row may be gone by then.
 */
export type DeploymentToolCallInput = {
  name: string;
  args: Record<string, unknown>;
  botId: string;
  actorId: string;
  initiator?: AuditInitiator;
  /** Full verified scope. A caller cannot choose a different source thread, depth or lease. */
  run: RunAssertion;
};
export type DeploymentToolCaller = (
  input: DeploymentToolCallInput,
) => Promise<{ text: string; isError: boolean } | null>;

export function createApp(
  config: DeploymentConfig,
  auth?: AuthService,
  roleRepository?: RoleRepository,
  auditReader?: AuditReader,
  credentialService?: CredentialAdminService,
  packageStatusReader?: PackageStatusReader,
  /**
   * The CopilotKit endpoint, already built by the caller.
   *
   * Passed in rather than constructed here so this module never imports the runtime. The runtime
   * pulls in `eventsource`, which Bun cannot `require()` from a test, so importing it at module
   * scope broke every server test that touches createApp even though none of them use CopilotKit.
   */
  copilotHandler?: HonoApp,
  /** The single governed computer module: policy, audit trail, transport, and provider lifecycle. */
  computerGateway?: ComputerGateway,
  /** What the gateway enforces, and what an administrator can change while running. */
  computerPolicy?: PolicyStore,
  /** Bots as durable objects: profile, roster, visibility. */
  agentProfileStore?: AgentProfileStore,
  /** The durable channels a Bot runs in. */
  channelStore?: ChannelStore,
  /** Live channel activity. Absent leaves the routes working, just without the socket. */
  channelEvents?: ChannelEventHub,
  /**
   * Where a Bot's own refusal is written.
   *
   * Separate from `auditReader`, which only reads: this writes, and it is the one thing in the trail
   * that is not decided by the gateway, a model declining before it calls anything.
   */
  auditStore?: AuditStore,
  /**
   * Which components each Bot may answer with.
   *
   * Absent leaves the app working and every Bot answering in prose, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must not fall back to granting
   * everything.
   */
  componentStore?: ComponentStore,
  /**
   * The MCP servers and packaged skills this deployment has, and which Bots hold them.
   *
   * Absent leaves every Bot with the tools it was born with, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must offer nothing extra rather than
   * fall back to offering everything.
   */
  pluginStore?: PluginStore,
  /**
   * Components authored in the browser rather than compiled into the build.
   *
   * Absent leaves the compiled gallery working exactly as before, which is the correct degraded
   * behaviour: the React path is the primary one and does not depend on this.
   */
  sandboxedStore?: SandboxedStore,
  /**
   * How this deployment names the threads it mints.
   *
   * Absent leaves the direct Bot chat generating its own id in the browser, which works and simply
   * says nothing about which deployment the conversation belongs to.
   */
  threadIdentity?: ThreadIdentity,
  /**
   * Who has signed in, and what an administrator may do about them.
   *
   * Absent leaves the people screen answering 503 rather than an empty list, which is the honest
   * degraded behaviour: "nobody has signed in" and "this deployment cannot tell you" are different
   * answers and an administrator deciding who has access needs to know which one they are reading.
   */
  peopleStore?: PeopleStore,
  // Enterprise identity providers (SSO) removed in slimming P6-2; positional slot kept.
  _removedIdentityProviders?: undefined,
  /**
   * Chooses which coworker an untagged message is for, before a channel is pinned to one.
   *
   * Passed in already built, like the copilot handler, so this module never imports the model
   * client. Absent leaves the composer's existing behaviour untouched: an untagged message goes to
   * the default coworker, which is exactly the failsafe the router itself falls back to.
   */
  /** Removed in slimming P4b (intent routing); the slot stays because these are positional. */
  _intentRouter?: undefined,
  /**
   * Where the frame a browsing turn ended on is kept.
   *
   * Appended last on purpose: these are positional, so inserting one anywhere else silently
   * shifts every existing call site's arguments by one.
   *
   * Absent leaves the transcript working and past turns without a picture, which is the correct
   * degraded behaviour: a conversation that cannot show what it saw is better than one that shows
   * the wrong thing.
   */
  pageFrames?: PageFrameStore,
  /**
   * Positional slots of the removed upstream routines (runner + store), merged into ChisaBot
   * schedules in slimming P4c. Kept so every later argument stays where call sites put it.
   */
  _removedRoutineRunner?: unknown,
  _removedRoutineStore?: unknown,
  /**
   * Where each person is in first-run onboarding.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves /api/me reporting no onboarding to track, which is the correct degraded
   * behaviour: a deployment that cannot read the status must not lock everybody behind a gate
   * nothing can finish.
   */
  onboardingStore?: OnboardingStore,
  /**
   * One person's standing instructions, which every built-in coworker they run is told.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes answering 503 rather than "you have written none". The difference
   * matters on exactly this screen: a person who cannot be told what they saved would otherwise be
   * shown an empty box, and the obvious thing to do with an empty box is fill it in again.
   */
  userInstructions?: UserInstructionsStore,
  /**
   * The database behind a channel's staged and sent files: upload, fetch, delete.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Absent leaves the routes unmounted rather than mounted and refusing every call, the same
   * degraded shape every other optional store here takes: a deployment that never built the
   * database has no door for this at all, not a locked one.
   */
  attachmentDatabase?: Database,
  /** Removed in slimming P6-4 (native host folder broker of the upstream desktop app); positional slot kept. */
  _removedHostAccessBroker?: unknown,
  /** Fresh desktop-only bearer token for the native host worker poll/result channel. */
  desktopHostToken?: string,
  /** Server-owned tools that are not MCP but use the same signed agent callback route. */
  deploymentToolCaller?: DeploymentToolCaller,
  /**
   * The broker behind apps a person connects through Composio rather than an administrator
   * registering an MCP server.
   *
   * Appended last, like everything above it: these are positional, so inserting one anywhere else
   * silently shifts every existing call site's arguments by one.
   *
   * Passed in already built, like the copilot handler and the intent router, so this module never
   * imports the vendor's package. Absent leaves the plugin surface reporting that no broker is
   * configured, which is the correct degraded behaviour: a deployment with no Composio API key has
   * no app directory to offer, rather than one that lists apps nobody can connect.
   */
  composio?: { broker: ComposioBroker },
  /** Native model OAuth stays server-side; callers hold only a separate local bearer. */
  modelProviderProxy?: ModelProviderProxy,
  userPreferences?: UserPreferencesStore,
  /** Was voice sessions (removed in CB-046 step 2). Kept as a slot so positional callers do not shift. */
  _removedVoiceSessions?: undefined,
  /** Was Automatic Learning (removed in slimming P4b-3). Kept as a slot so positional callers do not shift. */
  _removedLearning?: undefined,
  coworker?: {
    approvals?: ApprovalService;
    /** The private sign-in form and the Passwords vault. See passwords/service.ts. */
    passwords?: SignInService;
    responsibilities?: {
      store: ResponsibilityStore;
      engine: ResponsibilityEngine;
      bindings: ResponsibilityBindingStore;
      /** Event triggers: owner management, public signed ingress and optional SES/SNS email. */
      triggers?: {
        store: TriggerStore;
        emailDomain: string | null;
        ingressRoutes: Hono;
        emailRoutes: Hono | null;
      };
    };
    /** Pause, reset, Activity and attention for a person's own Bots. See agents/lifecycle.ts. */
    lifecycle?: BotLifecycleServices;
  },
  /**
   * Whether to offer help self-hosting, which also hides it from a deployment that pays for
   * Intelligence. Absent falls back to the operator's switch alone, so a test or a build without the
   * resolver still answers from `config.selfHostBanner` rather than asking the network.
   */
  selfHostBanner?: SelfHostBanner,
  localBackend?: LocalConversationBackend,
  modelSettings?: ModelSettingsService,
  agentModels?: AgentModelService,
  modelCatalog?: ModelCatalogService,
  panels?: PanelServices,
  magpie?: MagpieService,
  options: {
    modelCatalogRefreshMinutes?: number;
    /**
     * Extra API surfaces built outside this file (PC 设备 /api/devices, docs/pc-node.md), handed the
     * same `requireUser` every route here uses and mounted before the static catch-all.
     */
    extraRoutes?: (deps: {
      requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
    }) => Array<[path: string, routes: Hono<any>]>;
    /**
     * 多账号（CB-040）：单用户部署前面有登录网关时，用网关签名的身份认人（auth/gateway-identity.ts）。
     * 没给 = 以前的单管理员。
     */
    singleUserGuard?: MiddlewareHandler<{ Variables: AppVariables }>;
  } = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (_context, next) => withModelConnectionScope(next));
  /*
   * 慢请求日志：只记耗时超过 1 秒的 API 请求（一行 JSON：method/path/耗时），正常请求零开销。
   * 线上有人反馈「某个页面慢」时，用它定位是哪个接口慢。path 不带 query，不记请求体和请求头。
   */
  app.use("/api/*", async (context, next) => {
    const start = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - start);
    if (durationMs > 1000) {
      console.info(
        JSON.stringify({
          type: "slow-request",
          method: context.req.method,
          path: context.req.path,
          durationMs,
        }),
      );
    }
  });
  /*
   * API 响应 gzip 压缩：远程访问（Tailscale 等）省带宽、首屏更快。
   * /api/copilotkit/* 是 SSE 流式接口（markEventStreamUnbuffered 已声明别压缩），必须排除——
   * gzip 会攒够一块才发，流式回复就一段一段地蹦了。
   */
  const compressApi = compress();
  app.use("/api/*", async (context, next) => {
    if (context.req.path.startsWith("/api/copilotkit/")) return next();
    return compressApi(context, next);
  });
  mountDesktopConnectionFailure(app, desktopHostToken);
  mountProviderOAuthProxy(app, modelProviderProxy);

  app.get("/health", (context) => context.json({ status: "ok" }));
  /*
   * 正在运行的这一版（docs/online-update.md）。网页每隔几分钟和切回前台时问一次，和自己打包进去的
   * 构建号不同就提示「有新版本，点此刷新」。只有版本、提交、构建号、构建时间，没有秘密；公网网关
   * 照常先认证会话。
   */
  app.get("/api/version", (context) => {
    context.header("Cache-Control", "no-store");
    // gatewayIdentity：登录网关据此确认应用认得签名身份（CB-040）；旧版本没有这个字段，网关就不放朋友账号进来。
    return context.json({ ...versionPayload(readRunningBuild()), ...(options.singleUserGuard ? { gatewayIdentity: true } : {}) });
  });
  // Projected, never the raw runtime. config.runtime carries the Intelligence contract, including
  // INTELLIGENCE_API_KEY and the licence token, and this endpoint is reachable by anyone. Returning
  // the object wholesale would serve deployment secrets to the browser. Add fields here explicitly.
  app.get("/api/capabilities", async (context) =>
    context.json({
      mode: config.runtime.mode,
      durableHistory: config.runtime.durableHistory,
      // Automatic Learning was removed in slimming P4b-3; a local runtime still says "off" for old clients.
      ...(config.runtime.mode === "local" ? { learning: false } : {}),
      /*
       * Whether a Bot may answer with an interface it wrote itself.
       *
       * Projected because the browser holds half of this capability. The runtime middleware turns a
       * generated interface into the events that paint it, and the SDK's provider registers the tool
       * that produces one; a deployment that switched the runtime half off while the browser went on
       * offering the tool would have Bots writing interfaces nothing ever draws. One flag, read by
       * both halves, so off means off.
       */
      generativeUi: config.generativeUi,
      // 设置 → 管理 →「账号」入口（CB-040）；默认隐藏，CHISABOT_ACCOUNTS_UI=1 打开。
      accountsUi: config.accountsUi === true,
      // 功能精简（DESIGN.md §74）：默认隐藏的功能里，这台部署用 CHISABOT_EXTRAS 重新打开的。
      extras: [...(config.extras ?? [])],
      // Whether to offer help self-hosting OpenBot. A fork running it for its own people turns it off,
      // and a deployment that pays for Intelligence never sees it. See self-host-banner.ts.
      selfHostBanner: selfHostBanner
        ? await selfHostBanner.shown()
        : config.selfHostBanner,
      transcription: Boolean(config.transcription),
      /*
       * Which identity providers this deployment can sign somebody in with.
       *
       * Ids only, never the credentials: `configuredAuthProviders` returns names, and the clients
       * and secrets behind them stay in `config.auth`, which is not projected here.
       *
       * Answered at runtime rather than baked into the build, because the container image is built
       * once and knows nothing about the deployment that will run it. A sign-in screen compiled on a
       * build machine cannot offer a provider that machine had never heard of.
       */
      authProviders: configuredAuthProviders(config.auth),
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", async (context) => {
    if (!auth) {
      return context.json(
        { error: "No identity provider is configured." },
        503,
      );
    }

    // Better Auth's own routes (social sign-in, sessions). The desktop handoff (electron plugin,
    // /api/auth/desktop) was removed in slimming P6-4. The enterprise SSO and
    // SCIM plugins and their admin-only / audited branches were removed in slimming P6-2.
    return auth.handler(context.req.raw);
  });

  const authenticationUnavailable: MiddlewareHandler<{
    Variables: AppVariables;
  }> = async (context) =>
    context.json({ error: "No identity provider is configured." }, 503);
  // One administrator, when nothing is configured to sign anybody in. Checked first, and only ever
  // true when there is no provider, so a configured deployment cannot fall back to it.
  const requireUser = config.singleUser
    ? (options.singleUserGuard ?? createDevRequireUser())
    : auth && roleRepository
      ? createRequireUser(auth, roleRepository)
      : authenticationUnavailable;
  // The upstream enterprise gate (capability switches, model allowlist) and /api/admin/enterprise were
  // removed in slimming P6-1: every route checks its own actor / owner / admin role.

  app.route(
    "/api/audio",
    createDictationRoutes(
      requireUser,
      config.transcription
        ? createTranscriptionProvider(config.transcription)
        : undefined,
    ),
  );

  app.get("/api/me", requireUser, async (context) => {
    const actor = context.var.actor;
    // 名称和头像以 users 行为准（个人资料可编辑；单用户部署的身份对象是固定的）。
    let profile: { name: string | null; image: string | null } | null = null;
    try {
      profile = (await onboardingStore?.profile?.(actor.id)) ?? null;
    } catch {
      profile = null;
    }
    const name = profile?.name ?? actor.name ?? null;
    const image = profile?.image ?? actor.image ?? null;
    return context.json({
      user: {
        ...actor,
        name,
        image,
        profileNeedsSetup: profileNeedsSetup({ name, image }, actor.email),
        /*
         * Read here rather than in the guard, so only this route pays the extra query. Null means
         * this deployment does not track onboarding, which the app reads as nothing to finish;
         * a not-yet-completed status is what sends it to /onboarding.
         */
        onboarding: onboardingStore
          ? await onboardingStore.status(context.var.actor.id)
          : null,
      },
    });
  });
  app.patch("/api/me/profile", requireUser, async (context) => {
    if (!onboardingStore) return context.json({ error: "个人资料不可用。" }, 503);
    const parsed = parseProfileInput(await context.req.json().catch(() => undefined));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const current = await onboardingStore.profile(context.var.actor.id);
    const next = {
      name: parsed.value.name ?? current.name,
      image: parsed.value.image === undefined ? current.image : parsed.value.image,
    };
    await onboardingStore.setProfile(context.var.actor.id, next);
    return context.json({ profile: next });
  });
  app.post("/api/me/onboarding", requireUser, async (context) => {
    if (!onboardingStore) {
      return context.json({ error: "Onboarding is not available." }, 503);
    }

    const body = (await context.req.json().catch(() => undefined)) as
      | { step?: unknown; completed?: unknown }
      | undefined;

    if (body?.completed === true) {
      await onboardingStore.complete(context.var.actor.id);
    } else if (
      typeof body?.step === "number" &&
      Number.isInteger(body.step) &&
      body.step >= 0 &&
      // The column's range — the only bound the server knows, since the wizard's length is the
      // app's fact rather than the deployment's.
      body.step <= 2_147_483_647
    ) {
      await onboardingStore.setStep(context.var.actor.id, body.step);
    } else {
      return context.json(
        { error: "Send the step to move to, or completed: true." },
        400,
      );
    }

    return context.json({
      onboarding: await onboardingStore.status(context.var.actor.id),
    });
  });
  /*
   * A person's own standing instructions, read and written by the person they belong to.
   *
   * `requireUser` and never `requireAdmin`, and scoped to `context.var.actor.id` rather than to
   * anything in the path or the body. There is deliberately no route here for reading somebody
   * else's or writing on their behalf: these instructions go into a prompt that then speaks as that
   * person's coworker, so a way to set them for another account would be a way to put words in
   * somebody's mouth in every channel they work in. An administrator has no business here either,
   * for the same reason.
   */
  app.route(
    "/api/settings/preferences",
    userPreferencesRoutes(requireUser, userPreferences),
  );

  app.get("/api/settings/instructions", requireUser, async (context) => {
    if (!userInstructions) {
      return context.json(
        { error: "Standing instructions are not available." },
        503,
      );
    }

    return context.json({
      // "" is what having written none looks like to a text box, and the store's null is what it
      // looks like to a database. The translation happens once, here.
      instructions: (await userInstructions.read(context.var.actor.id)) ?? "",
    });
  });
  app.put("/api/settings/instructions", requireUser, async (context) => {
    if (!userInstructions) {
      return context.json(
        { error: "Standing instructions are not available." },
        503,
      );
    }

    const body = (await context.req.json().catch(() => undefined)) as
      | { instructions?: unknown }
      | undefined;

    if (typeof body?.instructions !== "string") {
      return context.json({ error: "Send the instructions to save." }, 400);
    }

    /*
     * The cap is the store's rule, so the store is what enforces it and this catches the refusal
     * rather than checking the length again. A second copy of `> 4000` here is a second place for
     * the number to be changed in only one of them.
     */
    let saved: string;
    try {
      saved = await userInstructions.write(
        context.var.actor.id,
        body.instructions,
      );
    } catch (error) {
      if (error instanceof InstructionsTooLongError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }

    /*
     * The trail records that they changed and how long they now are, NEVER what they say.
     *
     * The audit table is append-only and read by administrators, and this is a person's own note
     * about how they want to be spoken to. Recording the text would put it somewhere they cannot
     * edit it and somebody else can read it, which is not what a preferences screen promises. The
     * length is enough to answer the question a trail is for: when did this change, and to what
     * extent.
     */
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "user_instructions",
        targetId: context.var.actor.id,
        actorUserId: context.var.actor.id,
        payload: {
          change: saved === "" ? "instructions_cleared" : "instructions_saved",
          characters: saved.length,
          limit: INSTRUCTIONS_LIMIT,
        },
      });
    }

    return context.json({ instructions: saved });
  });
  // `/api/admin/learning` (Automatic Learning) was removed in slimming P4b-3.
  app.get("/api/admin/status", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ status: "ok" });
  });
  app.get("/api/admin/audit-events", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!auditReader) {
      return context.json({ error: "Audit logging is not configured." }, 503);
    }

    try {
      return context.json(
        await auditReader.list(auditQueryFromUrl(new URL(context.req.url))),
      );
    } catch (error) {
      if (error instanceof AuditQueryError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });
  // `/api/admin/people` (list / role / revoke + offboard) was removed in slimming P6-1: friend
  // accounts are managed in the login gateway (设置 → 管理 → 账号, docs/accounts.md), whose signed
  // identity carries the role.

  // `/api/admin/identity-providers` (list / remove SSO providers) was removed in slimming P4b-3; the
  // admin page went in P4a. Better Auth's own SSO plugin routes under /api/auth stay (auth is shared).

  app.get("/api/models", requireUser, async (context) => {
    context.header("Cache-Control", "no-store");
    if (!modelCatalog)
      return context.json({ error: "模型列表暂时不可用。" }, 503);
    try {
      const refresh = context.req.query("refresh") === "1";
      const catalog = await modelCatalog.list({ refresh });
      // Per-provider readiness for the picker's health dots. Best effort: a slow or locked Magpie
      // admin API never holds up or fails the model list itself.
      if (magpie?.managementAvailable && catalog.source === "magpie") {
        const status = await magpie.status({ refresh }).catch(() => null);
        if (status?.reachable)
          catalog.providers = status.providers.map(({ id, name, ready, enabled }) => ({
            id,
            name,
            ready,
            enabled,
          }));
      }
      return context.json(catalog);
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof ModelCatalogError
              ? error.message
              : "模型列表暂时无法获取，请稍后重试。",
        },
        503,
      );
    }
  });

  /*
   * 管理后台 → 模型平台 Magpie: gateway status, ChisaBot's connection to it and the model sync.
   * Administrators only; a safe projection (see MagpieOverview), never keys or upstream prose.
   */
  app.get("/api/admin/magpie", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    context.header("Cache-Control", "no-store");
    const refresh = context.req.query("refresh") === "1";
    const status = magpie
      ? await magpie.status({ refresh })
      : {
          configured: false,
          managementAvailable: false,
          reachable: false,
          providers: [],
          checkedAt: Date.now(),
          error: "未配置 Magpie。",
        };
    let connection: MagpieOverview["connection"] = null;
    try {
      const current = modelSettings ? await modelSettings.get() : null;
      if (current) {
        let host = "";
        try {
          host = new URL(current.baseUrl).host;
        } catch {
          host = "";
        }
        const sync = modelCatalog?.sync();
        connection = {
          viaMagpie:
            /^(magpie|127\.0\.0\.1:3425|localhost:3425)(:\d+)?$/u.test(host) ||
            sync?.source === "magpie",
          protocol: current.provider,
          baseUrl: current.baseUrl,
          defaultModel: current.model,
          source: current.source,
        };
      }
    } catch {
      connection = null;
    }
    const overview: MagpieOverview = {
      configured: status.configured,
      managementAvailable: status.managementAvailable,
      managementPath: `${MAGPIE_MOUNT}/`,
      reachable: status.reachable,
      ...(status.version ? { version: status.version } : {}),
      ...(status.gatewayOn !== undefined ? { gatewayOn: status.gatewayOn } : {}),
      checkedAt: status.checkedAt,
      ...(status.error ? { error: status.error } : {}),
      providers: status.providers,
      connection,
      catalog: {
        ...(modelCatalog?.sync() ?? {}),
        autoRefreshMinutes: options.modelCatalogRefreshMinutes ?? 0,
      },
    };
    return context.json(overview);
  });

  /*
   * The Magpie console itself, same-origin, behind ChisaBot's own sign-in and administrators only.
   * The public gateway already authenticates every request to this origin; this adds the role check
   * and injects Magpie's web key server-side (see magpie.ts). Embedded in 管理后台 by an iframe.
   */
  app.all(MAGPIE_MOUNT, requireUser, (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.redirect(`${MAGPIE_MOUNT}/`, 302);
  });
  app.all(`${MAGPIE_MOUNT}/*`, requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!magpie?.managementAvailable)
      return context.text("Magpie 管理未在此部署配置。", 503);
    return magpie.proxy(
      context.req.raw,
      context.req.path.slice(MAGPIE_MOUNT.length) || "/",
    );
  });

  app.put(
    "/api/agents/:agentId/model",
    requireUser,
    bodyLimit({
      maxSize: 2048,
      onError: (context) => context.json({ error: "模型设置请求过大。" }, 413),
    }),
    async (context) => {
      context.header("Cache-Control", "no-store");
      if (!agentModels)
        return context.json({ error: "BOT 模型设置暂时不可用。" }, 503);
      const body: unknown = await context.req.json().catch(() => null);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("model" in body) ||
        (body.model !== null &&
          (typeof body.model !== "string" ||
            !body.model ||
            body.model.length > 200 ||
            /[\s\x00-\x1f\x7f]/u.test(body.model)))
      )
        return context.json({ error: "请选择有效的模型。" }, 400);
      try {
        return context.json(
          await agentModels.set(
            context.var.actor,
            context.req.param("agentId"),
            body.model as string | null,
          ),
        );
      } catch (error) {
        if (error instanceof ModelSelectionError)
          return context.json({ error: error.message }, error.status);
        if (error instanceof ModelCatalogError)
          return context.json({ error: error.message }, 503);
        return context.json(
          { error: "BOT 模型暂时无法保存，请稍后重试。" },
          503,
        );
      }
    },
  );

  app.get("/api/agents/:agentId/model", requireUser, async (context) => {
    context.header("Cache-Control", "no-store");
    if (!agentModels)
      return context.json({ error: "BOT 模型设置暂时不可用。" }, 503);
    try {
      return context.json(
        await agentModels.get(context.var.actor, context.req.param("agentId")),
      );
    } catch (error) {
      if (error instanceof ModelSelectionError)
        return context.json({ error: error.message }, error.status);
      return context.json({ error: "BOT 模型暂时无法读取，请稍后重试。" }, 503);
    }
  });

  for (const [method, path, action] of [
    ["GET", "/api/admin/model-settings", "get"],
    ["PUT", "/api/admin/model-settings", "save"],
    ["POST", "/api/admin/model-settings/test", "test"],
  ] as const) {
    app.on(method, path, requireUser, async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      context.header("Cache-Control", "no-store");
      if (!modelSettings)
        return context.json({ error: "模型设置暂时不可用。" }, 503);
      try {
        if (action === "get")
          return context.json({ config: await modelSettings.get() });
        const body = await context.req.json().catch(() => null);
        if (action === "test")
          return context.json(await modelSettings.test(body));
        return context.json({
          config: await modelSettings.save(body, context.var.actor.id),
        });
      } catch (error) {
        if (error instanceof ModelSettingsValidationError)
          return context.json({ error: error.message }, 400);
        // Storage/provider errors may include secrets. Only a static failure reaches the browser.
        return context.json(
          { error: "模型配置暂时无法读取或保存，请稍后重试。" },
          503,
        );
      }
    });
  }

  app.get("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    return context.json({ credentials: await credentialService.list() });
  });
  app.post("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    const body = await context.req.json().catch(() => null);
    const input = credentialInput(body, context.var.actor.id);
    if (!input) {
      return context.json({ error: "Credential input is invalid." }, 400);
    }

    return context.json(
      { credential: await credentialService.create(input) },
      201,
    );
  });
  app.post(
    "/api/admin/credentials/:credentialId/rotate",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      const body = await context.req.json().catch(() => null);
      const input = credentialInput(body, context.var.actor.id);
      if (!input) {
        return context.json({ error: "Credential input is invalid." }, 400);
      }

      try {
        return context.json({
          credential: await credentialService.rotate({
            ...input,
            previousCredentialId: context.req.param("credentialId"),
          }),
        });
      } catch (error) {
        if (error instanceof CredentialRefusedError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    },
  );
  app.post(
    "/api/admin/credentials/:credentialId/revoke",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      try {
        return context.json({
          credential: await credentialService.revoke(
            context.req.param("credentialId"),
            context.var.actor.id,
          ),
        });
      } catch (error) {
        // Not found or already revoked: the second click on Revoke, answered as what it is.
        if (error instanceof CredentialRefusedError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    },
  );
  app.get("/api/admin/package", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!packageStatusReader) {
      return context.json({ error: "Tenant package is not configured." }, 503);
    }
    return context.json({ package: await packageStatusReader.active() });
  });
  // The CopilotKit runtime, behind the same session guard as every other API route. Mounted last so
  // its own routing under /api/copilotkit cannot shadow an OpenBot route declared above.
  if (copilotHandler) {
    // 流式回复（SSE）对任何反向代理都声明「别缓冲、别压缩」：nginx 认 X-Accel-Buffering，
    // no-transform 让 CDN / 代理不去 gzip 它（gzip 会攒够一块才发，回复就一段一段地蹦）。
    // 自带网关已经关了缓冲；这两个头是给别人自己部署时前面再套一层代理用的（docs/streaming.md）。
    app.use("/api/copilotkit/*", markEventStreamUnbuffered);
    if (config.runtime.mode === "local") {
      if (!localBackend)
        throw new Error("The local conversation backend is required.");
      // SSE mode has no SDK identity callback. Every local history and execution request therefore
      // enters through OpenBot's existing session guard before the public SDK handler.
      app.use("/api/copilotkit/*", requireUser, async (context, next) => {
        const actor = context.var.actor;
        const request = context.req.raw;
        const localResponse = await localBackend.handle(request, actor.id);
        if (localResponse) return localResponse;
        const action = runtimeRun(context.req.path);
        // The SDK routes by its final nonempty segments, including nested paths and repeated or
        // trailing slashes. The owner check must recognize every spelling that reaches stop.
        const segments = context.req.path.split("/").filter(Boolean);
        const count = segments.length;
        const stop =
          count >= 4 &&
          segments[count - 4] === "agent" &&
          segments[count - 2] === "stop"
            ? { agentId: segments[count - 3]!, threadId: segments[count - 1]! }
            : undefined;
        if (action || stop) {
          try {
            const agentId =
              action?.agentId ?? decodeURIComponent(stop!.agentId);
            if (
              agentProfileStore &&
              !(await agentProfileStore.get(actor, agentId))
            ) {
              return context.json({ error: "That Bot is not available." }, 404);
            }
            const body = await request
              .clone()
              .json()
              .catch(() => null);
            const threadId = stop
              ? decodeURIComponent(stop.threadId)
              : body?.threadId;
            if (
              typeof threadId !== "string" ||
              !threadId.trim() ||
              threadId.length > 256
            ) {
              return context.json(
                { error: "A valid threadId is required." },
                400,
              );
            }
            if (action?.action === "run" || action?.action === "connect") {
              await localBackend.client.getOrCreateThread({
                threadId,
                userId: actor.id,
                agentId,
              });
            } else {
              const thread = await localBackend.client.getThread({
                threadId,
                userId: actor.id,
              });
              if (thread.agentId !== agentId) {
                return context.json({ error: "Thread access denied." }, 404);
              }
            }
          } catch (error) {
            const status =
              error instanceof Error && "status" in error
                ? error.status
                : undefined;
            if (status !== 403 && status !== 404 && status !== 409) {
              return context.json(
                { error: "Local conversation storage is unavailable." },
                503,
              );
            }
            return context.json(
              { error: "Thread access denied." },
              status === 409 ? 409 : 404,
            );
          }
        }
        await next();
        if (context.req.path.endsWith("/info") && context.res.ok) {
          // The SDK can discover only synchronous local runners. Our Postgres history endpoints
          // are asynchronous and mounted above it, so advertise their actual read capabilities.
          const info = await context.res.json();
          context.res = Response.json(
            {
              ...info,
              threadEndpoints: {
                list: true,
                inspect: true,
                mutations: false,
                realtimeMetadata: false,
              },
              telemetryDisabled: true,
            },
            { status: context.res.status, headers: context.res.headers },
          );
        }
      });
    }
    // Mounted at the ROOT with the handler carrying its own basePath. Mounting it at
    // "/api/copilotkit" as well double-prefixes it: Hono strips the prefix before the handler sees
    // the path, so every route lands at /api/copilotkit/api/copilotkit/* and /info 404s. The browser
    // reports that as "Runtime info request failed with status 404" and every run fails before it
    // starts, with nothing at all in the server log.
    app.route("/", copilotHandler);
  }

  /**
   * May this person act as this Bot?
   *
   * The store's own read path already applies `canAccessAgent`, so asking it for the Bot is the same
   * question the roster and the runtime ask, rather than a second copy of the rule.
   *
   * A deployment with no profile store has no agents table and therefore no private Bot to protect:
   * its Bots come from the tenant package and are public to everybody who can sign in. Answering yes
   * there keeps that deployment working without weakening one that has owners.
   */
  const canUseBot: BotAccessCheck = agentProfileStore
    ? async (actor, botId) =>
        (await agentProfileStore.get(actor, botId)) !== null
    : async () => true;

  // The Bot computer. Acting on a page needs the gateway and the policy it enforces, so both arrive
  // together or the routes are not mounted. An ungoverned computer is not a reduced feature. It is
  // the one shape of this feature that must not exist.
  if (computerGateway && computerPolicy) {
    app.route(
      "/api/computers",
      createComputerRoutes(
        computerGateway,
        computerPolicy,
        requireUser,
        // Not `canUseBot`: a Team Bot's teammates use the Bot, not its owner's signed-in computer.
        agentProfileStore ? computerAccessCheck(agentProfileStore) : canUseBot,
        pageFrames,
        auditReader,
        agentProfileStore
          ? async (actor, botId) => {
              const profile = await agentProfileStore.get(actor, botId);
              if (profile) return { name: profile.name };
              // 看不到不等于删了：没有资料行的机器人、别人的私有机器人都算「还在」，不能被当成孤儿删掉。
              const record = await agentProfileStore.record?.(botId);
              return record && !record.deleted ? { name: record.name } : null;
            }
          : undefined,
      ),
    );
  }



  if (agentProfileStore) {
    app.route(
      "/api/agents",
      createAgentRoutes(
        agentProfileStore,
        requireUser,
        // The same stance the computer uses: a laptop legitimately talks to its own services, a hosted
        // deployment must not. Passed from configuration rather than defaulted here, so "hosted and
        // permissive" cannot happen by forgetting something.
        config.computer?.allowPrivateHosts ?? false,
        // A Bot's own refusal goes in the same trail as everything else it does.
        auditStore,
        // Addresses this deployment named, which is how a hosted one reaches an agent on its own
        // network without dropping the floor for everything else.
        config.agentEndpointAllowedHosts,
        /*
         * What the Bot's own screen needs to show, and change, which Bots it may hand work to.
         *
         * Read per request rather than captured, for the reason the desk reads it per hop: a grant
         * made a minute ago counts and one revoked a minute ago stops counting. Absent with no
         * plugin store, which is a deployment where no Bot may address any other.
         */
        pluginStore
          ? {
              enabled:
                config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0,
              reachableFrom: (agentId) =>
                pluginStore.botsReachableFrom(agentId),
              // The same answer the write path checks, read up front so the screen can say it once.
              canHandOn: (agentId) => pluginStore.agentCanHandOn(agentId),
            }
          : undefined,
        // Whether "built-in" is a kind of coworker this deployment can actually make: the create
        // path falls back to the managed Bot's endpoint, so without one it can only refuse.
        config.managedAgent?.endpoint !== undefined,
        // The managed Bot's address, so a coworker created without an endpoint — which creation
        // stores as running at this address — can be told apart from one a person hosts.
        config.managedAgent?.endpoint?.toString(),
        // Deleting a Bot removes its private data and, when nothing shared still needs it, the Bot.
        coworker?.lifecycle?.purge,
      ),
    );
  }

  if (panels) app.route("/api/panels", panels.routes(requireUser));
  if (channelStore) {
    app.route(
      "/api/channels",
      createChannelRoutes(channelStore, requireUser, channelEvents, auditStore, attachmentDatabase),
    );
  }

  if (attachmentDatabase) {
    /*
     * `bodyLimit` sits in front of the upload route itself, not beside the mount below: the handler
     * in channels/attachments.ts calls `file.arrayBuffer()` before it has looked at a single byte of
     * size, so an unbounded body is read into memory in full before anything gets the chance to
     * refuse it. A person (or an attacker) posting a 2GB body would have it buffered in RAM before
     * the 413 the handler already knows how to return. `MAX_IMAGE_BYTES` is the largest thing this
     * route could ever legitimately accept — a text upload is refused smaller, inside the handler,
     * once the sniffed type is known — so refusing anything larger at the door costs nothing a real
     * upload was ever going to use.
     *
     * The ceiling is `UPLOAD_BODY_LIMIT_BYTES` and not `MAX_IMAGE_BYTES` itself because THIS GATE
     * MEASURES A DIFFERENT THING FROM EVERY OTHER ONE. See that constant.
     */
    const channelAttachments = new Hono<{ Variables: AppVariables }>();
    channelAttachments.use(
      "*",
      bodyLimit({
        maxSize: UPLOAD_BODY_LIMIT_BYTES,
        /*
         * THE REFUSAL AT THE DOOR HAS TO LOOK LIKE THE HANDLER'S OWN.
         *
         * hono's default `onError` answers with the plain string "Payload Too Large". The composer
         * (app/src/components/channels/composer/attachments.ts) reads `{ error }` off every failed
         * upload and falls back to a generic `Could not upload "<name>"` when the body will not
         * parse as JSON — so the default body cost the person the one sentence that would have told
         * them what went wrong, on the single refusal where the reason is both knowable and
         * actionable. This is the same `{ error }` shape and the same number the handler's own 413
         * names, so the two paths are indistinguishable from the outside.
         *
         * THE FILENAME AND THE KIND ARE BOTH DELIBERATELY ABSENT, and for the same reason: nothing
         * has parsed the multipart body at this point, which is the entire reason this middleware
         * runs ahead of the handler. The handler's sentences can say `'notes.txt' is larger than the
         * 1MB limit for files` because by then it has sniffed the bytes. This one cannot, and must
         * not guess — a 9MB text file refused here as being over "the 8MB limit for images" would
         * send somebody off to shrink it to 7MB, whereupon the handler would refuse it a second time
         * with a different number. So the sentence names the only thing that is true of every body
         * this gate rejects: none of them can be under the largest ceiling the route has.
         */
        onError: (context) =>
          context.json(
            {
              // The same rounding as `megabytes` in channels/attachments.ts, so the door and the
              // handler name one limit in one voice.
              error: `That upload is larger than the ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB limit.`,
            },
            413,
          ),
      }),
    );
    channelAttachments.route(
      "/",
      createChannelAttachmentRoutes(attachmentDatabase, requireUser),
    );
    app.route("/api/channels", channelAttachments);

    app.route(
      "/api/attachments",
      createAttachmentRoutes(attachmentDatabase, requireUser),
    );
  }

  if (coworker?.lifecycle)
    app.route(
      "/api/bots",
      createBotLifecycleRoutes(coworker.lifecycle, requireUser),
    );
  if (coworker?.approvals)
    app.route(
      "/api/approvals",
      createApprovalRoutes(coworker.approvals, requireUser),
    );
  if (coworker?.passwords) {
    app.route(
      "/api/sign-in-requests",
      createSignInRoutes(
        coworker.passwords,
        requireUser,
        // A sign-in is typed into the Bot's computer, so it answers to the same rule.
        agentProfileStore ? computerAccessCheck(agentProfileStore) : canUseBot,
      ),
    );
    app.route(
      "/api/passwords",
      createPasswordRoutes(coworker.passwords, requireUser),
    );
  }
  if (coworker?.responsibilities) {
    const { store, engine, bindings } = coworker.responsibilities;
    app.route(
      "/api/responsibilities",
      createResponsibilityRoutes(
        store,
        engine,
        requireUser,
        bindings,
        coworker.responsibilities.triggers,
      ),
    );
    if (coworker.responsibilities.triggers) {
      app.route(
        "/api/events/triggers",
        coworker.responsibilities.triggers.ingressRoutes,
      );
      if (coworker.responsibilities.triggers.emailRoutes)
        app.route(
          "/api/events/email",
          coworker.responsibilities.triggers.emailRoutes,
        );
    }
    app.route(
      "/api/events/github",
      createGithubResponsibilityRoutes({
        bindingFor: bindings.githubBindingFor,
        ingest: (event) => engine.ingest(event),
      }),
    );
  }

  if (componentStore) {
    app.route(
      "/api/components",
      createComponentRoutes(
        componentStore,
        requireUser,
        auditStore,
        canUseBot,
        sandboxedStore,
      ),
    );
  }

  if (pluginStore) {
    app.route(
      "/api/plugins",
      createPluginRoutes(
        pluginStore,
        requireUser,
        canUseBot,
        {
          encryptionKey: config.keyEncryptionKey,
          /*
           * Whether the person a consent was started for still has access, asked when the callback
           * lands rather than when the flow began.
           *
           * The callback carries no session — identity comes from the state — so this is where the
           * question gets asked at all. `find` answers both halves of it: no row means a user id that
           * names nobody, and `revoked` means an administrator removed them while they were away at
           * the vendor. Either way there is no live person for a fresh refresh token to belong to.
           *
           * No people store means this deployment cannot answer the question, so it refuses rather
           * than assuming yes. It also cannot remove anybody, which is exactly why guessing here
           * would be a hole nothing else closes.
           */
          personHasAccess: async (userId) => {
            if (!peopleStore) return false;
            const person = await peopleStore.find(userId);
            return person !== undefined && !person.revoked;
          },
          // The deployment-wide fallback a Bot may present, as a yes or no. The secret itself stays
          // in config and is checked in `/api/agent-tools/call`; the surface only needs to know
          // whether a Bot without its own credential has any way to call back.
          botsMayCallBack: Boolean(config.agentToolToken),
          publicUrl: config.publicUrl,
          appUrl: config.appUrl,
        },
        composio,
      ),
    );
  }

  /*
   * Where a framework Bot runs a tool.
   *
   * A Bot that runs its own loop, in its own process, is the honest shape: the run does not need a
   * browser and does not stop when one closes. What it must not have is a route to a vendor that
   * goes around this deployment, so it calls here and this calls the plugin store, which asks the
   * same two questions it asks of everything else and writes the same audit row.
   *
   * Authenticated by a shared secret rather than a session, because the caller is a service and has
   * no person behind it. Absent secret means the route does not exist: a deployment that has not
   * configured this refuses rather than accepting anybody who can reach the port.
   */
  if (pluginStore || deploymentToolCaller) {
    const legacyToken = config.agentToolToken ?? "";
    app.post("/api/agent-tools/call", async (context) => {
      /*
       * Who is calling, and on whose behalf. Two questions, two credentials.
       *
       * The header says which agent: its own token, issued to it, stored here only as a hash. The
       * body's `run` says which Bot and which person, signed by this deployment for this run.
       *
       * Both are required, and they are checked against each other. This used to be one
       * deployment-wide token with the Bot and the actor read straight out of the body, which meant
       * anything holding that token could spend any Bot's grants and write any name into the audit
       * trail. A forgeable trail is worse than no trail, because it is believed.
       */
      const body = (await context.req.json().catch(() => null)) as {
        name?: string;
        args?: Record<string, unknown>;
        run?: unknown;
      } | null;

      const verdict = await authoriseAgentCall({
        presented: context.req.header("x-openbot-agent-token") ?? "",
        run: body?.run,
        encryptionKey: config.keyEncryptionKey,
        legacyToken,
        lookup: async (hash) =>
          (await agentProfileStore?.agentForCallbackToken(hash)) ?? null,
      });
      if (!verdict.ok) {
        /*
         * Recorded, because this is a boundary being held and every other one here leaves a row.
         *
         * The three outcomes inside `callTool` are all written after the caller has proved which Bot
         * it is. A caller that fails to prove it never reaches them, so this refusal used to leave
         * nothing at all — and it is the refusal behind the product's most confusing failure: a Bot
         * whose token no longer matches the deployment's has every call rejected here, returns
         * nothing to its own model, and the model tells the person there were no results. A false
         * negative delivered as an answer, with the trail agreeing nothing had happened.
         *
         * No Bot id and no actor. Both live in the credential that just failed to verify, so writing
         * them down would put an unproven claim in the record. The tool name comes from the body and
         * is capped for the same reason: it is untrusted input, kept because "which tool was being
         * reached for" is the useful half of the question.
         */
        if (auditStore) {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.callback_refused",
            targetType: "mcp_tool",
            initiator: DEPLOYMENT_INITIATOR,
            targetId:
              typeof body?.name === "string"
                ? body.name.slice(0, 120)
                : "unknown",
            payload: {
              refusal: verdict.reason,
              status: verdict.status,
              note: "A caller could not prove which Bot it was, so no grant was consulted.",
            },
          });
        }
        return context.json({ error: verdict.reason }, verdict.status);
      }

      const parsedCall = parseAgentToolCallInput(body);
      if (!parsedCall.ok) {
        return context.json({ error: parsedCall.error }, 400);
      }

      try {
        const deploymentResult = await deploymentToolCaller?.({
          name: parsedCall.value.ref,
          args: parsedCall.value.args,
          botId: verdict.botId,
          actorId: verdict.actorId,
          initiator: verdict.initiator,
          run: verdict.run,
        });
        if (deploymentResult) return context.json(deploymentResult);

        if (!pluginStore) {
          return context.json({
            text: `${REFUSAL_MARKER} That tool is not registered in this deployment.`,
            isError: true,
          });
        }

        const result = await pluginStore.callTool({
          ref: parsedCall.value.ref,
          args: parsedCall.value.args,
          botId: verdict.botId,
          // From the assertion, never the body: this is the name the audit row will carry.
          actorId: verdict.actorId,
          ...(verdict.initiator ? { initiator: verdict.initiator } : {}),
        });
        // Worded by the helper the in-process door uses, so a framework Bot's model reads a vendor's
        // error as the vendor's and not as a result. Neither Bot words it on its way through.
        return context.json({
          text: vendorAnswer(result),
          isError: result.isError,
        });
      } catch (error) {
        /*
         * A refusal is an answer, not a failure: the Bot says what was blocked and carries on. The
         * marker leads it so a transcript can draw a refusal without reading the wording.
         *
         * AND THE SAME QUESTION THE IN-PROCESS DOOR ASKS, which this one asked of nothing at all.
         *
         * CRITERION. Nothing on the `isDeploymentFault` shelf has its message relayed from here,
         * and nothing leaving here carries a statement or a value bound to one.
         *
         * WHAT THIS SURFACE IS. The answer goes into the calling Bot's model as the tool result, so
         * it is the widest audience an error message in this deployment reaches: a model repeats
         * what it is handed — to the person asking, into whatever it writes next, and to the next
         * tool it calls. `plugins/tools.ts` wraps the identical `callTool` for a Bot running in
         * this process and has refused that shelf for exactly this reason since the
         * `ServerRowAmbiguousError` finding; the two doors to one store disagreeing meant a query
         * failure came back as `Failed query: … params: linear, usr_…` through one of them and as a
         * fixed sentence through the other. Which door a Bot arrives at is a deployment topology
         * decision and was never a disclosure decision.
         *
         * AND THROUGH {@link withoutStatement} AS WELL, because the two answer different questions
         * and `isDeploymentFault` says so itself: it "settles who may be told, not what". The shelf
         * decides whether this audience may hear a sentence at all; the door decides what any
         * sentence is allowed to contain. Today the two overlap on a query failure and this arm can
         * only be reached by something neither recognises — which is exactly the state the last two
         * findings in this area were found in, one predicate apart from a leak.
         *
         * AND ONLY A REFUSAL CARRIES THE MARKER, which is the in-process door's third question. The
         * transcript draws an answer that starts with it as a boundary holding, and the model reads
         * "Refused." as "not allowed". `callTool` throws `PluginRefusedError` for that, and rethrows
         * a vendor that broke after recording `mcp.call_failed`; marking every throw drew a vendor
         * outage, or a fault of this deployment's own, as a policy refusing.
         */
        if (error instanceof PluginRefusedError) {
          return context.json({
            text: `${REFUSAL_MARKER} ${withoutStatement(error)}`,
            isError: true,
          });
        }
        return context.json({
          text:
            error instanceof Error && !isDeploymentFault(error)
              ? `That tool could not be called: ${withoutStatement(error)}`
              : "That tool could not be called.",
          isError: true,
        });
      }
    });
  }

  if (sandboxedStore) {
    app.route(
      "/api/sandboxed",
      createSandboxedRoutes(sandboxedStore, requireUser),
    );
  }

  if (threadIdentity) {
    app.route(
      "/api/threads",
      createThreadRoutes(
        threadIdentity,
        requireUser,
        createThreadReader(
          config.runtime.mode === "local"
            ? (() => {
                if (!localBackend)
                  throw new Error(
                    "The local conversation backend is required.",
                  );
                return localBackend.client;
              })()
            : createIntelligenceClient(config.runtime.intelligence),
        ),
      ),
    );
  }

  /*
   * The built app, served by the API that serves it.
   *
   * WHY THE SAME PROCESS. There is no CORS anywhere in this server, deliberately, so the app has to
   * reach `/api` on its own origin. Two containers behind one ingress does that too, and costs a
   * path rule on every deployment plus a way for the two to disagree about which host they are on.
   * One process cannot disagree with itself.
   *
   * MOUNTED LAST, so every `/api` route above already claimed its path. The catch-all below would
   * otherwise answer an unmatched `/api` call with the app's HTML, which is the failure that reads
   * as "the API returned HTML" and takes an hour to place.
   *
   * Absent in development: Vite serves the app and proxies `/api` here, so `APP_DIST_DIR` is unset
   * and none of this mounts.
   */
  for (const [path, routes] of options.extraRoutes?.({ requireUser }) ?? []) {
    app.route(path, routes);
  }

  if (config.appDistDir) {
    const root = config.appDistDir;
    /*
     * 缓存（docs/online-update.md）：带哈希的 /assets/* 永久缓存；index.html 每次都向服务器确认，
     * 这样部署新版本后，刷新一次就一定拿到新的入口，而不是浏览器里存着的旧 index.html。
     */
    app.use("/assets/*", async (context, next) => {
      await next();
      if (context.res.status === 200)
        context.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    });
    app.use("/*", async (context, next) => {
      await next();
      if ((context.res.headers.get("content-type") ?? "").startsWith("text/html"))
        context.res.headers.set("Cache-Control", "no-cache");
      // PWA（DESIGN.md §40）：service worker 和清单每次都向服务器确认，部署后浏览器马上拿到新的 sw.js。
      else if (context.req.path === "/sw.js" || context.req.path === "/manifest.webmanifest")
        context.res.headers.set("Cache-Control", "no-cache");
    });
    app.use("/*", serveStatic({ root }));
    /*
     * A single-page app owns its routing, so a path with no file behind it is not missing: it is a
     * route the browser resolves once index.html has loaded. Without this, every deep link and every
     * refresh away from `/` is a 404, which is the classic way this deployment shape breaks.
     *
     * Written out rather than a second `serveStatic`, whose `path` option is resolved relative to the
     * working directory and silently matches nothing when handed the absolute root used above.
     *
     * `/api` is excluded so an unmatched API route still answers as one. Returning the app's HTML to
     * a fetch that expected JSON is the failure that gets read as "the API returned HTML".
     */
    app.get("*", async (context) => {
      if (context.req.path.startsWith("/api")) return context.notFound();
      // 缺失的打包文件不是前端路由：回 404。以前回 index.html，部署后旧页面加载旧分包时把 HTML 当 JS，
      // 整页报错（2026-10-13「模型设置崩了」）；404 让前端识别成「分包过期」并自动刷新（app/src/lib/stale-chunk.ts）。
      if (context.req.path.startsWith("/assets/")) return context.notFound();
      const index = Bun.file(`${root}/index.html`);
      if (!(await index.exists())) return context.notFound();
      return new Response(index, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    });
  }

  return app;
}

function credentialInput(
  value: unknown,
  actorUserId: string,
): CredentialInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  /*
   * An allowlist, and deliberately narrower than `CredentialKind`.
   *
   * `CredentialKind` is derived from the schema enum, so it now includes `mcp_oauth_client` and
   * `mcp_user_token`. Neither belongs here. A user token is somebody's own grant and exists only as
   * the outcome of a consent they gave; a client is registered when a connector is added. Both are
   * written by the code that owns those flows, and an administrator hand-posting either would be
   * creating a credential attributed to a person who never agreed to it.
   *
   * So this list is not out of date with the enum — do not widen it to match.
   */
  if (
    (body.kind !== "model" &&
      body.kind !== "connector" &&
      body.kind !== "mcp") ||
    typeof body.provider !== "string" ||
    !body.provider.trim() ||
    typeof body.keyId !== "string" ||
    !body.keyId.trim() ||
    typeof body.plaintext !== "string" ||
    !body.plaintext ||
    !body.metadata ||
    typeof body.metadata !== "object" ||
    Array.isArray(body.metadata) ||
    Object.getPrototypeOf(body.metadata) !== Object.prototype
  ) {
    return null;
  }

  return {
    kind: body.kind,
    provider: body.provider.trim(),
    keyId: body.keyId.trim(),
    metadata: body.metadata as Record<string, unknown>,
    plaintext: body.plaintext,
    actorUserId,
  };
}

