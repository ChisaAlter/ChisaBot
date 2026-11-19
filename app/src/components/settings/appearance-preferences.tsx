import {
  IconCheck,
  IconCloud,
  IconCrop,
  IconPhoto,
  IconPlus,
  IconRefresh,
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
import { useTheme } from "@/components/theme-provider";
import { useExternalConnection } from "@/hooks";
import {
  WallpaperCropDialog,
  type WallpaperCropSource,
} from "@/components/settings/wallpaper-crop-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import {
  ARTISTIC_WALLPAPER_PRESETS,
  compressCroppedWallpaper,
  DEFAULT_GLASS_OPACITY,
  DEFAULT_GLASS_STYLE,
  familySkyStops,
  GLASS_OPACITY_MAX,
  GLASS_OPACITY_MIN,
  type GlassStyleId,
  HARK_SCENE_INFO,
  HARK_SKY_SCENES,
  type HarkSkySceneId,
  listThemeFamilies,
  loadUploadedWallpaperSource,
  resetAppearanceDefaults,
  resolvedSeed,
  resolvedThemeFamily,
  saveCustomFamily,
  saveUploadedWallpaper,
  saveUploadedWallpaperSource,
  type Seed,
  setCustomWallpaperUrl,
  setGlassOpacity,
  setGlassOpacityDark,
  setGlassStyle,
  setHarkSkyScene,
  setSkySource,
  setThemeHalf,
  setWallpaperBlur,
  setWallpaperDim,
  setWallpaperPreset,
  setWallpaperScrim,
  updateAppearance,
  useAppearance,
  validateWallpaperFile,
  WALLPAPER_CATEGORIES,
  type WallpaperCategoryId,
} from "@/lib/appearance";
import { cn } from "@/lib/utils";
import { dataUrlToBlob } from "@/lib/wallpaper-compress";
import {
  isFullImageCrop,
  type NormalizedCropRect,
  toPixelCropRect,
  type WallpaperAspectPresetId,
} from "@/lib/wallpaper-crop";

const GLASS_STYLE_OPTIONS: readonly { value: GlassStyleId; label: string }[] = [
  { value: "liquid", label: "液态玻璃" },
  { value: "mist", label: "薄雾玻璃" },
  { value: "crystal", label: "晶莹全透" },
  { value: "frosted", label: "柔光磨砂" },
];
const GLASS_STYLE_VALUES: readonly GlassStyleId[] = [
  "liquid",
  "mist",
  "crystal",
  "frosted",
];
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

/** 自定义族编辑器草稿：name + 两个 seed；None = 编辑器关闭。 */
type FamilyDraft = { name: string; light: Seed; dark: Seed };

export function AppearancePreferences() {
  const appearance = useAppearance();
  const { dark } = useTheme();
  const glassKeys = useSegmentedKeys<GlassStyleId>({
    value: appearance.glassStyle,
    values: GLASS_STYLE_VALUES,
    onChange: (next) => setGlassStyle(next),
  });
  const [wallpaperCategory, setWallpaperCategory] =
    useState<WallpaperCategoryId>("all");
  const categoryKeys = useSegmentedKeys<WallpaperCategoryId>({
    value: wallpaperCategory,
    values: WALLPAPER_CATEGORY_VALUES,
    onChange: (next) => setWallpaperCategory(next),
  });

  const [uploading, setUploading] = useState(false);
  const [cropSaving, setCropSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cropSession, setCropSession] = useState<WallpaperCropSource | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const decodeRequestIdRef = useRef(0);

  const cropPreviewUrl = cropSession?.previewUrl ?? null;
  useExternalConnection(
    cropPreviewUrl?.startsWith("blob:") ? cropPreviewUrl : false,
    (url) => () => {
      URL.revokeObjectURL(url);
    },
  );

  const busy = uploading || cropSaving;
  const hasStoredCustomImage = Boolean(appearance.customWallpaperUrl);
  const canRecropStoredCustom =
    hasStoredCustomImage && appearance.customWallpaperUrl.startsWith("data:");
  const isCustomActive =
    appearance.wallpaperId === "custom" && hasStoredCustomImage;
  const filteredArtWallpapers =
    wallpaperCategory === "all"
      ? ARTISTIC_WALLPAPER_PRESETS
      : ARTISTIC_WALLPAPER_PRESETS.filter(
          (item) => item.category === wallpaperCategory,
        );

  // 主题族（CB-140）：浅 / 深两槽各自独立；点卡片的某半边只写那一槽。
  const families = listThemeFamilies(appearance.customFamilies);
  const resolvedFamily = resolvedThemeFamily(appearance, dark);
  const [familyDraft, setFamilyDraft] = useState<FamilyDraft | null>(null);

  const openFamilyEditor = () => {
    // 草稿从两个模式当前各自选中的族复制：改完保存就成一套新族。
    const light = resolvedThemeFamily(appearance, false).light;
    const darkSeed = resolvedThemeFamily(appearance, true).dark;
    setFamilyDraft({
      name: "",
      light: { ...light },
      dark: { ...darkSeed },
    });
  };

  const handleSaveCustomFamily = () => {
    if (!familyDraft) return;
    const name = familyDraft.name.trim() || "我的主题";
    saveCustomFamily({
      id: `custom-${Date.now().toString(36)}`,
      name,
      light: familyDraft.light,
      dark: familyDraft.dark,
    });
    setFamilyDraft(null);
    toast.success(`已保存主题族「${name}」`);
  };

  const patchDraftSeed = (mode: "light" | "dark", patch: Partial<Seed>) => {
    setFamilyDraft((draft) =>
      draft ? { ...draft, [mode]: { ...draft[mode], ...patch } } : draft,
    );
  };

  // 编辑器里的背景材质选择：写的就是天空来源三选一（壁纸有已存的自定义图就回填，否则给第一张预设）。
  const bgPick =
    appearance.wallpaperId !== "none" ? "wallpaper" : appearance.skySource;
  const applyBgPick = (pick: "theme" | "hark" | "wallpaper") => {
    if (pick === "wallpaper") {
      setWallpaperPreset(
        appearance.customWallpaperUrl ? "custom" : "waterlily-pond",
      );
      return;
    }
    setSkySource(pick);
  };

  // 「主题天空」卡的预览 = 当前族 seed 派生的四段渐变。
  const famStops = familySkyStops(resolvedSeed(appearance, dark), dark);
  const themeSkyGradient = `linear-gradient(180deg, ${famStops[0]} 0%, ${famStops[1]} 36%, ${famStops[2]} 72%, ${famStops[3]} 100%)`;
  const themeSkySubtitle = `「${resolvedFamily.name}」配套的主题渐变天空`;

  const openWallpaperCropForFile = async (file: File) => {
    // 先校验类型和大小，超限的文件不读进内存
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
        (appearance.customWallpaperUrl.startsWith("data:")
          ? appearance.customWallpaperUrl
          : "");
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
      // 存进 IndexedDB 成功后才应用；保存失败会抛错，走下面的错误提示
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
      {/* 1. 外观模型（CB-140）：外观 = 模式 × 主题族 × 背景。
       *    族卡的左右半边分别写浅 / 深族槽（允许混搭）；天空背景在
       *    「主题天空 / Hark 动态天象 / 壁纸」三选一，昼景只配浅色、夜景只配深色
       *    （错配在解析层自动落到配对场景），晨昏两相宜。 */}
      <div
        className="appearance-block"
        data-setting-item="主题皮肤 主题配色 主题族 general.sky"
      >
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">{"主题族与天空背景"}</div>
            <div className="appearance-block-desc">
              {
                "主题族决定整套强调色、文字与配套天空渐变；浅 / 深模式各选一族。天象由 Hark WebGL 引擎实时渲染，昼夜场景按外观明暗自动配对呈现"
              }
            </div>
          </div>
          <div className="appearance-head-actions">
            {appearance.harkScene !== "auto" ||
            appearance.familyLight !== "azure" ||
            appearance.familyDark !== "azure" ||
            appearance.customFamilies.length > 0 ||
            appearance.wallpaperId !== "none" ||
            appearance.glassStyle !== DEFAULT_GLASS_STYLE ||
            appearance.glassOpacity !== DEFAULT_GLASS_OPACITY ||
            appearance.glassOpacityDark !== DEFAULT_GLASS_OPACITY ? (
              <Button
                onClick={() => {
                  resetAppearanceDefaults();
                  setFamilyDraft(null);
                  toast.success("已恢复默认外观");
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconRefresh className="size-3.5" />
                {"恢复默认"}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="appearance-subhead">{"主题族"}</div>
        <fieldset aria-label="主题族选择" className="appearance-fam-grid">
          {families.map((family) => {
            return (
              <div className="appearance-fam-card" key={family.id}>
                <div className="appearance-fam-preview">
                  {(["light", "dark"] as const).map((mode) => {
                    const s = family[mode];
                    const selected =
                      (mode === "light"
                        ? appearance.familyLight
                        : appearance.familyDark) === family.id;
                    const current = dark === (mode === "dark");
                    return (
                      <button
                        aria-pressed={selected}
                        className={cn(
                          "appearance-fam-half",
                          selected && "is-sel",
                        )}
                        data-testid={`fam-half-${family.id}-${mode}`}
                        key={mode}
                        onClick={() => setThemeHalf(mode, family.id)}
                        style={
                          {
                            background: s.bg,
                            color: s.fg,
                            "--fam-ac": s.ac,
                          } as CSSProperties
                        }
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="appearance-fam-mini"
                        >
                          <i
                            className="appearance-fam-dot"
                            style={{ background: s.ac }}
                          />
                          <span className="appearance-fam-lines">
                            <i />
                            <i />
                          </span>
                        </span>
                        <span className="appearance-fam-label">
                          {mode === "light" ? "浅色" : "深色"}
                          {current ? (
                            <span className="appearance-fam-current">当前</span>
                          ) : null}
                        </span>
                        {selected ? (
                          <span className="appearance-fam-check">
                            <IconCheck className="size-3 stroke-[2.8]" />
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <div className="appearance-fam-meta">
                  <b>{family.name}</b>
                  <small>
                    {family.light.ac} · {family.dark.ac}
                  </small>
                </div>
              </div>
            );
          })}
          <button
            className="appearance-fam-card appearance-fam-plus"
            data-testid="fam-custom"
            onClick={openFamilyEditor}
            type="button"
          >
            <IconPlus className="appearance-fam-plus-ic" />
            <span className="appearance-fam-plus-tx">{"自定义主题"}</span>
            <span className="appearance-fam-plus-sub">
              {"命名 + 双色种子 + 对比度"}
            </span>
          </button>
        </fieldset>

        {familyDraft ? (
          <div className="appearance-fam-editor" data-testid="fam-editor">
            <div className="appearance-fam-editor-head">
              <span>{"自定义主题族"}</span>
              <Button
                onClick={() => setFamilyDraft(null)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {"取消"}
              </Button>
            </div>
            <Input
              onChange={(e) =>
                setFamilyDraft({ ...familyDraft, name: e.target.value })
              }
              placeholder="主题名称（如：我的晨间）"
              value={familyDraft.name}
            />
            <div className="appearance-fam-ed-cols">
              {(["light", "dark"] as const).map((mode) => {
                const s = familyDraft[mode];
                return (
                  <div
                    className="appearance-fam-ed-col"
                    data-testid={`fam-ed-${mode}`}
                    key={mode}
                  >
                    <h4>
                      <i
                        style={{
                          background: mode === "light" ? "#f6c945" : "#7c8db5",
                        }}
                      />
                      {mode === "light" ? "浅色 Light" : "深色 Dark"}
                    </h4>
                    <div className="appearance-fam-ed-colors">
                      {(
                        [
                          ["ac", "强调色"],
                          ["bg", "底色"],
                          ["fg", "文字"],
                        ] as const
                      ).map(([key, label]) => (
                        <label className="appearance-fam-ed-color" key={key}>
                          <input
                            onChange={(e) =>
                              patchDraftSeed(mode, { [key]: e.target.value })
                            }
                            type="color"
                            value={s[key]}
                          />
                          {label}
                        </label>
                      ))}
                      <span
                        aria-hidden="true"
                        className="appearance-fam-ed-sample"
                        style={{ background: s.bg, color: s.fg }}
                      >
                        <i style={{ background: s.ac }} />
                        {"Aa"}
                      </span>
                    </div>
                    <label className="appearance-fam-ed-ct">
                      {"对比度"}
                      <input
                        max={70}
                        min={30}
                        onChange={(e) =>
                          patchDraftSeed(mode, { c: Number(e.target.value) })
                        }
                        type="range"
                        value={s.c}
                      />
                      <b>{s.c}</b>
                    </label>
                  </div>
                );
              })}
            </div>
            <div className="appearance-fam-ed-foot">
              <div
                aria-label="背景材质"
                className="appearance-fam-ed-bg"
                role="radiogroup"
              >
                {(
                  [
                    ["theme", "主题天空"],
                    ["hark", "动态天象"],
                    ["wallpaper", "壁纸"],
                  ] as const
                ).map(([pick, label]) => (
                  // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 单选卡片（与下方天空背景组同一模式），原生 radio 换不了
                  <button
                    aria-checked={bgPick === pick}
                    className={cn(
                      "appearance-fam-ed-bg-chip",
                      bgPick === pick && "is-on",
                    )}
                    data-testid={`fam-bg-${pick}`}
                    key={pick}
                    onClick={() => applyBgPick(pick)}
                    role="radio"
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Button onClick={handleSaveCustomFamily} type="button">
                {"保存主题族"}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="appearance-subhead">{"天空背景"}</div>
        <div
          aria-label="天空背景选择"
          className="appearance-wallpaper-grid"
          role="radiogroup"
        >
          {/* 「主题天空」：皮肤配套静态渐变（引擎不启动）。它和天象卡是同一个单选组：
              壁纸启用时整组都不亮（壁纸盖过天空）。 */}
          {/* biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 单选卡片，样式依赖 button 结构，原生 radio 换不了 */}
          <button
            aria-checked={
              appearance.wallpaperId === "none" &&
              appearance.skySource === "theme"
            }
            className={cn(
              "appearance-wallpaper-card",
              appearance.wallpaperId === "none" &&
                appearance.skySource === "theme" &&
                "is-active",
            )}
            data-testid="sky-source-theme"
            onClick={() => setSkySource("theme")}
            role="radio"
            type="button"
          >
            <div
              className="appearance-wallpaper-thumb"
              style={{ background: themeSkyGradient }}
            >
              <div className="appearance-wallpaper-glass-demo">
                <i />
                <i />
              </div>
              {appearance.wallpaperId === "none" &&
              appearance.skySource === "theme" ? (
                <span className="appearance-swatch-check">
                  <IconCheck className="size-3.5 stroke-[2.6]" />
                </span>
              ) : null}
            </div>
            <div className="appearance-wallpaper-meta">
              <span className="appearance-palette-name">{"主题天空"}</span>
              <span className="appearance-palette-sub">{themeSkySubtitle}</span>
            </div>
          </button>
          {HARK_SKY_SCENES.map((scene) => {
            const active =
              appearance.wallpaperId === "none" &&
              appearance.skySource === "hark" &&
              appearance.harkScene === scene.id;
            const daylight =
              scene.sceneIndex !== null && scene.sceneIndex >= 0
                ? HARK_SCENE_INFO[scene.sceneIndex]?.daylight
                : null;
            return (
              // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 单选卡片，样式依赖 button 结构，原生 radio 换不了
              <button
                aria-checked={active}
                className={cn(
                  "appearance-wallpaper-card",
                  active && "is-active",
                )}
                data-testid={`hark-scene-${scene.id}`}
                key={scene.id}
                onClick={() => setHarkSkyScene(scene.id as HarkSkySceneId)}
                role="radio"
                type="button"
              >
                <div
                  className="appearance-wallpaper-thumb"
                  style={{ background: scene.previewGradient }}
                >
                  <div className="appearance-wallpaper-glass-demo">
                    <i />
                    <i />
                  </div>
                  {daylight ? (
                    <span className="appearance-scene-daylight">
                      {daylight === "day"
                        ? "昼"
                        : daylight === "night"
                          ? "夜"
                          : "暮"}
                    </span>
                  ) : null}
                  {active ? (
                    <span className="appearance-swatch-check">
                      <IconCheck className="size-3.5 stroke-[2.6]" />
                    </span>
                  ) : null}
                </div>
                <div className="appearance-wallpaper-meta">
                  <span className="appearance-palette-name">{scene.name}</span>
                  <span className="appearance-palette-sub">
                    {scene.subtitle}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. 面板玻璃材质与透光率控制 */}
      <div className="appearance-block" data-setting-item="面板玻璃材质">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">
              {"面板玻璃材质与透光率"}
            </div>
            <div className="appearance-block-desc">
              {
                "液态玻璃（立体镜面高光折射）、薄雾玻璃（旧版柔焦渐变）、晶莹全透（超薄水母级透明）、柔光磨砂（细腻雾面柔焦），均可透出底层流云与壁纸"
              }
            </div>
          </div>
          <div
            aria-label="玻璃面板材质"
            className="sg-segmented"
            {...glassKeys.groupProps}
            ref={glassKeys.groupRef}
            role="radiogroup"
          >
            {GLASS_STYLE_OPTIONS.map(({ value, label }) => (
              // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
              <button
                aria-checked={appearance.glassStyle === value}
                className="sg-segmented-item"
                key={value}
                onClick={() => setGlassStyle(value)}
                role="radio"
                tabIndex={glassKeys.itemTabIndex(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="appearance-sliders">
          <label className="appearance-slider-row">
            <span className="appearance-slider-label">
              <span>{"面板雾度 · 浅色（数值越小越通透）"}</span>
              <span className="appearance-slider-val">
                {`${appearance.glassOpacity}%（透光率 ${100 - appearance.glassOpacity}%）`}
              </span>
            </span>
            <Input
              aria-label="玻璃面板不透明度"
              className="appearance-range"
              max={GLASS_OPACITY_MAX}
              min={GLASS_OPACITY_MIN}
              onChange={(e) => setGlassOpacity(Number(e.target.value))}
              step={1}
              style={rangeFillStyle(
                appearance.glassOpacity,
                GLASS_OPACITY_MIN,
                GLASS_OPACITY_MAX,
              )}
              type="range"
              value={appearance.glassOpacity}
            />
          </label>
          <label className="appearance-slider-row">
            <span className="appearance-slider-label">
              <span>{"面板雾度 · 深色"}</span>
              <span className="appearance-slider-val">
                {`${appearance.glassOpacityDark}%（透光率 ${100 - appearance.glassOpacityDark}%）`}
              </span>
            </span>
            <Input
              aria-label="深色玻璃面板不透明度"
              className="appearance-range"
              max={GLASS_OPACITY_MAX}
              min={GLASS_OPACITY_MIN}
              onChange={(e) => setGlassOpacityDark(Number(e.target.value))}
              step={1}
              style={rangeFillStyle(
                appearance.glassOpacityDark,
                GLASS_OPACITY_MIN,
                GLASS_OPACITY_MAX,
              )}
              type="range"
              value={appearance.glassOpacityDark}
            />
          </label>
        </div>
      </div>

      {/* 3. 艺术壁纸图库与自定义图片壁纸 */}
      <div className="appearance-block" data-setting-item="背景壁纸">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">
              {"艺术壁纸图库与自定义壁纸"}
            </div>
            <div className="appearance-block-desc">
              {
                "精选 15 幅印象油画、东方意境与现代光影画作，或上传本地图片，透过液态玻璃呈现通透景深"
              }
            </div>
          </div>
          <div className="appearance-block-actions">
            <input
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              className="hidden"
              onChange={handleFileUpload}
              ref={fileInputRef}
              type="file"
            />
            <div
              aria-label="艺术壁纸分类"
              className="sg-segmented"
              {...categoryKeys.groupProps}
              ref={categoryKeys.groupRef}
              role="radiogroup"
            >
              {WALLPAPER_CATEGORIES.map(({ id, label }) => (
                // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
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
            {appearance.wallpaperId !== "none" ? (
              <Button
                onClick={() => {
                  updateAppearance({
                    wallpaperId: "none",
                    skySource: "hark",
                  });
                  toast.success("已切回 Hark 动态天空");
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconCloud className="size-3.5" />
                {"切回动态天空"}
              </Button>
            ) : null}
          </div>
        </div>

        {/* 精选艺术壁纸图库网格 */}
        <div
          aria-label="艺术壁纸图库选择"
          className="appearance-wallpaper-grid"
          role="radiogroup"
        >
          {filteredArtWallpapers.map((item) => {
            const active = appearance.wallpaperId === item.id;
            return (
              // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 单选卡片，样式依赖 button 结构，原生 radio 换不了
              <button
                aria-checked={active}
                className={cn(
                  "appearance-wallpaper-card",
                  active && "is-active",
                )}
                data-testid={`wallpaper-preset-${item.id}`}
                key={item.id}
                onClick={() => setWallpaperPreset(item.id)}
                role="radio"
                type="button"
              >
                <div
                  className="appearance-wallpaper-thumb appearance-art-thumb"
                  style={{ background: item.previewBackground }}
                >
                  <span
                    aria-hidden="true"
                    className="appearance-art-img"
                    style={{ backgroundImage: `url("${item.thumbUrl}")` }}
                  />
                  <span className="appearance-art-badge">{item.tag}</span>
                  {active ? (
                    <span className="appearance-swatch-check">
                      <IconCheck className="size-3.5 stroke-[2.6]" />
                    </span>
                  ) : null}
                </div>
                <div className="appearance-wallpaper-meta">
                  <span className="appearance-palette-name">{item.name}</span>
                  <span className="appearance-palette-sub">
                    {item.subtitle}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* 本地图片拖拽 / 点击上传横幅 */}
        {/* biome-ignore lint/a11y/useSemanticElements: 拖放区里还嵌着按钮，外层不能是 <button>（按钮不能嵌套） */}
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
                backgroundImage: `url("${appearance.customWallpaperUrl}")`,
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
                "支持 PNG / JPG / WebP / GIF / AVIF（不超过 20 MB），上传时可按屏幕比例或自由框选裁剪区域"
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
                  setWallpaperPreset("custom");
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
                // 别冒泡到拖放区，否则会再打开一次文件选择
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              size="sm"
              type="button"
              variant={
                hasStoredCustomImage && !isCustomActive ? "ghost" : "secondary"
              }
            >
              <IconUpload className="size-3.5" />
              {hasStoredCustomImage ? "更换图片" : "选择图片上传"}
            </Button>
            {hasStoredCustomImage ? (
              <Button
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  if (appearance.wallpaperId === "custom") {
                    setCustomWallpaperUrl("");
                  } else {
                    updateAppearance({ customWallpaperUrl: "" });
                  }
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

        {/* 壁纸模糊度与压暗度微调滑块 */}
        {appearance.wallpaperId !== "none" ? (
          <div className="appearance-sliders">
            <label className="appearance-slider-row">
              <span className="appearance-slider-label">
                <span>{"壁纸景深模糊度"}</span>
                <span className="appearance-slider-val">
                  {`${appearance.wallpaperBlur} px`}
                </span>
              </span>
              <Input
                aria-label="壁纸景深模糊度"
                className="appearance-range"
                max={40}
                min={0}
                onChange={(e) => setWallpaperBlur(Number(e.target.value))}
                step={1}
                style={rangeFillStyle(appearance.wallpaperBlur, 0, 40)}
                type="range"
                value={appearance.wallpaperBlur}
              />
            </label>
            <label className="appearance-slider-row">
              <span className="appearance-slider-label">
                <span>{"壁纸氛围压暗度"}</span>
                <span className="appearance-slider-val">
                  {`${appearance.wallpaperDim}%`}
                </span>
              </span>
              <Input
                aria-label="壁纸氛围压暗度"
                className="appearance-range"
                max={75}
                min={0}
                onChange={(e) => setWallpaperDim(Number(e.target.value))}
                step={1}
                style={rangeFillStyle(appearance.wallpaperDim, 0, 75)}
                type="range"
                value={appearance.wallpaperDim}
              />
            </label>
            <label className="appearance-slider-row">
              <span className="appearance-slider-label">
                <span>{"壁纸薄幕浓度"}</span>
                <span className="appearance-slider-val">
                  {`${appearance.wallpaperScrim}%`}
                </span>
              </span>
              <Input
                aria-label="壁纸薄幕浓度"
                className="appearance-range"
                max={100}
                min={0}
                onChange={(e) => setWallpaperScrim(Number(e.target.value))}
                step={1}
                style={rangeFillStyle(appearance.wallpaperScrim, 0, 100)}
                type="range"
                value={appearance.wallpaperScrim}
              />
            </label>
          </div>
        ) : null}
      </div>

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
