import {
  IconCheck,
  IconCloud,
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
  saveUploadedWallpaper,
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
  validateWallpaperFile,
} from "@/lib/appearance";
import { cn } from "@/lib/utils";

const GLASS_STYLE_OPTIONS: readonly { value: GlassStyleId; label: string }[] = [
  { value: "liquid", label: "液态玻璃" },
  { value: "crystal", label: "晶莹全透" },
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
    // 先校验类型和大小，超限的文件不读进内存
    const invalid = validateWallpaperFile(file);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await compressUploadedWallpaper(file);
      // 存进 IndexedDB 成功后才应用；保存失败会抛错，走下面的错误提示
      await saveUploadedWallpaper(dataUrl);
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
      {/* 1. 主题配色与动态天空场景（收束为精炼的 6 款配色 + 6 款天象） */}
      <div className="appearance-block" data-setting-item="主题配色">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">
              {"主题配色与动态天象"}
            </div>
            <div className="appearance-block-desc">
              {
                "精选 6 款高对比主题色与 Hark WebGL 动态天空；深色模式自动保障夜幕高对比度与文字清晰可读"
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

        <div
          aria-label="主题配色选择"
          className="appearance-palette-grid"
          role="radiogroup"
        >
          {THEME_PALETTES.map((item) => {
            const active = appearance.palette === item.id;
            return (
              // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 单选卡片，样式依赖 button 结构，原生 radio 换不了
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
                "液态玻璃（立体镜面高光折射）、晶莹全透（超薄水母级透明）、柔光磨砂（细腻雾面柔焦），均可透出底层流云与壁纸"
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
              <span>{"面板雾度（数值越小越通透）"}</span>
              <span className="appearance-slider-val">
                {`${appearance.glassOpacity}%（透光率 ${100 - appearance.glassOpacity}%）`}
              </span>
            </span>
            <Input
              aria-label="玻璃面板不透明度"
              className="appearance-range"
              max={45}
              min={5}
              onChange={(e) => setGlassOpacity(Number(e.target.value))}
              step={1}
              type="range"
              value={appearance.glassOpacity}
            />
          </label>
        </div>
      </div>

      {/* 3. 自定义图片壁纸上传 */}
      <div className="appearance-block" data-setting-item="背景壁纸">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">
              {"自定义图片壁纸"}
            </div>
            <div className="appearance-block-desc">
              {
                "上传本地图片作为工作台背景，透过半透明玻璃面板呈现专属壁纸景深"
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
                {"切回动态天空"}
              </Button>
            ) : null}
          </div>
        </div>

        {/* 本地图片拖拽 / 点击上传横幅 */}
        {/* biome-ignore lint/a11y/useSemanticElements: 拖放区里还嵌着按钮，外层不能是 <button>（按钮不能嵌套） */}
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
              {"支持 PNG / JPG / WebP / GIF / AVIF（不超过 20 MB），自动高清压缩并保存在当前设备"}
            </div>
          </div>
          <div className="appearance-upload-actions">
            <Button
              disabled={uploading}
              onClick={(e) => {
                // 别冒泡到拖放区，否则会再打开一次文件选择
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              <IconUpload className="size-3.5" />
              {hasCustomWallpaper ? "更换图片" : "选择图片上传"}
            </Button>
            {hasCustomWallpaper ? (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
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
