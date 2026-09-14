import { expect, it } from "@effect/vitest";

import type { JsonRecord } from "./common.js";
import { canonicalIdentity, type ComparisonIdentityInput, identityDigest } from "./identity.js";

const input = (protocol: JsonRecord = {}): ComparisonIdentityInput => ({
  domain: "comparison",
  benchmark_id: "sdk-import-time",
  output_metrics: [],
  protocol,
  job: { id: "base", config: {}, requirements: null },
});

it("uses RFC 8785 primitive serialization and UTF-16 property order", () => {
  const canonical = canonicalIdentity(input({
    numbers: [333333333.33333329, 4.50, 2e-3, 1e-27],
    literals: [null, true, false],
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "😀": "Emoji",
    "\u0080": "Control",
    "ö": "Latin Small Letter O With Diaeresis",
  } as never));
  expect(canonical).toMatch(/"numbers":\[333333333\.3333333,4\.5,0\.002,1e-27\]/);
  expect(canonical.indexOf("\"\\r\"")).toBeLessThan(canonical.indexOf("\"1\""));
  expect(canonical.indexOf("\"ö\"")).toBeLessThan(canonical.indexOf("\"€\""));
  expect(canonical.indexOf("\"😀\"")).toBeLessThan(canonical.indexOf("\"דּ\""));
});

it("produces full lowercase SHA-256 and domain-separated identities", () => {
  const comparison = input();
  const digest = identityDigest(comparison);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(digest).toBe(identityDigest({ ...comparison }));
  expect(digest).not.toBe(
    identityDigest({
      ...comparison,
      domain: "case",
      target: { version: "1.0.0", artifact: {} },
    }),
  );
});

it("rejects precision-losing integer inputs", () => {
  expect(() => canonicalIdentity(input({ samples: 9_007_199_254_740_992 } as never))).toThrow(
    /unsafe integer/,
  );
  expect(() => canonicalIdentity(input({ samples: "9007199254740992" } as never))).not.toThrow();
});
