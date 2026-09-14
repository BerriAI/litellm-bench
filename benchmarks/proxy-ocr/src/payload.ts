import { crc32, deflateSync } from "node:zlib";

const pngChunk = (kind: string, data: Uint8Array): Buffer => {
  const type = Buffer.from(kind, "ascii");
  const payload = Buffer.from(data);
  const checksum = crc32(Buffer.concat([type, payload]));
  return Buffer.concat([
    Buffer.from([
      payload.byteLength >>> 24,
      payload.byteLength >>> 16,
      payload.byteLength >>> 8,
      payload.byteLength,
    ]),
    type,
    payload,
    Buffer.from([
      checksum >>> 24,
      checksum >>> 16,
      checksum >>> 8,
      checksum,
    ]),
  ]);
};

export const validPng = (minimumBytes: number): Buffer => {
  const width = 1_024;
  const rows = Math.max(1, Math.ceil(minimumBytes / (width * 3 + 1)));
  const scanline = Buffer.from([
    0,
    ...Array.from({ length: width * 3 }, (_, index) => (index * 31 + 17) % 256),
  ]);
  const pixels = Buffer.concat(Array.from({ length: rows }, () => scanline));
  const header = Buffer.from([
    width >>> 24,
    width >>> 16,
    width >>> 8,
    width,
    rows >>> 24,
    rows >>> 16,
    rows >>> 8,
    rows,
    8,
    2,
    0,
    0,
    0,
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

export const multipartBody = (
  payloadBytes: number,
): { readonly body: Buffer; readonly boundary: string; readonly document: Buffer } => {
  const boundary = "litellm-bench-ocr-boundary";
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n`
      + `mock-ocr\r\n--${boundary}\r\nContent-Disposition: form-data; `
      + "name=\"file\"; filename=\"payload.png\"\r\nContent-Type: image/png\r\n\r\n",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const document = validPng(payloadBytes);
  return { body: Buffer.concat([prefix, document, suffix]), boundary, document };
};
