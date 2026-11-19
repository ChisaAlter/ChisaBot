import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { type CSSProperties, useRef, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { ShapeAvatar } from "@/components/agents/shape-avatar";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Button } from "@/components/ui/button";
import {
  useDocumentEvent,
  useExternalConnection,
  useWindowEvent,
} from "@/hooks";
import {
  createStaggeredGazeScheduler,
  deriveSignAvatarMood,
  SIGN_AVATAR_MOOD_LABELS,
  type SignAvatarMood,
  type SignFormAvatarInput,
} from "@/lib/agents/avatar-expressions";
import { providerName, signInWith } from "@/lib/auth/client";
import { appConfig } from "@/lib/generated/application-config";
import {
  type AuthProviderId,
  authProvidersQueryOptions,
  currentUserQueryOptions,
} from "../lib/auth/queries";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user) {
      throw redirect({ to: "/" });
    }
    // Loaded here so the screen paints with its buttons rather than painting empty and then
    // growing them, which reads as "no providers" for exactly as long as the request takes.
    await context.queryClient.ensureQueryData(authProvidersQueryOptions());
  },
  component: SignScreen,
});

/**
 * 登录页情感联动形象舞台：
 * - 单 rAF 错峰指针凝视，窗口失焦 / 页面隐藏 / 减少动态效果时自动暂停并归零；
 * - 实时联动登录态表情机：输入密码闭眼回避 (`cover-eyes`)、提交报错摇头 (`shake-error`)、登录成功眯眼笑 (`happy-squint`)。
 */
export function SignAvatarStage({
  passwordFocused = false,
  passwordFilled = false,
  submitting = false,
  hasError = false,
  succeeded = false,
}: Omit<SignFormAvatarInput, "hasPointer">) {
  const prefersReducedMotion = useReducedMotion();
  const faceWrapRef = useRef<HTMLDivElement | null>(null);
  const [hasPointer, setHasPointer] = useState(false);
  const [gazeOffset, setGazeOffset] = useState({ x: 0, y: 0 });
  const schedulerRef = useRef<ReturnType<
    typeof createStaggeredGazeScheduler
  > | null>(null);

  const mood: SignAvatarMood = deriveSignAvatarMood({
    passwordFocused,
    passwordFilled,
    submitting,
    hasError,
    succeeded,
    hasPointer: hasPointer && !prefersReducedMotion,
  });

  const gazeLocked =
    Boolean(prefersReducedMotion) ||
    mood === "cover-eyes" ||
    mood === "shake-error" ||
    mood === "happy-squint";
  const gazeLockedRef = useRef(gazeLocked);
  gazeLockedRef.current = gazeLocked;

  useExternalConnection(!prefersReducedMotion, () => {
    const element = faceWrapRef.current;
    if (!element) return;
    const scheduler = createStaggeredGazeScheduler({
      reach: 0.085,
      minCooldownMs: 60,
      maxCooldownMs: 180,
      adapter: {
        isReducedMotion: () => Boolean(prefersReducedMotion),
      },
    });
    schedulerRef.current = scheduler;
    const unregister = scheduler.register({
      element,
      isLocked: () => gazeLockedRef.current,
      apply: (offset) => setGazeOffset(offset),
    });
    return () => {
      unregister();
      scheduler.dispose();
      schedulerRef.current = null;
      setGazeOffset({ x: 0, y: 0 });
    };
  });

  useWindowEvent("pointermove", (event) => {
    if (prefersReducedMotion) return;
    if (!hasPointer) setHasPointer(true);
    schedulerRef.current?.updatePointer({
      x: event.clientX,
      y: event.clientY,
    });
  });

  useWindowEvent("blur", () => {
    schedulerRef.current?.setPaused(true);
  });

  useWindowEvent("focus", () => {
    schedulerRef.current?.setPaused(false);
  });

  useDocumentEvent("visibilitychange", () => {
    schedulerRef.current?.setPaused(document.visibilityState === "hidden");
  });

  useDocumentEvent("pointerleave", () => {
    setHasPointer(false);
    schedulerRef.current?.updatePointer(null);
  });

  const orbState = hasError ? "error" : submitting ? "thinking" : "idle";

  return (
    <div
      aria-label={SIGN_AVATAR_MOOD_LABELS[mood]}
      className="sign-avatar-stage relative flex items-center justify-center"
      data-sign-mood={mood}
      data-testid="sign-avatar-stage"
      ref={faceWrapRef}
      role="img"
      style={
        {
          "--sign-gaze-x": `${gazeLocked ? 0 : gazeOffset.x}px`,
          "--sign-gaze-y": `${gazeLocked ? 0 : gazeOffset.y}px`,
        } as CSSProperties
      }
    >
      <AgentOrb active={submitting} size="64px" state={orbState} />
      <span aria-hidden className="sign-avatar-overlay">
        <ShapeAvatar
          color="violet"
          expression={mood}
          mood={
            mood === "happy-squint"
              ? "done"
              : mood === "submitting"
                ? "working"
                : "idle"
          }
          shape="round"
          size={40}
          working={mood === "submitting"}
        />
      </span>
    </div>
  );
}

function SignScreen() {
  // Which provider is being opened, rather than whether one is: with three buttons, a single
  // boolean would put "Opening…" on all of them.
  const [opening, setOpening] = useState<AuthProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const { data: options } = useQuery(authProvidersQueryOptions());
  const providers = options?.providers ?? [];

  async function handleSignIn(provider: AuthProviderId) {
    setError(null);
    setSucceeded(false);
    setOpening(provider);

    try {
      await signInWith(provider);
      setSucceeded(true);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `无法启动 ${providerName(provider)} 登录。`,
      );
      setOpening(null);
    }
  }

  const providerButtons = (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        /*
         * Every provider gets the same button, and it is the light-themed outline one
         * rather than the app's filled primary. Google's guidelines require their button be
         * at least as prominent as any other sign-in option and specify its fill and
         * stroke, so making one provider the loud one would break that for the others. The
         * same size and weight throughout is also the honest presentation: a deployment
         * that configured three has three, and none of them is the recommended one.
         */
        <Button
          className="h-10 w-full justify-start gap-3 px-3 tracking-tight"
          disabled={opening !== null}
          key={provider}
          onClick={() => handleSignIn(provider)}
          size="lg"
          variant="outline"
        >
          <ProviderLogo provider={provider} />
          {/* Centred against the button, not against the space left of the mark. */}
          <span className="flex-1 text-center">
            {opening === provider
              ? `正在打开 ${providerName(provider)}…`
              : `继续使用 ${providerName(provider)}`}
          </span>
          {/* Balances the mark so the label sits in the middle of the button. */}
          <span aria-hidden="true" className="size-[18px]" />
        </Button>
      ))}
    </div>
  );

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

  return (
    // Template F (DESIGN.md §12): no shell, one centred L1 glass card on the sky.
    <div className="flex h-dvh w-full flex-col items-center justify-center p-4">
      <motion.div
        animate="shown"
        className="auth-card flex w-full max-w-[420px] flex-col items-center px-8 py-10"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        <motion.div
          className="flex items-center justify-center"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          <SignAvatarStage
            hasError={Boolean(error)}
            submitting={opening !== null}
            succeeded={succeeded}
          />
        </motion.div>
        <motion.h1
          className="mt-6 text-center font-semibold text-2xl tracking-tight"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {"登录到 "}
          {appConfig.brand.productName}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {providers.length > 0 ? (
            providerButtons
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              {"此部署未配置登录提供者。"}
            </p>
          )}
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </motion.div>
      </motion.div>
    </div>
  );
}
