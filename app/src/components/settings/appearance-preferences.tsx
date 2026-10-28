import {
  IconCheck,
  IconCloud,
  IconPhoto,
  IconRefresh,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import {
  compressUploadedWallpaper,
  type GlassStyleId,
  HARK_SKY_SCENES,
  type HarkSkySceneId,
  resetAppearanceDefaults,
  setCustomWallpaperUrl,
  setGlassOpacity,
  setGlassStyle,
  setHarkSkyScene,
  setThemePalette,
  setWallpaperBlur,
  setWallpaperDim,
  setWallpaperPreset,
  THEME_PALETTES,
  useAppearance,
  WALLPAPER_PRESETS,
} from "@/lib/appearance";
import { cn } from "@/lib/utils";

const GLASS_STYLE_OPTIONS: readonly { value: GlassStyleId; label: string }[] = [
  { value: "liquid", label: "Hark 原生玻璃" },
  { value: "crystal", label: "晶莹高透" },
  { value: "frosted", label: "柔光磨砂" },
];
const GLASS_STYLE_VALUES: readonly GlassStyleId[] = [
  "liquid",
  "crystal",
  "frosted",
];

export function AppearancePreferences() {
  const appearance = useAppearance();
  const glassKeys = useSegmentedKeys<GlassStyleId>({
    value: appearance.glassStyle,
    values: GLASS_STYLE_VALUES,
    onChange: (next) => setGlassStyle(next),
  });
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const hasCustomWallpaper =
    appearance.wallpaperId === "custom" &&
    Boolean(appearance.customWallpaperUrl);

  const processWallpaperFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片格式文件（PNG / JPG / WebP / GIF / AVIF）");
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await compressUploadedWallpaper(file);
      setCustomWallpaperUrl(dataUrl);
      toast.success("已上传并应用自定义背景壁纸");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传壁纸失败");
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await processWallpaperFile(file);
  };

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    await processWallpaperFile(file);
  };

  return (
    <>
      {/* 1. Hark 动态天空场景（WebGL 实时大气散射与流云引擎） */}
      <div className="appearance-block" data-setting-item="动态天空与气象场景">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">
              {"Hark 动态天空与气象场景"}
            </div>
            <div className="appearance-block-desc">
              {
                "基于 Hark WebGL 大气瑞利散射、体积云与太阳轨迹着色器，透过半透明玻璃面板实时呈现全球地标天色"
              }
            </div>
          </div>
          {appearance.harkScene !== "auto" ||
          appearance.palette !== "default" ||
          appearance.wallpaperId !== "none" ||
          appearance.glassStyle !== "liquid" ||
          appearance.glassOpacity !== 16 ? (
            <Button
              onClick={() => {
                resetAppearanceDefaults();
                toast.success("已恢复 Hark 默认外观");
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

        <div
          aria-label="Hark 动态天空场景选择"
          className="appearance-wallpaper-grid"
          role="radiogroup"
        >
          {HARK_SKY_SCENES.map((scene) => {
            const active =
              appearance.wallpaperId === "none" &&
              appearance.harkScene === scene.id;
            return (
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

      {/* 2. 玻璃面板材质与透光率控制 */}
      <div className="appearance-block" data-setting-item="玻璃面板质感">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">
              {"Hark 玻璃材质与透光率"}
            </div>
            <div className="appearance-block-desc">
              {
                "采用 Hark 原生 50px 高斯光学模糊与图层混合（color-dodge / plus-lighter / soft-light），可自由调节面板半透明透光率"
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
              <span>{"玻璃面板不透明度（数值越小越通透）"}</span>
              <span className="appearance-slider-val">
                {`${appearance.glassOpacity}%（透光率 ${100 - appearance.glassOpacity}%）`}
              </span>
            </span>
            <Input
              aria-label="玻璃面板不透明度"
              className="appearance-range"
              max={55}
              min={8}
              onChange={(e) => setGlassOpacity(Number(e.target.value))}
              step={1}
              type="range"
              value={appearance.glassOpacity}
            />
          </label>
        </div>
      </div>

      {/* 3. 多款主题配色网格 */}
      <div className="appearance-block" data-setting-item="主题配色">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">{"主题强调色方案"}</div>
            <div className="appearance-block-desc">
              {
                "切换全局交互强调色；当动态天空处于「智能跟随主题」时，会自动联动对应的地标天象"
              }
            </div>
          </div>
        </div>

        <div
          aria-label="主题配色选择"
          className="appearance-palette-grid"
          role="radiogroup"
        >
          {THEME_PALETTES.map((item) => {
            const active = appearance.palette === item.id;
            return (
              <button
                aria-checked={active}
                className={cn("appearance-palette-card", active && "is-active")}
                data-testid={`palette-option-${item.id}`}
                key={item.id}
                onClick={() => setThemePalette(item.id)}
                role="radio"
                type="button"
              >
                <span
                  aria-hidden="true"
                  className="appearance-palette-swatch"
                  style={{ background: item.swatchGradient }}
                >
                  {active ? (
                    <span className="appearance-swatch-check">
                      <IconCheck className="size-3.5 stroke-[2.6]" />
                    </span>
                  ) : null}
                </span>
                <span className="appearance-palette-info">
                  <span className="appearance-palette-name">{item.name}</span>
                  <span className="appearance-palette-sub">
                    {item.subtitle}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 4. 静态艺术壁纸与自定义图片上传 */}
      <div className="appearance-block" data-setting-item="背景壁纸">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">
              {"自定义图片壁纸（可选覆盖动态天空）"}
            </div>
            <div className="appearance-block-desc">
              {
                "默认使用上方 Hark WebGL 动态天空；也可在此选择静态艺术壁纸或上传本地高清图片"
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
            <Button
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              size="sm"
              type="button"
              variant="secondary"
            >
              <IconUpload className="size-3.5" />
              {uploading ? "正在处理…" : "上传本地图片"}
            </Button>
            {appearance.wallpaperId !== "none" ? (
              <Button
                onClick={() => {
                  setWallpaperPreset("none");
                  setCustomWallpaperUrl("");
                  toast.success("已切回 Hark 动态天空");
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconCloud className="size-3.5" />
                {"使用动态天空"}
              </Button>
            ) : null}
          </div>
        </div>

        {/* 本地图片拖拽 / 点击上传横幅 */}
        <div
          className={cn(
            "appearance-upload-dropzone",
            dragOver && "is-dragover",
            hasCustomWallpaper && "has-custom",
          )}
          data-testid="wallpaper-upload-dropzone"
          onClick={() => fileInputRef.current?.click()}
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
              fileInputRef.current?.click();
            }
          }}
          role="button"
          tabIndex={0}
        >
          {hasCustomWallpaper ? (
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
              {uploading
                ? "正在处理并压缩壁纸图片…"
                : hasCustomWallpaper
                  ? "已启用本地自定义壁纸（点击或拖拽新图片即可更换）"
                  : "点击选择本地图片，或直接将壁纸拖拽到此处上传"}
            </div>
            <div className="appearance-upload-sub">
              {"支持 PNG / JPG / WebP / GIF / AVIF，自动高清压缩并保存在当前设备"}
            </div>
          </div>
          <div
            className="appearance-upload-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              size="sm"
              type="button"
              variant="secondary"
            >
              <IconUpload className="size-3.5" />
              {hasCustomWallpaper ? "更换图片" : "选择图片上传"}
            </Button>
            {hasCustomWallpaper ? (
              <Button
                onClick={() => {
                  setWallpaperPreset("none");
                  setCustomWallpaperUrl("");
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

        <div
          aria-label="预设壁纸选择"
          className="appearance-wallpaper-grid"
          role="radiogroup"
        >
          {WALLPAPER_PRESETS.map((wp) => {
            const active = appearance.wallpaperId === wp.id;
            return (
              <button
                aria-checked={active}
                className={cn(
                  "appearance-wallpaper-card",
                  active && "is-active",
                )}
                data-testid={`wallpaper-option-${wp.id}`}
                key={wp.id}
                onClick={() => setWallpaperPreset(wp.id)}
                role="radio"
                type="button"
              >
                <div
                  className="appearance-wallpaper-thumb"
                  style={{ background: wp.previewBackground }}
                >
                  <div className="appearance-wallpaper-glass-demo">
                    <i />
                    <i />
                  </div>
                  {active ? (
                    <span className="appearance-swatch-check">
                      <IconCheck className="size-3.5 stroke-[2.6]" />
                    </span>
                  ) : null}
                </div>
                <div className="appearance-wallpaper-meta">
                  <span className="appearance-palette-name">{wp.name}</span>
                  <span className="appearance-palette-sub">{wp.subtitle}</span>
                </div>
              </button>
            );
          })}

          {hasCustomWallpaper ? (
            <button
              aria-checked={true}
              className="appearance-wallpaper-card is-active"
              data-testid="wallpaper-option-custom"
              onClick={() => fileInputRef.current?.click()}
              role="radio"
              type="button"
            >
              <div
                className="appearance-wallpaper-thumb"
                style={{
                  backgroundImage: `url("${appearance.customWallpaperUrl}")`,
                  backgroundPosition: "center",
                  backgroundSize: "cover",
                }}
              >
                <div className="appearance-wallpaper-glass-demo">
                  <i />
                  <i />
                </div>
                <span className="appearance-swatch-check">
                  <IconCheck className="size-3.5 stroke-[2.6]" />
                </span>
              </div>
              <div className="appearance-wallpaper-meta">
                <span className="appearance-palette-name">
                  <IconPhoto className="mr-1 inline size-3.5" />
                  {"本地自定义壁纸"}
                </span>
                <span className="appearance-palette-sub">
                  {"点击可重新上传"}
                </span>
              </div>
            </button>
          ) : (
            <button
              aria-checked={false}
              className="appearance-wallpaper-card is-upload-card"
              data-testid="wallpaper-option-upload"
              onClick={() => fileInputRef.current?.click()}
              role="radio"
              type="button"
            >
              <div className="appearance-wallpaper-thumb appearance-wallpaper-upload-thumb">
                <IconUpload className="size-5 opacity-75" />
              </div>
              <div className="appearance-wallpaper-meta">
                <span className="appearance-palette-name">
                  {"上传本地壁纸"}
                </span>
                <span className="appearance-palette-sub">
                  {"从电脑选择图片"}
                </span>
              </div>
            </button>
          )}
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
                type="range"
                value={appearance.wallpaperDim}
              />
            </label>
          </div>
        ) : null}
      </div>
    </>
  );
}

export { AppearancePreferences as AppearancePreferencesSection };
