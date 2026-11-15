/**
 * 读图片头里的宽高（DESIGN.md §83.2）。只看文件头，不解码像素；PNG / JPEG / GIF / WebP（本站接受的四种）。
 *
 * JPEG 的 EXIF 方向（5–8 = 转了 90°）会交换宽高：浏览器默认 `image-orientation: from-image`，画出来的是转正后的样子，
 * 留的框必须和画出来的一样，不然手机竖拍的照片照样会把下面的消息推开。
 *
 * 读不出来返回 null（截断的头、不认识的格式、宽高为 0 / 大得离谱）。
 */
export type ImageDims = { width: number; height: number };

const MAX_SIDE = 100_000;

function sane(width: number, height: number): ImageDims | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) return null;
  return { width, height };
}

const byte = (b: Uint8Array, i: number) => b[i] ?? 0;
const u16be = (b: Uint8Array, i: number) => (byte(b, i) << 8) | byte(b, i + 1);
const u16le = (b: Uint8Array, i: number) => byte(b, i) | (byte(b, i + 1) << 8);
const u24le = (b: Uint8Array, i: number) => byte(b, i) | (byte(b, i + 1) << 8) | (byte(b, i + 2) << 16);
const u32be = (b: Uint8Array, i: number) => ((byte(b, i) << 24) >>> 0) + ((byte(b, i + 1) << 16) | (byte(b, i + 2) << 8) | byte(b, i + 3));
const u32le = (b: Uint8Array, i: number) => (byte(b, i) | (byte(b, i + 1) << 8) | (byte(b, i + 2) << 16)) + byte(b, i + 3) * 0x1000000;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function png(b: Uint8Array): ImageDims | null {
  // 8 字节签名 + IHDR（长度 4 + "IHDR" 4 + 宽 4 + 高 4）
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return sane(u32be(b, 16), u32be(b, 20));
}

function gif(b: Uint8Array): ImageDims | null {
  if (b.length < 10) return null;
  return sane(u16le(b, 6), u16le(b, 8));
}

function webp(b: Uint8Array): ImageDims | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return sane(1 + u24le(b, 24), 1 + u24le(b, 27));
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const b0 = b[21];
    const b1 = b[22];
    const b2 = b[23];
    const b3 = b[24];
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return null;
    return sane(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
  }
  if (chunk === "VP8 ") {
    // 帧头：3 字节 + 起始码 9d 01 2a + 宽 / 高（各 14 位）
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sane(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  return null;
}

/** EXIF（APP1 "Exif\0\0" 之后的 TIFF）里的方向，没有就 1。 */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (end - start < 14 || ascii(b, start, 6) !== "Exif\0\0") return 1;
  const tiff = start + 6;
  const order = ascii(b, tiff, 2);
  if (order !== "II" && order !== "MM") return 1;
  const le = order === "II";
  const r16 = (i: number) => (le ? u16le(b, i) : u16be(b, i));
  const r32 = (i: number) => (le ? u32le(b, i) : u32be(b, i));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = r16(ifd);
  for (let n = 0; n < count; n += 1) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) break;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpeg(b: Uint8Array): ImageDims | null {
  let i = 2;
  let orientation = 1;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === undefined) return null;
    if (marker === 0xff) { i += 1; continue; } // 填充
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // 到了图像数据还没有 SOF
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    const body = i + 4;
    if (marker === 0xe1) orientation = exifOrientation(b, body, Math.min(b.length, i + 2 + length));
    // SOF0–SOF15，C4（DHT）、C8（JPG）、CC（DAC）不是
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (body + 5 > b.length) return null;
      const height = u16be(b, body + 1);
      const width = u16be(b, body + 3);
      return orientation >= 5 ? sane(height, width) : sane(width, height);
    }
    i += 2 + length;
  }
  return null;
}

export function imageSize(bytes: Uint8Array): ImageDims | null {
  const b = bytes;
  if (b.length < 10) return null;
  try {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return png(b);
    if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
    if (ascii(b, 0, 4) === "GIF8") return gif(b);
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webp(b);
  } catch {
    return null;
  }
  return null;
}
