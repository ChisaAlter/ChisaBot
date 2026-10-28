import {
  IconCheck,
  IconDroplet,
  IconPhoto,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import React from "react";
import { useAppearanceState } from "@/components/sky-background";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import {
  compressUploadedWallpaper,
  type GlassStyleId,
  resetAppearanceDefaults,
  setCustomWallpaperUrl,
  setGlassOpacity,
  setGlassStyle,
  setThemePalette,
  setWallpaperBlur,
  setWallpaperDim,
  setWallpaperPreset,
  THEME_PALETTES,
  WALLPAPER_PRESETS,
} from "@/lib/appearance";

const GLASS_OPTIONS: ReadonlyArray<{
  id: GlassStyleId;
  label: string;
}> = [
  { id: "liquid", label: "液态玻璃" },
  { id: "crystal", label: "晶莹高透" },
  { id: "frosted", label: "经典磨砂" },
];

export function AppearancePreferences() {
  const {
    palette,
    glassStyle,
    glassOpacity,
    wallpaperId,
    customWallpaper,
    wallpaperBlur,
    wallpaperDim,
  } = useAppearanceState();

  const [urlInput, setUrlInput] = React.useState(() =>
    customWallpaper.startsWith("data:") ? "" : customWallpaper,
  );
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const glassKeys = useSegmentedKeys<GlassStyleId>({
    value: glassStyle,
    values: ["liquid", "crystal", "frosted"],
    onChange: (next) => setGlassStyle(next),
  });

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片格式文件（PNG、JPG、WebP 等）");
      return;
    }
    setUploading(true);
    try {
      const compressed = await compressUploadedWallpaper(file);
      setCustomWallpaperUrl(compressed);
      setUrlInput("");
      toast.success("已应用自定义壁纸");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "图片处理失败");
    } finally {
      setUploading(false);
    }
  };

  const handleApplyUrl = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      toast.error("请先输入有效的图片链接");
      return;
    }
    setCustomWallpaperUrl(trimmed);
    toast.success("已应用壁纸链接");
  };

  const hasCustomizations =
    palette !== "default" ||
    glassStyle !== "liquid" ||
    glassOpacity !== 16 ||
    wallpaperId !== "none" ||
    wallpaperBlur !== 0 ||
    wallpaperDim !== 12;

  return (
    <>
      <Separator />
      {/* 1. 面板玻璃质感：液态玻璃 / 晶莹高透 / 经典磨砂 */}
      <Item size="sm">
        <ItemContent>
          <ItemTitle>{"面板玻璃材质"}</ItemTitle>
          <ItemDescription>
            {
              "调整左栏、底栏输入框、对话气泡与右侧看板的液态玻璃高光折射与通透度。"
            }
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <div
            aria-label={"面板玻璃材质"}
            className="sg-segmented"
            {...glassKeys.groupProps}
            ref={glassKeys.groupRef}
            role="radiogroup"
          >
            {GLASS_OPTIONS.map((opt) => (
              // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 分段控件，遵循项目 segmented.tsx 规范
              <button
                aria-checked={glassStyle === opt.id}
                className="sg-segmented-item"
                key={opt.id}
                onClick={() => setGlassStyle(opt.id)}
                role="radio"
                tabIndex={glassKeys.itemTabIndex(opt.id)}
                type="button"
              >
                {opt.id === "liquid" ? (
                  <IconDroplet className="size-3.5" />
                ) : (
                  <IconSparkles className="size-3.5" />
                )}
                {opt.label}
              </button>
            ))}
          </div>
        </ItemActions>
      </Item>

      {glassStyle !== "frosted" && (
        <Item size="sm">
          <ItemContent>
            <ItemTitle>{"玻璃面板不透明度"}</ItemTitle>
            <ItemDescription>
              {"数值越低面板越清透（默认 16%，即 84% 透光率）。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <div className="flex items-center gap-3">
              <input
                aria-label={"玻璃面板不透明度"}
                className="sky-slider"
                max={80}
                min={5}
                onChange={(e) => setGlassOpacity(Number(e.target.value))}
                step={1}
                type="range"
                value={glassOpacity}
              />
              <span className="w-11 text-right text-xs tabular-nums text-[var(--ink-2)]">
                {`${glassOpacity}%`}
              </span>
            </div>
          </ItemActions>
        </Item>
      )}

      <Separator />
      {/* 2. 多款主题配色选择 */}
      <div className="appearance-block">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">{"主题配色"}</div>
            <div className="appearance-block-desc">
              {"提供 8 款精选主题色调，自动适配浅色与深色模式及液态玻璃光泽。"}
            </div>
          </div>
          {hasCustomizations && (
            <Button
              onClick={() => {
                resetAppearanceDefaults();
                setUrlInput("");
                toast.success("已恢复默认外观");
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              <IconRefresh className="size-3.5" />
              {"恢复默认"}
            </Button>
          )}
        </div>
        <div
          aria-label={"主题配色"}
          className="appearance-palette-grid"
          role="radiogroup"
        >
          {THEME_PALETTES.map((item) => {
            const active = palette === item.id;
            return (
              // biome-ignore lint/a11y/useSemanticElements: 自绘主题色卡单选网格
              <button
                aria-checked={active}
                className={`appearance-palette-card${active ? " is-active" : ""}`}
                key={item.id}
                onClick={() => setThemePalette(item.id)}
                role="radio"
                type="button"
              >
                <span
                  aria-hidden="true"
                  className="appearance-palette-swatch"
                  style={{ background: item.swatch }}
                >
                  {active && (
                    <span className="appearance-swatch-check">
                      <IconCheck className="size-3.5" />
                    </span>
                  )}
                </span>
                <span className="appearance-palette-info">
                  <span className="appearance-palette-name">{item.name}</span>
                  <span className="appearance-palette-sub">{item.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <Separator />
      {/* 3. 背景壁纸预设与自定义上传 */}
      <div className="appearance-block">
        <div className="appearance-block-head">
          <div>
            <div className="appearance-block-title">{"背景壁纸"}</div>
            <div className="appearance-block-desc">
              {
                "选择内置流光壁纸或上传自定义图片，让主界面各板块呈现通透的液态玻璃光影折射。"
              }
            </div>
          </div>
          <div className="appearance-block-actions">
            <input
              accept="image/*"
              aria-label={"选择本地壁纸图片"}
              className="hidden"
               onChange={handleUploadFile}
              ref={fileInputRef}
              type="file"
            />
            <Button
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconUpload className="size-3.5" />
              {uploading ? "处理中…" : "上传本地图片"}
            </Button>
            {wallpaperId !== "none" && (
              <Button
                onClick={() => {
                  setWallpaperPreset("none");
                  toast.success("已切换回默认天空背景");
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconTrash className="size-3.5" />
                {"清除壁纸"}
              </Button>
            )}
          </div>
        </div>

        <div
          aria-label={"背景壁纸"}
          className="appearance-wallpaper-grid"
          role="radiogroup"
        >
          {WALLPAPER_PRESETS.map((wp) => {
            const active = wallpaperId === wp.id;
            return (
              // biome-ignore lint/a11y/useSemanticElements: 自绘壁纸预设单选网格
              <button
                aria-checked={active}
                className={`appearance-wallpaper-card${active ? " is-active" : ""}`}
                key={wp.id}
                onClick={() => setWallpaperPreset(wp.id)}
                role="radio"
                type="button"
              >
                <span
                  aria-hidden="true"
                  className="appearance-wallpaper-thumb"
                  style={{ background: wp.preview }}
                >
                  <span className="appearance-wallpaper-glass-demo">
                    <i />
                    <i />
                  </span>
                  {active && (
                    <span className="appearance-swatch-check">
                      <IconCheck className="size-3.5" />
                    </span>
                  )}
                </span>
                <span className="appearance-wallpaper-meta">
                  <span className="appearance-palette-name">{wp.name}</span>
                  <span className="appearance-palette-sub">{wp.desc}</span>
                </span>
              </button>
            );
          })}

          {customWallpaper && (
            // biome-ignore lint/a11y/useSemanticElements: 自绘自定义壁纸单选卡片
            <button
              aria-checked={wallpaperId === "custom"}
              className={`appearance-wallpaper-card${wallpaperId === "custom" ? " is-active" : ""}`}
              onClick={() => setWallpaperPreset("custom")}
              role="radio"
              type="button"
            >
              <span
                aria-hidden="true"
                className="appearance-wallpaper-thumb"
                style={{
                  backgroundImage: `url("${customWallpaper.replace(/["\\]/g, "\\$&")}")`,
                  backgroundPosition: "center",
                  backgroundSize: "cover",
                }}
              >
                <span className="appearance-wallpaper-glass-demo">
                  <i />
                  <i />
                </span>
                {wallpaperId === "custom" && (
                  <span className="appearance-swatch-check">
                    <IconCheck className="size-3.5" />
                  </span>
                )}
              </span>
              <span className="appearance-wallpaper-meta">
                <span className="appearance-palette-name">{"自定义壁纸"}</span>
                <span className="appearance-palette-sub">
                  {customWallpaper.startsWith("data:")
                    ? "本地上传图片"
                    : "外部图片链接"}
                </span>
              </span>
            </button>
          )}
        </div>

        {/* 图片链接输入行 */}
        <div className="appearance-url-row">
          <div className="appearance-url-input-wrap">
            <IconPhoto className="appearance-url-icon size-4" />
            <Input
              aria-label={"自定义壁纸图片链接"}
              className="appearance-url-input"
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleApplyUrl();
                }
              }}
              placeholder={"粘贴壁纸图片链接（支持 https://…）"}
              value={urlInput}
            />
          </div>
          <Button
            disabled={!urlInput.trim()}
            onClick={handleApplyUrl}
            size="sm"
            type="button"
            variant="secondary"
          >
            {"应用链接"}
          </Button>
        </div>

        {/* 壁纸模糊度与暗化遮罩调节 */}
        {wallpaperId !== "none" && (
          <div className="appearance-sliders">
            <div className="appearance-slider-row">
              <div className="appearance-slider-label">
                <span>{"壁纸景深模糊"}</span>
                <span className="appearance-slider-val">{`${wallpaperBlur} 像素`}</span>
              </div>
              <input
                aria-label={"壁纸景深模糊"}
                className="sky-slider appearance-range"
                max={32}
                min={0}
                onChange={(e) => setWallpaperBlur(Number(e.target.value))}
                step={1}
                type="range"
                value={wallpaperBlur}
              />
            </div>
            <div className="appearance-slider-row">
              <div className="appearance-slider-label">
                <span>{"背景暗角遮罩"}</span>
                <span className="appearance-slider-val">{`${wallpaperDim}%`}</span>
              </div>
              <input
                aria-label={"背景暗角遮罩"}
                className="sky-slider appearance-range"
                max={75}
                min={0}
                onChange={(e) => setWallpaperDim(Number(e.target.value))}
                step={1}
                type="range"
                value={wallpaperDim}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
