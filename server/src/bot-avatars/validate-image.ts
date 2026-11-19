/**
 * 头像图片二进制防像素炸弹校验（纯二进制解析，零外部原生依赖）。
 *
 * 严格核对 PNG（IHDR）、JPEG（SOF0–SOF15）、WebP（VP8 / VP8L / VP8X）真实魔数与像素尺寸：
 * - 拒绝伪造扩展名、未知魔数（如 SVG / HTML / ZIP）；
 * - 拒绝截断或损坏的文件头；
 * - 拒绝单边超过 8192 或总像素超过 33,554,432（防解压像素炸弹导致客户端/服务端内存飙升）。
 */

import type { AvatarMime } from "../../../shared/bot-avatars";

export const MAX_AVATAR_IMAGE_DIMENSION = 8192;
export const MAX_AVATAR_IMAGE_PIXELS = 33_554_432;

export type ValidatedAvatarImage = {
  mime: AvatarMime;
  width: number;
  height: number;
  pixels: number;
};

export type AvatarImageValidationErrorCode =
  | "empty"
  | "unsupported-format"
  | "truncated"
  | "invalid-dimensions"
  | "pixel-bomb";

export type AvatarImageValidationResult =
  | { ok: true; image: ValidatedAvatarImage }
  | { ok: false; code: AvatarImageValidationErrorCode; reason: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return out;
}

function finalizeDimensions(
  mime: AvatarMime,
  width: number,
  height: number,
): AvatarImageValidationResult {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return {
      ok: false,
      code: "invalid-dimensions",
      reason: "图片尺寸无效（宽或高为 0）。",
    };
  }
  const pixels = width * height;
  if (
    width > MAX_AVATAR_IMAGE_DIMENSION ||
    height > MAX_AVATAR_IMAGE_DIMENSION ||
    pixels > MAX_AVATAR_IMAGE_PIXELS
  ) {
    return {
      ok: false,
      code: "pixel-bomb",
      reason: `图片分辨率过大（${width}×${height}），单边上限 ${MAX_AVATAR_IMAGE_DIMENSION} 且总像素上限 ${MAX_AVATAR_IMAGE_PIXELS.toLocaleString("en-US")}。`,
    };
  }
  return { ok: true, image: { mime, width, height, pixels } };
}

function parsePng(bytes: Uint8Array): AvatarImageValidationResult {
  if (bytes.length < 24) {
    return {
      ok: false,
      code: "truncated",
      reason: "PNG 图片头不完整或已截断。",
    };
  }
  const ihdrLength = readUint32BE(bytes, 8);
  const chunkType = asciiAt(bytes, 12, 4);
  if (chunkType !== "IHDR" || ihdrLength < 13) {
    return {
      ok: false,
      code: "truncated",
      reason: "PNG 缺少有效的 IHDR 文件头。",
    };
  }
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  return finalizeDimensions("image/png", width, height);
}

/** JPEG SOF0–SOF15（排除 0xC4 DHT、0xC8 保留扩展、0xCC DAC）。 */
function isJpegSofMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function parseJpeg(bytes: Uint8Array): AvatarImageValidationResult {
  if (bytes.length < 4) {
    return {
      ok: false,
      code: "truncated",
      reason: "JPEG 图片头不完整或已截断。",
    };
  }
  let offset = 2;
  while (offset < bytes.length) {
    // JPEG marker 以 0xFF 开头，允许连续 0xFF 填充。
    if (bytes[offset] !== 0xff) {
      return {
        ok: false,
        code: "truncated",
        reason: "JPEG 帧结构异常，无法解析分辨率。",
      };
    }
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) break;
    const marker = bytes[offset] ?? 0;
    offset += 1;

    // 独立无负载标记（SOI/TEM/RST0-7）
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd8)
    ) {
      continue;
    }
    // EOI / SOS：进入压缩扫描或结束，前面还没遇到 SOF 则视为截断/损坏
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (offset + 2 > bytes.length) {
      return {
        ok: false,
        code: "truncated",
        reason: "JPEG 段长度被截断。",
      };
    }
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return {
        ok: false,
        code: "truncated",
        reason: "JPEG 段数据不完整或超出文件边界。",
      };
    }

    if (isJpegSofMarker(marker)) {
      if (segmentLength < 7 || offset + 7 > bytes.length) {
        return {
          ok: false,
          code: "truncated",
          reason: "JPEG SOF 帧头被截断。",
        };
      }
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      return finalizeDimensions("image/jpeg", width, height);
    }

    offset += segmentLength;
  }

  return {
    ok: false,
    code: "truncated",
    reason: "JPEG 缺少有效的 SOF 帧头或数据被截断。",
  };
}

function parseWebp(bytes: Uint8Array): AvatarImageValidationResult {
  if (bytes.length < 20) {
    return {
      ok: false,
      code: "truncated",
      reason: "WebP 图片头不完整或已截断。",
    };
  }
  const chunk = asciiAt(bytes, 12, 4);
  if (chunk === "VP8 ") {
    if (bytes.length < 30) {
      return {
        ok: false,
        code: "truncated",
        reason: "WebP (VP8) 关键帧头被截断。",
      };
    }
    // VP8 关键帧起始码：0x9D 0x01 0x2A
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return {
        ok: false,
        code: "truncated",
        reason: "WebP (VP8) 同步码异常。",
      };
    }
    const width = readUint16LE(bytes, 26) & 0x3fff;
    const height = readUint16LE(bytes, 28) & 0x3fff;
    return finalizeDimensions("image/webp", width, height);
  }

  if (chunk === "VP8L") {
    if (bytes.length < 25) {
      return {
        ok: false,
        code: "truncated",
        reason: "WebP (VP8L) 帧头被截断。",
      };
    }
    if (bytes[20] !== 0x2f) {
      return {
        ok: false,
        code: "truncated",
        reason: "WebP (VP8L) 签名无效。",
      };
    }
    const bits = readUint32LE(bytes, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return finalizeDimensions("image/webp", width, height);
  }

  if (chunk === "VP8X") {
    if (bytes.length < 30) {
      return {
        ok: false,
        code: "truncated",
        reason: "WebP (VP8X) 扩展头被截断。",
      };
    }
    const width = readUint24LE(bytes, 24) + 1;
    const height = readUint24LE(bytes, 27) + 1;
    return finalizeDimensions("image/webp", width, height);
  }

  return {
    ok: false,
    code: "truncated",
    reason: "WebP 缺少受支持的 VP8/VP8L/VP8X 图像块。",
  };
}

/**
 * 纯二进制校验头像图片：识别真实魔数（PNG/JPEG/WebP），解析真实像素宽高并拦截像素炸弹。
 */
export function validateAvatarImage(
  bytes: Uint8Array,
): AvatarImageValidationResult {
  if (bytes.length === 0) {
    return { ok: false, code: "empty", reason: "没有收到图片。" };
  }

  // PNG：8 字节完整魔数
  if (
    bytes.length >= 8 &&
    PNG_SIGNATURE.every((expected, index) => bytes[index] === expected)
  ) {
    return parsePng(bytes);
  }

  // JPEG：FF D8 FF
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return parseJpeg(bytes);
  }

  // WebP：RIFF....WEBP
  if (
    bytes.length >= 12 &&
    asciiAt(bytes, 0, 4) === "RIFF" &&
    asciiAt(bytes, 8, 4) === "WEBP"
  ) {
    return parseWebp(bytes);
  }

  return {
    ok: false,
    code: "unsupported-format",
    reason: "只支持有效的 PNG、JPEG 或 WebP 图片。",
  };
}
