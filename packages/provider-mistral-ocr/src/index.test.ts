import { decodeProviderRouteManifest, decodeUpstreamFixture } from "@litellm-bench/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalMistralOcr,
  canonicalMistralOcrFixturePath,
  mistralOcrFixture,
  mistralOcrManifest,
} from "./index.js";

describe("Mistral OCR provider contract", () => {
  it("keeps the canonical fixture equivalent to its synthetic source", () => {
    const fixture = JSON.parse(readFileSync(canonicalMistralOcrFixturePath, "utf8"));
    expect(decodeUpstreamFixture(fixture)).toEqual(
      mistralOcrFixture({
        id: "ocr",
        ...canonicalMistralOcr,
        timing: { responseDelayMs: 0 },
      }).operations,
    );
  });

  it("declares route and fixture provenance", () => {
    expect(decodeProviderRouteManifest(mistralOcrManifest).route).toBe("/v1/ocr");
  });
});
