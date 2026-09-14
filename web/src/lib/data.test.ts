import assert from "node:assert/strict";
import test from "node:test";

import { parseIndex } from "./indexContract.ts";

const validIndex = {
  generated_at: "2026-09-13T20:45:07Z",
  record_count: 1,
  benchmarks: [{ id: "sdk-import-time", label: "Python import time", kind: "sdk" }],
  records: [{
    record_id: "a".repeat(64),
    comparison_id: "b".repeat(64),
    case_id: "c".repeat(64),
    benchmark_id: "sdk-import-time",
    benchmark_label: "Python import time",
    kind: "sdk",
    status: "ok",
    path: "results/record.json",
    metrics: [{
      id: "import.median",
      label: "Median fresh import",
      value: 42,
      unit: "ms",
      better: "lower",
    }],
    created_at: "2026-09-13T20:45:07Z",
    job: "base",
    canonical: true,
    version: "1.2.3",
    platform: "linux",
    architecture: "x86_64",
    source: {},
  }],
};

test("strictly decodes benchmark indexes", () => {
  assert.equal(parseIndex(validIndex).records[0]?.metrics[0]?.value, 42);
  assert.throws(() => parseIndex({ ...validIndex, unexpected: true }), /Invalid benchmark index/);
  assert.throws(() => parseIndex({ ...validIndex, record_count: 2 }), /record_count/);
});
