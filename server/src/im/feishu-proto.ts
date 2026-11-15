/**
 * 飞书长连接的帧（pbbp2.Frame），手写的最小 protobuf 编解码。
 *
 * 字段号照飞书官方 Node SDK（MIT，github.com/larksuite/node-sdk ws-client/proto-buf/pbbp2.js）：
 *   Header { key = 1 (string), value = 2 (string) }
 *   Frame  { SeqID = 1 (uint64), LogID = 2 (uint64), service = 3 (int32), method = 4 (int32),
 *            headers = 5 (repeated Header), payloadEncoding = 6, payloadType = 7 (string),
 *            payload = 8 (bytes), LogIDNew = 9 (string) }
 * 只为这一种消息写，省得为它拉一个 protobuf 依赖。
 */

export type FeishuHeader = { key: string; value: string };
export type FeishuFrame = {
  SeqID: bigint;
  LogID: bigint;
  service: number;
  method: number;
  headers: FeishuHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  LogIDNew?: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Writer {
  private bytes: number[] = [];
  varint(value: bigint | number) {
    let v = BigInt.asUintN(64, BigInt(value));
    while (v > 0x7fn) {
      this.bytes.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.bytes.push(Number(v));
  }
  tag(field: number, wire: number) {
    this.varint((field << 3) | wire);
  }
  raw(data: Uint8Array) {
    this.varint(data.length);
    for (const byte of data) this.bytes.push(byte);
  }
  finish() {
    return new Uint8Array(this.bytes);
  }
}

export function encodeFrame(frame: FeishuFrame): Uint8Array {
  const w = new Writer();
  w.tag(1, 0);
  w.varint(frame.SeqID);
  w.tag(2, 0);
  w.varint(frame.LogID);
  w.tag(3, 0);
  w.varint(BigInt.asUintN(64, BigInt(frame.service)));
  w.tag(4, 0);
  w.varint(BigInt.asUintN(64, BigInt(frame.method)));
  for (const header of frame.headers) {
    const h = new Writer();
    h.tag(1, 2);
    h.raw(encoder.encode(header.key));
    h.tag(2, 2);
    h.raw(encoder.encode(header.value));
    w.tag(5, 2);
    w.raw(h.finish());
  }
  if (frame.payloadEncoding != null) {
    w.tag(6, 2);
    w.raw(encoder.encode(frame.payloadEncoding));
  }
  if (frame.payloadType != null) {
    w.tag(7, 2);
    w.raw(encoder.encode(frame.payloadType));
  }
  if (frame.payload != null) {
    w.tag(8, 2);
    w.raw(frame.payload);
  }
  if (frame.LogIDNew != null) {
    w.tag(9, 2);
    w.raw(encoder.encode(frame.LogIDNew));
  }
  return w.finish();
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done() {
    return this.pos >= this.buf.length;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.buf[this.pos];
      if (byte === undefined) throw new Error("飞书帧被截断");
      this.pos += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("飞书帧的整数太长");
    }
  }
  bytes(): Uint8Array {
    const length = Number(this.varint());
    const end = this.pos + length;
    if (end > this.buf.length) throw new Error("飞书帧被截断");
    const out = this.buf.subarray(this.pos, end);
    this.pos = end;
    return out;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 2) this.bytes();
    else if (wire === 1) this.pos += 8;
    else if (wire === 5) this.pos += 4;
    else throw new Error(`飞书帧里有不认识的类型 ${wire}`);
  }
}

const int32 = (value: bigint) => Number(BigInt.asIntN(32, value));

function decodeHeader(buf: Uint8Array): FeishuHeader {
  const r = new Reader(buf);
  const header: FeishuHeader = { key: "", value: "" };
  while (!r.done) {
    const tag = Number(r.varint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) header.key = decoder.decode(r.bytes());
    else if (field === 2 && wire === 2) header.value = decoder.decode(r.bytes());
    else r.skip(wire);
  }
  return header;
}

export function decodeFrame(buf: Uint8Array): FeishuFrame {
  const r = new Reader(buf);
  const frame: FeishuFrame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [] };
  while (!r.done) {
    const tag = Number(r.varint());
    const field = tag >> 3;
    const wire = tag & 7;
    switch (field) {
      case 1: frame.SeqID = r.varint(); break;
      case 2: frame.LogID = r.varint(); break;
      case 3: frame.service = int32(r.varint()); break;
      case 4: frame.method = int32(r.varint()); break;
      case 5: frame.headers.push(decodeHeader(r.bytes())); break;
      case 6: frame.payloadEncoding = decoder.decode(r.bytes()); break;
      case 7: frame.payloadType = decoder.decode(r.bytes()); break;
      case 8: frame.payload = r.bytes().slice(); break;
      case 9: frame.LogIDNew = decoder.decode(r.bytes()); break;
      default: r.skip(wire);
    }
  }
  return frame;
}

export function headerOf(frame: FeishuFrame, key: string): string | undefined {
  return frame.headers.find((header) => header.key === key)?.value;
}
