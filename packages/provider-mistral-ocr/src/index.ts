import type {
  MockOperation,
  ProviderRouteManifest,
  UpstreamFixture,
} from "@litellm-bench/contracts";
import { fileURLToPath } from "node:url";

export interface MistralOcrOptions {
  readonly id: string;
  readonly model: string;
  readonly markdown: string;
  readonly timing: { readonly responseDelayMs: number };
}

/** A synthetic Mistral OCR /v1/ocr exchange in the shared replay format. */
export const mistralOcr = (options: MistralOcrOptions): MockOperation => ({
  id: options.id,
  operation: "ocr",
  method: "POST",
  path: "/v1/ocr",
  expect: { model: options.model, document: { type: "image_url" } },
  png_fields: ["document.image_url"],
  body_match: "exact",
  response: {
    kind: "json",
    timing: { response_delay_ms: options.timing.responseDelayMs },
    body: {
      model: options.model,
      pages: [{ index: 0, markdown: options.markdown, images: [] }],
      usage_info: { pages_processed: 1 },
    },
  },
});

export const mistralOcrFixture = (options: MistralOcrOptions): UpstreamFixture => ({
  version: 2,
  operations: [mistralOcr(options)],
});

/** Canonical fixture used by the benchmark and replayed by the mock-provider app. */
export const canonicalMistralOcrFixturePath = fileURLToPath(
  import.meta.resolve("@litellm-bench/provider-mistral-ocr/fixture"),
);

export const canonicalMistralOcr = {
  model: "mistral-ocr-latest",
  markdown: "mock OCR response",
} as const;

export const mistralOcrManifest = {
  version: 1,
  provider: "mistral",
  route: "/v1/ocr",
  fixtures: [{
    id: "canonical",
    export: "./fixture",
    purpose: "capacity",
    modes: ["json"],
    provenance: { source: "synthetic", generator: "scripts/generate-fixtures.mjs" },
  }],
} as const satisfies ProviderRouteManifest;
