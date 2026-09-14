import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { multipartBody, validPng } from "./payload.js";

const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

describe("OCR payload", () => {
  it.each([
    [1, 3_141, "1877be2ca8d779178fd72048dbca74ab721d0ed0385ec631e4becdca201a6883"],
    [1_048_576, 1_051_189, "100be45d5d53c466409e49d71addb887622f060dcabfca71f9a3c7f87e62f4ad"],
    [8_388_608, 8_390_633, "d2bbcd4e97004f6a4ed283a2d5ba55b03f44ef8cc9154fa91a7736085be7ebab"],
  ])("produces stable valid PNG bytes for %i", (minimum, bytes, sha256) => {
    const png = validPng(minimum);
    expect(png.byteLength).toBe(bytes);
    expect(digest(png)).toBe(sha256);
  });

  it("produces a stable canonical multipart body", () => {
    const { body, document } = multipartBody(1_048_576);
    expect(document.byteLength).toBe(1_051_189);
    expect(body.byteLength).toBe(1_051_437);
    expect(digest(body)).toBe("49231b50a307aedeb24413a56384c62fcbdb2c6a0fd2d855b35387a9d6624986");
  });
});
