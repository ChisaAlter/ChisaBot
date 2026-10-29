/**
 * 壁纸压缩 Worker（模块 11 第 11 条）：解码、缩放、编码、转 Data URL 都在这里做，主线程只收结果。
 * 逻辑在 `wallpaper-compress.ts`，这里只是消息入口。
 */
import {
  compressBitmapToBlob,
  pickWallpaperBlob,
  type WallpaperCompressRequest,
  type WallpaperCompressResponse,
} from "./wallpaper-compress";

/** Worker 全局里有、DOM lib 里没有的那几样。 */
type WorkerScope = {
  onmessage: ((event: MessageEvent<WallpaperCompressRequest>) => void) | null;
  postMessage(message: WallpaperCompressResponse): void;
  FileReaderSync?: new () => { readAsDataURL(blob: Blob): string };
};
const scope = self as unknown as WorkerScope;

async function toDataUrl(blob: Blob): Promise<string> {
  if (scope.FileReaderSync)
    return new scope.FileReaderSync().readAsDataURL(blob);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

scope.onmessage = async (event) => {
  const { file, maxSide } = event.data;
  try {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      scope.postMessage({ ok: false, error: "无法解析该图片格式" });
      return;
    }
    const encoded = await compressBitmapToBlob(bitmap, maxSide);
    if (!encoded) {
      scope.postMessage({ ok: false, error: "OffscreenCanvas 2D 不可用" });
      return;
    }
    const blob = await pickWallpaperBlob(encoded);
    scope.postMessage({
      ok: true,
      dataUrl: await toDataUrl(blob),
      width: encoded.width,
      height: encoded.height,
    });
  } catch (error) {
    scope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
