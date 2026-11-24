import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCrop,
  IconDeviceDesktop,
  IconMoon,
  IconPalette,
  IconPhoto,
  IconRefresh,
  IconSun,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  useRef,
  useState,
} from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  WallpaperCropDialog,
  type WallpaperCropSource,
} from "@/components/settings/wallpaper-crop-dialog";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContentEnter,
  SmoothCollapse,
} from "@/components/ui/motion-primitives";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useExternalConnection, useMediaQuery } from "@/hooks";
import {
  ARTISTIC_WALLPAPER_PRESETS,
  type ArtisticWallpaperPresetId,
  type CanvasConfig,
  compressCroppedWallpaper,
  isDefaultAppearance,
  loadUploadedWallpaperSource,
  MATERIALS,
  type MaterialId,
  removeCustomWallpaper,
  resetAppearance,
  SKY_SCENES,
  type SkySceneId,
  saveUploadedWallpaper,
  saveUploadedWallpaperSource,
  setCanvas,
  setCustomAccent,
  setMaterial,
  setSkyScene,
  setSkyWeather,
  setStaticBackground,
  setTheme,
  setWallpaperAdjustments,
  setWallpaperSource,
  THEMES,
  useAppearanceConfig,
  useCustomWallpaperUrl,
  validateWallpaperFile,
  WALLPAPER_BLUR_MAX,
  WALLPAPER_BLUR_MIN,
  WALLPAPER_CATEGORIES,
  WALLPAPER_SCRIM_MAX,
  WALLPAPER_SCRIM_MIN,
  type WallpaperCategoryId,
} from "@/lib/appearance";
import type { AppearanceMode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { dataUrlToBlob } from "@/lib/wallpaper-compress";
import {
  isFullImageCrop,
  type NormalizedCropRect,
  toPixelCropRect,
  type WallpaperAspectPresetId,
} from "@/lib/wallpaper-crop";

const MODE_OPTIONS: readonly {
  value: AppearanceMode;
  label: string;
  Icon: typeof IconSun;
}[] = [
  { value: "system", label: "跟随系统", Icon: IconDeviceDesktop },
  { value: "light", label: "浅色", Icon: IconSun },
  { value: "dark", label: "深色", Icon: IconMoon },
];
const MODE_VALUES: readonly AppearanceMode[] = ["system", "light", "dark"];

type CanvasKind = CanvasConfig["kind"];
const CANVAS_OPTIONS: readonly { value: CanvasKind; label: string }[] = [
  { value: "pure", label: "净色" },
  { value: "sky", label: "动态天空" },
  { value: "wallpaper", label: "壁纸" },
];
const CANVAS_VALUES: readonly CanvasKind[] = ["pure", "sky", "wallpaper"];

const WALLPAPER_CATEGORY_VALUES: readonly WallpaperCategoryId[] =
  WALLPAPER_CATEGORIES.map((c) => c.id);

const rangeFillStyle = (
  value: number,
  min: number,
  max: number,
): CSSProperties =>
  ({ "--pct": `${((value - min) / (max - min)) * 100}%` }) as CSSProperties;

function readImageDimensions(
  url: string,
): Promise<{ naturalWidth: number; naturalHeight: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const naturalWidth = img.naturalWidth || img.width;
      const naturalHeight = img.naturalHeight || img.height;
      if (naturalWidth > 0 && naturalHeight > 0) {
        resolve({ naturalWidth, naturalHeight });
      } else {
        reject(new Error("无法读取图片尺寸，请检查图片文件是否损坏"));
      }
    };
    img.onerror = () => {
      reject(new Error("无法解码壁纸图片，请更换其他图片"));
    };
    img.src = url;
  });
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("无法读取图片数据"));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("无法读取图片数据"));
    };
    reader.readAsDataURL(blob);
  });
}

function materialTitle(id: MaterialId, name: string): string {
  if (id === "glass") return `${name}（默认）`;
  if (id === "solid") return `${name}（零模糊）`;
  return name;
}

export function AppearancePreferences() {
  const config = useAppearanceConfig();
  const customWallpaperUrl = useCustomWallpaperUrl();
  const { mode, setMode, dark } = useTheme();
  const reducedTransparency = useMediaQuery(
    "(prefers-reduced-transparency: reduce)",
  );

  const [accentOpen, setAccentOpen] = useState(Boolean(config.customAccent));
  const [cityDraft, setCityDraft] = useState<string | null>(null);
  const [wallpaperCategory, setWallpaperCategory] =
    useState<WallpaperCategoryId>("all");

  const [uploading, setUploading] = useState(false);
  const [cropSaving, setCropSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cropSession, setCropSession] = useState<WallpaperCropSource | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const decodeRequestIdRef = useRef(0);
  const lastSkySceneRef = useRef<SkySceneId>("auto");
  const lastWallpaperSourceRef = useRef<ArtisticWallpaperPresetId | "custom">(
    "waterlily-pond",
  );

  if (config.canvas.kind === "sky") {
    lastSkySceneRef.current = config.canvas.scene;
  } else if (config.canvas.kind === "wallpaper") {
    lastWallpaperSourceRef.current = config.canvas.source;
  }

  const cropPreviewUrl = cropSession?.previewUrl ?? null;
  useExternalConnection(
    cropPreviewUrl?.startsWith("blob:") ? cropPreviewUrl : false,
    (url) => () => {
      URL.revokeObjectURL(url);
    },
  );

  const modeKeys = useSegmentedKeys<AppearanceMode>({
    value: mode,
    values: MODE_VALUES,
    onChange: (next) => setMode(next),
  });

  const handleSelectCanvasKind = (kind: CanvasKind) => {
    if (kind === config.canvas.kind) return;
    if (kind === "pure") {
      setCanvas({ kind: "pure" });
      return;
    }
    if (kind === "sky") {
      setSkyScene(lastSkySceneRef.current);
      return;
    }
    const remembered = lastWallpaperSourceRef.current;
    const target =
      remembered === "custom" && !customWallpaperUrl
        ? "waterlily-pond"
        : remembered;
    setWallpaperSource(target);
  };

  const canvasKeys = useSegmentedKeys<CanvasKind>({
    value: config.canvas.kind,
    values: CANVAS_VALUES,
    onChange: handleSelectCanvasKind,
  });

  const categoryKeys = useSegmentedKeys<WallpaperCategoryId>({
    value: wallpaperCategory,
    values: WALLPAPER_CATEGORY_VALUES,
    onChange: (next) => setWallpaperCategory(next),
  });

  const busy = uploading || cropSaving;
  const isDefault = isDefaultAppearance(config);
  const activeTheme = THEMES.find((t) => t.id === config.theme) ?? THEMES[0];
  const activeThemeAccent = dark
    ? (activeTheme?.dark.accent ?? "#74aeff")
    : (activeTheme?.light.accent ?? "#2563eb");
  const effectiveAccentHex = config.customAccent ?? activeThemeAccent;

  const hasStoredCustomImage = Boolean(customWallpaperUrl);
  const canRecropStoredCustom =
    hasStoredCustomImage && customWallpaperUrl.startsWith("data:");
  const isCustomActive =
    config.canvas.kind === "wallpaper" &&
    config.canvas.source === "custom" &&
    hasStoredCustomImage;

  const filteredArtWallpapers =
    wallpaperCategory === "all"
      ? ARTISTIC_WALLPAPER_PRESETS
      : ARTISTIC_WALLPAPER_PRESETS.filter(
          (item) => item.category === wallpaperCategory,
        );

  const skyCanvas = config.canvas.kind === "sky" ? config.canvas : null;
  const wallpaperCanvas =
    config.canvas.kind === "wallpaper" ? config.canvas : null;
  const savedCity = skyCanvas?.weather.city ?? "";
  const cityInputValue = cityDraft ?? savedCity;

  const handleSaveCity = () => {
    const trimmed = cityInputValue.trim();
    setSkyWeather({ city: trimmed || null });
    setCityDraft(null);
    toast.success(
      trimmed
        ? `实时天气城市已设为「${trimmed}」`
        : "已清空城市，将按本机时区获取天气",
    );
  };

  const handleClearCity = () => {
    setSkyWeather({ city: null });
    setCityDraft(null);
    toast.success("已清空天气城市");
  };

  const openWallpaperCropForFile = async (file: File) => {
    const invalid = validateWallpaperFile(file);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    const requestId = ++decodeRequestIdRef.current;
    setUploading(true);
    let createdPreviewUrl: string | null = null;
    try {
      createdPreviewUrl = URL.createObjectURL(file);
      const { naturalWidth, naturalHeight } =
        await readImageDimensions(createdPreviewUrl);
      if (decodeRequestIdRef.current !== requestId) {
        URL.revokeObjectURL(createdPreviewUrl);
        return;
      }
      const previewUrl = createdPreviewUrl;
      createdPreviewUrl = null;
      setCropSession({
        blob: file,
        previewUrl,
        naturalWidth,
        naturalHeight,
      });
    } catch (error) {
      if (createdPreviewUrl) {
        URL.revokeObjectURL(createdPreviewUrl);
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "无法读取图片尺寸，请换一张图片重试",
      );
    } finally {
      if (decodeRequestIdRef.current === requestId) {
        setUploading(false);
      }
    }
  };

  const handleOpenRecrop = async () => {
    if (busy) return;
    const requestId = ++decodeRequestIdRef.current;
    setUploading(true);
    let createdPreviewUrl: string | null = null;
    try {
      const savedSource = await loadUploadedWallpaperSource();
      if (decodeRequestIdRef.current !== requestId) return;

      const sourceDataUrl =
        savedSource?.sourceDataUrl ??
        (customWallpaperUrl.startsWith("data:") ? customWallpaperUrl : "");
      if (!sourceDataUrl) {
        toast.error("当前壁纸不支持重新裁剪，请重新选择本地图片");
        return;
      }

      const blob = dataUrlToBlob(sourceDataUrl);
      createdPreviewUrl = URL.createObjectURL(blob);
      const { naturalWidth, naturalHeight } =
        await readImageDimensions(createdPreviewUrl);
      if (decodeRequestIdRef.current !== requestId) {
        URL.revokeObjectURL(createdPreviewUrl);
        return;
      }

      const previewUrl = createdPreviewUrl;
      createdPreviewUrl = null;
      setCropSession({
        blob,
        previewUrl,
        naturalWidth,
        naturalHeight,
        initialPreset: savedSource?.preset,
        initialRect: savedSource?.rect,
        existingSourceDataUrl: sourceDataUrl,
      });
    } catch (error) {
      if (createdPreviewUrl) {
        URL.revokeObjectURL(createdPreviewUrl);
      }
      toast.error(
        error instanceof Error ? error.message : "读取已保存壁纸原图失败",
      );
    } finally {
      if (decodeRequestIdRef.current === requestId) {
        setUploading(false);
      }
    }
  };

  const handleApplyCroppedWallpaper = async ({
    rect,
    preset,
  }: {
    rect: NormalizedCropRect;
    preset: WallpaperAspectPresetId;
  }) => {
    if (!cropSession || cropSaving) return;
    setCropSaving(true);
    try {
      const pixelCrop = toPixelCropRect(
        rect,
        cropSession.naturalWidth,
        cropSession.naturalHeight,
      );
      const crop = isFullImageCrop(
        pixelCrop,
        cropSession.naturalWidth,
        cropSession.naturalHeight,
      )
        ? undefined
        : pixelCrop;
      const dataUrl = await compressCroppedWallpaper(cropSession.blob, crop);
      await saveUploadedWallpaper(dataUrl);

      try {
        const sourceDataUrl =
          cropSession.existingSourceDataUrl ??
          (await readBlobAsDataUrl(cropSession.blob));
        await saveUploadedWallpaperSource({
          sourceDataUrl,
          rect,
          preset,
        });
      } catch {
        // 原图缓存失败不影响已裁剪壁纸的应用
      }

      setCropSession(null);
      toast.success("已裁剪并应用自定义背景壁纸");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传壁纸失败");
    } finally {
      setCropSaving(false);
    }
  };

  const handleCancelCrop = () => {
    if (cropSaving) return;
    decodeRequestIdRef.current += 1;
    setCropSession(null);
  };

  const handleReplaceCropFile = () => {
    if (busy) return;
    fileInputRef.current?.click();
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await openWallpaperCropForFile(file);
  };

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    if (busy) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    await openWallpaperCropForFile(file);
  };

  return (
    <>
      <PageSection
        action={
          !isDefault ? (
            <Button
              data-testid="appearance-reset"
              onClick={() => {
                resetAppearance();
                setCityDraft(null);
                setAccentOpen(false);
                toast.success("已恢复默认外观");
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              <IconRefresh className="size-3.5" />
              {"恢复默认"}
            </Button>
          ) : null
        }
        description={"外观模式、色彩主题、背景画布与界面材质，保存在此浏览器。"}
        settingItem="外观"
        title={"外观"}
      >
        <PageRows>
          {/* 1. 外观模式 */}
          <div
            className="ap-section"
            data-setting-item="general.theme 外观模式 主题"
          >
            <div className="ap-row">
              <div>
                <div className="ap-title">{"外观模式"}</div>
                <div className="ap-desc">
                  {"跟随系统自动切换，或固定为浅色 / 深色（与账号菜单同步）。"}
                </div>
              </div>
              <div
                aria-label="外观模式"
                className="sg-segmented"
                data-surface="inset"
                {...modeKeys.groupProps}
                ref={modeKeys.groupRef}
                role="radiogroup"
              >
                {MODE_OPTIONS.map(({ value, label, Icon }) => (
                  // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 分段单选控件，配合 ui/segmented.tsx 的 roving-tabindex 与方向键约定，原生 radio 无法替代
                  <button
                    aria-checked={mode === value}
                    className="sg-segmented-item"
                    data-testid={`appearance-mode-${value}`}
                    key={value}
                    onClick={() => setMode(value)}
                    role="radio"
                    tabIndex={modeKeys.itemTabIndex(value)}
                    type="button"
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Separator />

          {/* 2. 色彩主题 + 自定义强调色 */}
          <div
            className="ap-section"
            data-setting-item="general.palette 色彩主题 主题配色 主题色"
          >
            <div className="ap-head">
              <div>
                <div className="ap-title">{"色彩主题"}</div>
                <div className="ap-desc">
                  {"统一决定强调色、面板微染色与净色画布基调，不会改变背景类型。"}
                </div>
              </div>
            </div>

            <fieldset aria-label="色彩主题选择" className="ap-theme-grid m-0 border-0 p-0">
              {THEMES.map((theme) => {
                const active = config.theme === theme.id;
                const variant = dark ? theme.dark : theme.light;
                return (
                  <button
                    aria-pressed={active}
                    className={cn("ap-theme-card", active && "is-active")}
                    data-testid={`theme-card-${theme.id}`}
                    key={theme.id}
                    onClick={() => setTheme(theme.id)}
                    title={theme.description}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="ap-theme-preview"
                      style={{
                        background: `linear-gradient(135deg, ${variant.canvasStops[0]}, ${variant.canvasStops[1]}, ${variant.canvasStops[2]})`,
                      }}
                    >
                      <span
                        className="ap-theme-preview-surface"
                        style={{
                          background: variant.surface,
                          color: variant.fg,
                        }}
                      >
                        <span className="ap-theme-preview-line" />
                        <span className="ap-theme-preview-line" />
                      </span>
                      <span
                        className="ap-theme-swatch grid place-items-center"
                        style={{
                          background: variant.accent,
                          color: variant.onAccent,
                        }}
                      >
                        {active ? (
                          <IconCheck className="size-3.5 stroke-[2.8]" />
                        ) : null}
                      </span>
                    </span>
                    <span className="ap-theme-name">{theme.name}</span>
                    <span className="ap-theme-tagline">{theme.tagline}</span>
                  </button>
                );
              })}
            </fieldset>

            <div>
              <Button
                aria-expanded={accentOpen}
                className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                data-testid="custom-accent-toggle"
                onClick={() => setAccentOpen((open) => !open)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {accentOpen ? (
                  <IconChevronDown className="size-3.5" />
                ) : (
                  <IconChevronRight className="size-3.5" />
                )}
                <IconPalette className="size-3.5" />
                <span>{"自定义强调色"}</span>
                {config.customAccent ? (
                  <span
                    className="ml-1 inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                    data-testid="custom-accent-badge"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block size-2.5 rounded-full"
                      style={{ background: config.customAccent }}
                    />
                    {config.customAccent}
                  </span>
                ) : null}
              </Button>

              <SmoothCollapse open={accentOpen} unmountOnExit>
                <div className="ap-accent-row mt-2" data-testid="custom-accent-panel">
                  <label className="inline-flex items-center gap-2 text-xs text-foreground">
                    <input
                      aria-label="自定义强调色"
                      className="ap-accent-picker"
                      data-testid="custom-accent-picker"
                      onChange={(e) => setCustomAccent(e.target.value)}
                      type="color"
                      value={effectiveAccentHex}
                    />
                    <span className="font-mono text-xs">
                      {config.customAccent ?? `${activeThemeAccent}（默认）`}
                    </span>
                  </label>
                  {config.customAccent ? (
                    <Button
                      data-testid="custom-accent-reset"
                      onClick={() => setCustomAccent(null)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {"恢复主题默认"}
                    </Button>
                  ) : null}
                  <span className="ap-hint">
                    {"自动按当前浅/深模式校正文字对比度（≥ 4.5:1）。"}
                  </span>
                </div>
              </SmoothCollapse>
            </div>
          </div>

          <Separator />

          {/* 3. 背景画布（唯一互斥三选一：净色 | 动态天空 | 壁纸） */}
          <div
            className="ap-section"
            data-setting-item="general.sky general.wallpaper 背景画布 动态天空 背景壁纸"
          >
            <div className="ap-head">
              <div>
                <div className="ap-title">{"背景画布"}</div>
                <div className="ap-desc">
                  {"窗口最底层唯一画布，在净色、动态天空与壁纸间三选一。"}
                </div>
              </div>
              <div className="ap-actions">
                <div
                  aria-label="背景画布类型"
                  className="sg-segmented"
                  data-surface="inset"
                  {...canvasKeys.groupProps}
                  ref={canvasKeys.groupRef}
                  role="radiogroup"
                >
                  {CANVAS_OPTIONS.map(({ value, label }) => (
                    // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 分段单选控件，配合 ui/segmented.tsx 的 roving-tabindex 与方向键约定，原生 radio 无法替代
                    <button
                      aria-checked={config.canvas.kind === value}
                      className="sg-segmented-item"
                      data-testid={`canvas-kind-${value}`}
                      key={value}
                      onClick={() => handleSelectCanvasKind(value)}
                      role="radio"
                      tabIndex={canvasKeys.itemTabIndex(value)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 3a. 净色 */}
            {config.canvas.kind === "pure" ? (
              <p className="ap-hint" data-testid="canvas-pure-hint">
                {"极简主题微渐变，随当前色彩主题与浅/深模式自动过渡，零动画与 GPU 开销。"}
              </p>
            ) : null}

            {/* 3b. 动态天空 */}
            {skyCanvas ? (
              <div className="flex flex-col gap-3" data-testid="canvas-sky-panel">
                <div className="ap-subhead">{"天空时刻"}</div>
                <fieldset
                  aria-label="动态天空时刻选择"
                  className="appearance-wallpaper-grid m-0 border-0 p-0"
                >
                  {SKY_SCENES.map((scene) => {
                    const active = skyCanvas.scene === scene.id;
                    return (
                      <button
                        aria-pressed={active}
                        className={cn(
                          "appearance-wallpaper-card",
                          active && "is-active",
                        )}
                        data-testid={`sky-scene-${scene.id}`}
                        key={scene.id}
                        onClick={() => setSkyScene(scene.id)}
                        type="button"
                      >
                        <div
                          className="appearance-wallpaper-thumb"
                          style={{ background: scene.previewGradient }}
                        >
                          {active ? (
                            <span className="appearance-swatch-check absolute top-2 right-2">
                              <IconCheck className="size-3.5 stroke-[2.6]" />
                            </span>
                          ) : null}
                        </div>
                        <div className="appearance-wallpaper-meta">
                          <span className="appearance-palette-name">
                            {scene.name}
                          </span>
                          <span className="appearance-palette-sub">
                            {scene.subtitle}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </fieldset>

                <div
                  className="ap-accent-row flex-col items-stretch gap-2.5"
                  data-setting-item="实时天气"
                  data-testid="sky-weather-panel"
                >
                  <div className="ap-row">
                    <div className="min-w-0 flex-1">
                      <div className="ap-title">{"叠加实时天气"}</div>
                      <div className="ap-desc">
                        {skyCanvas.scene !== "auto"
                          ? "仅在「随时间流动」模式下生效；开启后将自动切回「随时间流动」。关闭时零外网请求。"
                          : skyCanvas.weather.enabled
                            ? "已开启：按设定城市（留空则按本机时区）拉取实时云量与降水。"
                            : "默认关闭，关闭时零外网请求，仅按本机时间沿柔和太阳弧线演进。"}
                      </div>
                    </div>
                    <Switch
                      aria-label="叠加实时天气"
                      checked={skyCanvas.weather.enabled}
                      data-testid="sky-weather-switch"
                      onCheckedChange={(checked) =>
                        setSkyWeather({ enabled: checked })
                      }
                    />
                  </div>

                  <SmoothCollapse open={skyCanvas.weather.enabled} unmountOnExit>
                    <div className="flex flex-col gap-2 pt-1">
                      {skyCanvas.scene !== "auto" ? (
                        <p className="ap-hint">
                          {"当前为固定时刻，实时天气仅在「随时间流动」模式下生效。"}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          aria-label="实时天气城市"
                          className="max-w-xs flex-1"
                          data-testid="sky-weather-city-input"
                          maxLength={80}
                          onChange={(e) => setCityDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleSaveCity();
                            }
                          }}
                          placeholder="输入城市名（如：上海、Tokyo，留空按时区）"
                          value={cityInputValue}
                        />
                        <Button
                          data-testid="sky-weather-city-save"
                          onClick={handleSaveCity}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {"保存"}
                        </Button>
                        {savedCity || cityInputValue.trim() ? (
                          <Button
                            data-testid="sky-weather-city-clear"
                            onClick={handleClearCity}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            {"清空"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </SmoothCollapse>
                </div>
              </div>
            ) : null}

            {/* 3c. 壁纸 */}
            {wallpaperCanvas ? (
              <div
                className="flex flex-col gap-3"
                data-testid="canvas-wallpaper-panel"
              >
                <div className="ap-row">
                  <div className="ap-subhead m-0">{"精选艺术壁纸"}</div>
                  <div
                    aria-label="艺术壁纸分类"
                    className="sg-segmented"
                    data-surface="inset"
                    {...categoryKeys.groupProps}
                    ref={categoryKeys.groupRef}
                    role="radiogroup"
                  >
                    {WALLPAPER_CATEGORIES.map(({ id, label }) => (
                      // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 分段单选控件，配合 ui/segmented.tsx 的 roving-tabindex 与方向键约定，原生 radio 无法替代
                      <button
                        aria-checked={wallpaperCategory === id}
                        className="sg-segmented-item"
                        data-testid={`wallpaper-cat-${id}`}
                        key={id}
                        onClick={() => setWallpaperCategory(id)}
                        role="radio"
                        tabIndex={categoryKeys.itemTabIndex(id)}
                        type="button"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <ContentEnter
                  aria-label="艺术壁纸图库选择"
                  className="appearance-wallpaper-grid"
                  key={wallpaperCategory}
                >
                  {filteredArtWallpapers.map((item) => {
                    const active = wallpaperCanvas.source === item.id;
                    return (
                      <button
                        aria-pressed={active}
                        className={cn(
                          "appearance-wallpaper-card",
                          active && "is-active",
                        )}
                        data-testid={`wallpaper-preset-${item.id}`}
                        key={item.id}
                        onClick={() => setWallpaperSource(item.id)}
                        type="button"
                      >
                        <div
                          className="appearance-wallpaper-thumb appearance-art-thumb"
                          style={{ background: item.previewBackground }}
                        >
                          <span
                            aria-hidden="true"
                            className="appearance-art-img"
                            style={{
                              backgroundImage: `url("${item.thumbUrl}")`,
                            }}
                          />
                          <span className="appearance-art-badge">
                            {item.tag}
                          </span>
                          {active ? (
                            <span className="appearance-swatch-check">
                              <IconCheck className="size-3.5 stroke-[2.6]" />
                            </span>
                          ) : null}
                        </div>
                        <div className="appearance-wallpaper-meta">
                          <span className="appearance-palette-name">
                            {item.name}
                          </span>
                          <span className="appearance-palette-sub">
                            {item.subtitle}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </ContentEnter>

                {/* 本地图片上传 / 裁剪 / 更换 / 移除 */}
                <input
                  accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                  className="hidden"
                  onChange={handleFileUpload}
                  ref={fileInputRef}
                  type="file"
                />
                {/* biome-ignore lint/a11y/useSemanticElements: 拖放区内部嵌套多个操作按钮，HTML 规范不允许 button 嵌套 button */}
                <div
                  className={cn(
                    "appearance-upload-dropzone",
                    dragOver && "is-dragover",
                    isCustomActive && "has-custom",
                  )}
                  data-testid="wallpaper-upload-dropzone"
                  onClick={() => {
                    if (!busy) {
                      fileInputRef.current?.click();
                    }
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDrop={handleDrop}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (!busy) {
                        fileInputRef.current?.click();
                      }
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  {hasStoredCustomImage ? (
                    <div
                      className="appearance-upload-preview"
                      style={{
                        backgroundImage: `url("${customWallpaperUrl}")`,
                      }}
                    />
                  ) : (
                    <div className="appearance-upload-icon">
                      <IconUpload className="size-4.5" />
                    </div>
                  )}
                  <div className="appearance-upload-copy">
                    <div className="appearance-upload-title">
                      {cropSaving
                        ? "正在按选定区域裁剪并保存壁纸…"
                        : uploading
                          ? "正在读取壁纸图片…"
                          : isCustomActive
                            ? "已启用本地自定义壁纸（点击或拖拽新图片即可更换）"
                            : hasStoredCustomImage
                              ? "已保存本地自定义壁纸（点击右侧按钮即可重新启用）"
                              : "点击选择本地图片，或直接将壁纸拖拽到此处上传"}
                    </div>
                    <div className="appearance-upload-sub">
                      {
                        "支持 PNG / JPG / WebP / GIF / AVIF（不超过 20 MB），上传时可自由框选裁剪区域"
                      }
                    </div>
                  </div>
                  <div className="appearance-upload-actions">
                    {hasStoredCustomImage && !isCustomActive ? (
                      <Button
                        data-testid="wallpaper-custom-activate"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setWallpaperSource("custom");
                        }}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        <IconPhoto className="size-3.5" />
                        {"启用此图片"}
                      </Button>
                    ) : null}
                    {canRecropStoredCustom ? (
                      <Button
                        data-testid="wallpaper-custom-recrop"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleOpenRecrop();
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <IconCrop className="size-3.5" />
                        {"裁剪区域"}
                      </Button>
                    ) : null}
                    <Button
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                      size="sm"
                      type="button"
                      variant={
                        hasStoredCustomImage && !isCustomActive
                          ? "ghost"
                          : "secondary"
                      }
                    >
                      <IconUpload className="size-3.5" />
                      {hasStoredCustomImage ? "更换图片" : "选择图片上传"}
                    </Button>
                    {hasStoredCustomImage ? (
                      <Button
                        data-testid="wallpaper-custom-remove"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeCustomWallpaper();
                          toast.success("已移除自定义壁纸");
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <IconTrash className="size-3.5" />
                        {"移除"}
                      </Button>
                    ) : null}
                  </div>
                </div>

                {/* 仅 2 条微调滑块：背景模糊 (0–24px) 与护眼薄幕 (0–100%) */}
                <div className="appearance-sliders">
                  <label className="appearance-slider-row">
                    <span className="appearance-slider-label">
                      <span>{"背景模糊"}</span>
                      <span className="appearance-slider-val">
                        {`${wallpaperCanvas.blur} px`}
                      </span>
                    </span>
                    <Input
                      aria-label="背景模糊"
                      className="appearance-range"
                      data-testid="wallpaper-blur-slider"
                      max={WALLPAPER_BLUR_MAX}
                      min={WALLPAPER_BLUR_MIN}
                      onChange={(e) =>
                        setWallpaperAdjustments({
                          blur: Number(e.target.value),
                        })
                      }
                      step={1}
                      style={rangeFillStyle(
                        wallpaperCanvas.blur,
                        WALLPAPER_BLUR_MIN,
                        WALLPAPER_BLUR_MAX,
                      )}
                      type="range"
                      value={wallpaperCanvas.blur}
                    />
                  </label>
                  <label className="appearance-slider-row">
                    <span className="appearance-slider-label">
                      <span>{"护眼薄幕"}</span>
                      <span className="appearance-slider-val">
                        {`${wallpaperCanvas.scrim}%`}
                      </span>
                    </span>
                    <Input
                      aria-label="护眼薄幕"
                      className="appearance-range"
                      data-testid="wallpaper-scrim-slider"
                      max={WALLPAPER_SCRIM_MAX}
                      min={WALLPAPER_SCRIM_MIN}
                      onChange={(e) =>
                        setWallpaperAdjustments({
                          scrim: Number(e.target.value),
                        })
                      }
                      step={1}
                      style={rangeFillStyle(
                        wallpaperCanvas.scrim,
                        WALLPAPER_SCRIM_MIN,
                        WALLPAPER_SCRIM_MAX,
                      )}
                      type="range"
                      value={wallpaperCanvas.scrim}
                    />
                  </label>
                </div>
              </div>
            ) : null}
          </div>

          <Separator />

          {/* 4. 界面材质 + 静止动态背景（省电） */}
          <div
            className="ap-section"
            data-setting-item="general.material 界面材质 静止动态背景"
          >
            <div className="ap-head">
              <div>
                <div className="ap-title">{"界面材质"}</div>
                <div className="ap-desc">
                  {"控制侧栏、浮层与对话气泡的透光层次；纯 CSS 驱动，按需零模糊。"}
                </div>
              </div>
            </div>

            <fieldset
              aria-label="界面材质选择"
              className="ap-material-grid m-0 border-0 p-0"
            >
              {MATERIALS.map((item) => {
                const active = config.material === item.id;
                return (
                  <button
                    aria-pressed={active}
                    className={cn("ap-material-card", active && "is-active")}
                    data-testid={`material-card-${item.id}`}
                    key={item.id}
                    onClick={() => setMaterial(item.id)}
                    type="button"
                  >
                    <span className="ap-material-name">
                      {materialTitle(item.id, item.name)}
                    </span>
                    <span className="ap-material-desc">{item.description}</span>
                  </button>
                );
              })}
            </fieldset>

            {reducedTransparency ? (
              <p
                className="ap-hint"
                data-testid="reduced-transparency-hint"
                role="status"
              >
                {"已跟随系统减少透明度自动切换为实色"}
              </p>
            ) : null}

            <div className="ap-row pt-1">
              <div className="min-w-0 flex-1">
                <div className="ap-title">{"静止动态背景（省电）"}</div>
                <div className="ap-desc">
                  {"仅对动态天空生效：将流云定格在静态画面并停止动画循环，降低电量与 GPU 占用。"}
                </div>
              </div>
              <Switch
                aria-label="静止动态背景（省电）"
                checked={config.staticBackground}
                data-testid="static-background-switch"
                onCheckedChange={(checked) => setStaticBackground(checked)}
              />
            </div>
          </div>
        </PageRows>
      </PageSection>

      <WallpaperCropDialog
        onApply={handleApplyCroppedWallpaper}
        onCancel={handleCancelCrop}
        onReplaceFile={handleReplaceCropFile}
        saving={cropSaving}
        source={cropSession}
      />
    </>
  );
}

export { AppearancePreferences as AppearancePreferencesSection };
